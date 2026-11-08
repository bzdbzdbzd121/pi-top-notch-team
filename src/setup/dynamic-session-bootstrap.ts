import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../session/context";
import type { SessionOrigin } from "../session/state";
import { getSessionState, startSession, addMemberToSession } from "../session/state";
import { ensureSharedContextFile } from "../session/shared-context";
import { setManifestRuntimeContext, syncActiveManifest } from "../session/manifest";
import { getRootDir } from "../config";
import type { TeamDefinition, TeamMember } from "../team/definition";
import { listTeams } from "../team/store";
import { normalizeTeamName, isSyntheticTeamName } from "../team/team-name";
import { ensureToolRegistered } from "../commands/shared/ensure-tool";
import { STOP_TEAM_SESSION_TOOL_NAME } from "../tools/agent-session-tool-names";
import { SET_TEAM_NAME_TOOL_NAME } from "../tools/team-name-tool-names";
import { ensureSetTeamNameTool } from "../tools/team-name-tool";
import { SESSION_ENTRY_NOTICE_MAX_TURNS } from "../prompts/session-transition-notice";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Register the add_dynamic_member tool on-demand (dynamic sessions only).
 * Extracted from dynamic-handler so both /team dynamic and the
 * start_team_session tool (ADR-0003) share one registration.
 */
