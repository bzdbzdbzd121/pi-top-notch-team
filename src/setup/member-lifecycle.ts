import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createMemberProcess, hasSessionFiles } from "../process/member-process";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import type { ProcessManager } from "../process/manager";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MemberOperationalState } from "../session/context";
import type { TeamSessionState } from "../session/state";
import { getRootDir } from "../config";
import { loadSettings } from "../settings/settings";
import { resolveMemberModel } from "../settings/resolve-model";
import { createMemberEventHandler } from "../channel/event-handler";
import type { AutoCompactRuntime } from "../channel/auto-compact";
import { mkdirSync } from "node:fs";
import { transitionState } from "../session/state-machine";
import { ensureSharedContextFile } from "../session/shared-context";

// ── Dependency Injection Interface ─────────────────────────

export interface MemberLifecycleDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
  lastPendingCorrId: Map<string, string>;
  recentlyProcessedMessages: Map<string, number>;
  processManager?: ProcessManager;
  /** Auto-reply tracking: last assistant text per member (populated at message_end). */
  lastAssistantTexts?: Map<string, string>;
  /** Auto-reply tracking: members that replied via team_send_message in current turn. */
  perTurnReplied?: Set<string>;
  /** Auto-reply tracking: pending setTimeout refs for scheduled auto-replies. */
  pendingAutoReplies?: Map<string, NodeJS.Timeout>;
  /** Activity hook forwarded to the event handler (Member Inspector). Receives the full member RPC event. */
  onMemberActivity?: (memberName: string, event: any) => void;
  /**
   * Member process handles by name — forwarded to the event handler (Phase 1:
   * the get_state query after prompt rejections + the compaction_end flush
   * dispatch). Absent = those branches are inert.
   */
  memberHandles?: Map<string, MemberProcessHandle>;
  /**
   * Shared auto-compaction runtime (from createMessageChannel) — forwarded to
   * the event handler (Phase 1: the compaction_end consumption branch).
   */
  autoCompact?: AutoCompactRuntime;
}

// ── createAndRegisterMember ────────────────────────────────
// Creates a member RPC process and wires event handling for:
//   - Operational state transitions (agent_start/agent_end/process_exit/process_error)
//   - team_send_message tool result interception
//   - <team-message> tag backup parsing
//   - Process crash notification to TL
//   - Pending correlation ID cleanup on member failure

export function createAndRegisterMember(
  pi: ExtensionAPI,
  config: MemberProcessConfig,
  deps: MemberLifecycleDeps
): MemberProcessHandle {
  const handle = createMemberProcess(config, spawn);
  deps.memberOpsStates.set(config.name, transitionState("idle", { type: "started" }));

  if (deps.processManager) {
    deps.processManager.addHandle(handle);
  }

  handle.onEvent(createMemberEventHandler(config.name, deps));

  return handle;
}

// ── buildMemberConfig ──────────────────────────────────────
// Build a MemberProcessConfig from a member name and session state.
// Uses fileURLToPath (Windows-safe) instead of .pathname.
//
// Model resolution precedence (see src/settings/resolve-model.ts):
//   member.model > team defaults.model > global fixed > global follow (TL model) > none

export interface BuildMemberConfigOptions {
  /** TL's current model as "provider/id" — used when the global setting is "follow". */
  tlCurrentModel?: string;
  /**
   * Force session resume (`--continue`). When omitted, resume is auto-detected:
   * a member whose session dir already contains persisted pi session files is
   * always resumed (context continuity on restart), a fresh dir starts fresh.
   */
  resume?: boolean;
}

export function buildMemberConfig(
  memberName: string,
  session: TeamSessionState,
  options?: BuildMemberConfigOptions
): MemberProcessConfig | null {
  const team = session.teamDefinition;
  if (!team) return null;

  const memberDef = team.members.find((m) => m.name === memberName);
  if (!memberDef) return null;

  const rootDir = getRootDir();
  const sessionId = session.sessionId;
  if (!sessionId) {
    console.warn(
      `[team] No sessionId in session state — member "${memberName}" will use flat path.`
    );
  }
  // Isolate session data under <rootDir>/sessions/<team-name>/<sessionId>/
  // This prevents conflicts when the same team is used across multiple sessions.
  const sessionSubDir = sessionId ? join(team.name, sessionId) : team.name;
  const sessionDir = join(rootDir, "sessions", sessionSubDir, memberName);

  // Create session directory before starting the member
  mkdirSync(sessionDir, { recursive: true });

  // Guarantee the shared context file exists — auto-create a minimal stub
  // when the TL hasn't written one yet (instead of only warning).
  const sharedContextPath = ensureSharedContextFile(team, sessionId);

  // Resolve the effective model for this member (global settings + team YAML + TL model)
  const settings = loadSettings(rootDir);
  const resolved = resolveMemberModel(memberDef, team, settings, options?.tlCurrentModel);

  return {
    name: memberName,
    role: memberName,
    roleLabel: memberDef.label ?? memberName,
    teamName: team.name,
    teamMembers: team.members.map((m) => m.name),
    memberDescription: memberDef.systemPrompt,
    sessionDir,
    sharedContextPath,
    memberExtensionPath: fileURLToPath(
      new URL("../../member.ts", import.meta.url)
    ),
    cwd: process.cwd(),
    // Resume whenever this member already has persisted session files — covers
    // /team resume, TL-process restarts, and intentional stop/start cycles.
    // A fresh sessionId dir has no files and starts clean.
    ...(options?.resume || hasSessionFiles(sessionDir) ? { resume: true } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
  };
}

// ── getMemberLog ───────────────────────────────────────────
// Query a member's recent session messages via RPC get_messages.

export async function getMemberLog(
  handle: MemberProcessHandle,
  maxLines: number,
  maxContentLength?: number
): Promise<string> {
  const response = await handle.sendCommandAndWait(
    { type: "get_messages" },
    (event: any) =>
      event.type === "response" && event.command === "get_messages"
  );

  const effectiveMaxLen = maxContentLength ?? 200;

  const messages = response?.data?.messages ?? [];
  const recent = messages.slice(-maxLines);
  return recent
    .map((m: any) => {
      let content =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);

      // Truncate at character level (UTF-16 code units), reserving 3 chars for "..."
      if (content.length > effectiveMaxLen) {
        const truncatedLen = Math.max(0, effectiveMaxLen - 3);
        content = content.slice(0, truncatedLen) + "...";
      }

      return `[${m.role}] ${content}`;
    })
    .join("\n");
}
