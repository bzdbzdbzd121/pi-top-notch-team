import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../session/context";
import type { SessionOrigin } from "../session/state";
import { getSessionState, startSession, addMemberToSession } from "../session/state";
import { ensureSharedContextFile } from "../session/shared-context";
import { setManifestRuntimeContext, syncActiveManifest } from "../session/manifest";
import { getRootDir } from "../config";
import type { TeamDefinition, TeamMember } from "../team/definition";
import { ensureToolRegistered } from "../commands/shared/ensure-tool";
import { STOP_TEAM_SESSION_TOOL_NAME } from "../tools/agent-session-tool-names";
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
          addMemberToSession(member);
          // Persist the updated roster — for dynamic teams this manifest is the
          // ONLY durable copy of the member definitions (no YAML on disk).
          syncActiveManifest();
          const session = getSessionState();
          if (session.teamDefinition) {
            teamCtx.router!.updateMembers(session.teamDefinition.members.map((m) => m.name));
          }
          return {
            details: {},
            content: [{ type: "text" as const, text: `成员「${params.label}（${params.name}）」已添加到动态团队。使用 start_member ${params.name} 启动。` }],
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
 *
 * @returns the generated dynamic team name (`_dynamic_<ts>`)
 */
export function bootstrapDynamicSession(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ui: SessionUI,
  origin: SessionOrigin,
): string {
  const teamName = `_dynamic_${Date.now()}`;
  mkdirSync(join(getRootDir(), "sessions", teamName), { recursive: true });

  const emptyTeam: TeamDefinition = {
    name: teamName,
    description: "动态团队",
    members: [],
  };

  startSession(emptyTeam, { origin });
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

  // Install team status widget (design phase — 0 members) and register ALL
  // session-only tools BEFORE activating them — pi.setActiveTools silently
  // ignores unregistered names.
  teamCtx.onSessionStart?.(ui);

  // Activate TL tools (+ add_dynamic_member for dynamic mode; +
  // stop_team_session for agent-initiated sessions only — user-initiated
  // sessions keep their lifecycle user-owned).
  const extras = ["add_dynamic_member", ...(origin === "agent" ? [STOP_TEAM_SESSION_TOOL_NAME] : [])];
  const currentActive = pi.getActiveTools();
  const newActive = [...new Set([...currentActive, ...teamCtx.tlToolNames, ...extras])]
    .filter((t) => t !== "create_team_definition" && t !== "update_team_definition");
  pi.setActiveTools(newActive);

  return teamName;
}