export function ensureAddDynamicMemberTool(pi: ExtensionAPI, teamCtx: TeamContext): void {
  ensureToolRegistered(pi, "add_dynamic_member", () => {
    pi.registerTool({
      name: "add_dynamic_member",
      label: "Add Dynamic Member",
      description:
        "Add a member to the dynamic team session. Only available in dynamic team sessions (/team dynamic or agent-initiated). " +
        "Each call adds one member to the in-memory team definition so start_member can launch it later. " +
        "Parameters: name (identifier), label (Chinese display name), systemPrompt (role definition), model (optional).",
      promptGuidelines: [
        "Use add_dynamic_member to register a team member after discussing the role with the user (or after designing the team autonomously in an agent-initiated session).",
        "若团队还没有名字（仍是系统默认名），在注册成员之前先用 set_team_name 起一个可识别的名字——成员启动后不能再改名；命名是建议，不是开工条件。",
        "Call once per member role. After all members are added, call write_shared_context to write the shared context, then start members with start_member (blocked until the shared context is written).",
      ],
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Member identifier (lowercase, e.g. 'coder', 'reviewer')" },
          label: { type: "string", description: "Human-readable display name in Chinese (e.g. '编码员')" },
          systemPrompt: { type: "string", description: "System prompt defining this member's role, skills, and behavior" },
          model: { type: "string", description: "Optional model override (e.g. 'anthropic/claude-sonnet-4')" },
        },
        required: ["name", "label", "systemPrompt"],
      },
      async execute(
        _toolCallId: string,
        params: { name: string; label: string; systemPrompt: string; model?: string }
      ) {
        const member: TeamMember = {
          name: params.name,
          label: params.label,
          systemPrompt: params.systemPrompt,
          model: params.model,
        };

        try {
          // One-time naming reminder: only dynamic sessions, only while the team
          // still carries the synthetic fallback name, and only for the FIRST
          // member (members are never removed, so this fires at most once).
          const before = getSessionState();
          const firstMember = (before.teamDefinition?.members.length ?? 0) === 0;
          const unnamed = before.teamDefinition
            ? isSyntheticTeamName(before.teamDefinition.name)
            : false;

          addMemberToSession(member);
          // Persist the updated roster — for dynamic teams this manifest is the
          // ONLY durable copy of the member definitions (no YAML on disk).
          syncActiveManifest();
          const session = getSessionState();
          if (session.teamDefinition) {
            teamCtx.router!.updateMembers(session.teamDefinition.members.map((m) => m.name));
          }
          const namingHint =
            firstMember && unnamed && teamCtx.isDynamicSession
              ? "\n💡 团队名仍是系统默认名：建议在启动成员前调用 set_team_name 给团队起一个可识别的名字（成员启动后不能再改名）。"
              : "";
          return {
            details: {},
            content: [{ type: "text" as const, text: `成员「${params.label}（${params.name}）」已添加到动态团队。使用 start_member ${params.name} 启动。${namingHint}` }],
          };
        } catch (err) {
          return {
            details: {},
            content: [{ type: "text" as const, text: `添加成员失败：${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      },
    });
  });
}

/**
 * Shared dynamic-session bootstrap behind `/team dynamic` (origin "user") and
 * the `start_team_session` tool (origin "agent", ADR-0003).
 *
 * Creates the session directory, starts the session (with origin), writes the
 * shared-context stub, flips teamCtx into dynamic design phase, registers
 * add_dynamic_member, fires onSessionStart (widget + session-tool
 * registration) and activates the session tool set — plus stop_team_session
 * for agent-initiated sessions.
 *
 * Caller is responsible for: the "already active" guard, origin-specific
 * extras (goal seeding / task storage / notifications).
 */
export interface DynamicSessionBootstrapOptions {
  /**
   * Requested team name (agent entry only; /team dynamic takes no name
   * argument). An invalid or already-taken name NEVER blocks the session —
   * the system fallback `_dynamic_<ts>` is used and `nameIssue` explains why.
   */
  teamName?: string;
}

export interface DynamicSessionBootstrapResult {
  /** Final team name: the requested one, or the synthetic fallback. */
  teamName: string;
  /** True when the system fallback name was used (unnamed session). */
  autoGenerated: boolean;
  /** Why the requested name was not used (invalid / taken). Absent otherwise. */
  nameIssue?: string;
}

/** Raw input echoed in messages must never create extra lines. */
function displayName(raw: string): string {
  return raw.replace(/[\r\n\t]/g, " ");
}

/**
 * Resolve the bootstrap team name: requested (validated + collision-checked)
 * or the synthetic fallback. Never throws, never blocks the session.
 */
function resolveBootstrapTeamName(requested: unknown): DynamicSessionBootstrapResult {
  const fallback = `_dynamic_${Date.now()}`;
  if (typeof requested !== "string" || !requested.trim()) {
    return { teamName: fallback, autoGenerated: true };
  }

  const normalized = normalizeTeamName(requested);
  if (!normalized.ok) {
    return {
      teamName: fallback,
      autoGenerated: true,
      nameIssue: `指定的团队名「${displayName(requested)}」不可用，已改用系统兜底名。\n原因：${normalized.reason}`,
    };
  }

  // Same-name check against pre-defined teams (case-insensitive): one readable
  // identifier must not point at two different teams (status bar / resume list).
  const taken = listTeams(getRootDir()).some(
    (name) => name.toLowerCase() === normalized.name.toLowerCase()
  );
  if (taken) {
    return {
      teamName: fallback,
      autoGenerated: true,
      nameIssue:
        `指定的团队名「${normalized.name}」与已有预定义团队同名，已改用系统兜底名。` +
        `同名会让同一个可读标识同时指向两个不同的团队。`,
    };
  }

  return { teamName: normalized.name, autoGenerated: false };
}

export function bootstrapDynamicSession(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ui: SessionUI,
  origin: SessionOrigin,
  options: DynamicSessionBootstrapOptions = {},
): DynamicSessionBootstrapResult {
  const resolved = resolveBootstrapTeamName(options.teamName);
  const teamName = resolved.teamName;
  mkdirSync(join(getRootDir(), "sessions", teamName), { recursive: true });

  const emptyTeam: TeamDefinition = {
    name: teamName,
    description: "动态团队",
    members: [],
  };

  startSession(emptyTeam, { origin });
  // Arm the bounded entry notice for USER-origin sessions only: `/team dynamic`
  // is a conversation switch the TL must notice. Agent-initiated sessions
  // (start_team_session) are started by the agent itself — telling it "you just
  // entered" would only duplicate the autonomous-mode prompt.
  if (origin === "user") {
    teamCtx.entryNoticeTurnsRemaining = SESSION_ENTRY_NOTICE_MAX_TURNS;
  }
  // Create the shared context stub up front (0 members for now). Guarantees
  // members always find a valid file; the TL overwrites it via
  // write_shared_context before starting members (gated).
  ensureSharedContextFile(emptyTeam, getSessionState().sessionId);
  teamCtx.isDynamicSession = true;
  teamCtx.dynamicPhase = "design";

  // Persist the session manifest immediately (the /team resume anchor) — do
  // not rely on the onSessionStart UI hook, which embedders may skip.
  setManifestRuntimeContext({ isDynamic: true, dynamicPhase: "design", agentInitiatedTask: null });
  syncActiveManifest({ status: "active" });

  ensureAddDynamicMemberTool(pi, teamCtx);
  // Naming is part of the same mode-tool family (design phase only; the tool
  // itself rejects renames once a member process is running).
  ensureSetTeamNameTool(pi, teamCtx);

  // Install team status widget (design phase — 0 members) and register ALL
  // session-only tools BEFORE activating them — pi.setActiveTools silently
  // ignores unregistered names.
  teamCtx.onSessionStart?.(ui);

  // Activate TL tools (+ add_dynamic_member and set_team_name for dynamic mode; +
  // stop_team_session for agent-initiated sessions only — user-initiated
  // sessions keep their lifecycle user-owned).
  const extras = [
    "add_dynamic_member",
    SET_TEAM_NAME_TOOL_NAME,
    ...(origin === "agent" ? [STOP_TEAM_SESSION_TOOL_NAME] : []),
  ];
  const currentActive = pi.getActiveTools();
  const newActive = [...new Set([...currentActive, ...teamCtx.tlToolNames, ...extras])]
    .filter((t) => t !== "create_team_definition" && t !== "update_team_definition");
  pi.setActiveTools(newActive);

  return resolved;
}
