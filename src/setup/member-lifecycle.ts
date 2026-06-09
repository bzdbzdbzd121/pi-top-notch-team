import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createMemberProcess } from "../process/member-process";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import type { ProcessManager } from "../process/manager";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MemberOperationalState } from "../session/context";
import type { TeamSessionState } from "../session/state";
import { getRootDir } from "../config";
import { createMemberEventHandler } from "../channel/event-handler";
import { existsSync, mkdirSync } from "node:fs";
import { transitionState } from "../session/state-machine";

// ── Dependency Injection Interface ─────────────────────────

export interface MemberLifecycleDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
  lastPendingCorrId: Map<string, string>;
  recentlyProcessedMessages: Map<string, number>;
  processManager?: ProcessManager;
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

export function buildMemberConfig(
  memberName: string,
  session: TeamSessionState
): MemberProcessConfig | null {
  const team = session.teamDefinition;
  if (!team) return null;

  const memberDef = team.members.find((m) => m.name === memberName);
  if (!memberDef) return null;

  const rootDir = getRootDir();
  const sessionDir = join(rootDir, "sessions", team.name, memberName);
  const sharedContextPath = join(
    rootDir,
    "sessions",
    team.name,
    ".shared-context.md"
  );

  // Create session directory before starting the member
  mkdirSync(sessionDir, { recursive: true });

  // Validate shared context path
  if (!existsSync(sharedContextPath)) {
    console.warn(
      `[team] Shared context file not found: ${sharedContextPath}. ` +
      "The member will start without a shared context."
    );
  }

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

      if (content.length > effectiveMaxLen) {
        content = content.slice(0, effectiveMaxLen) + "...";
      }

      return `[${m.role}] ${content}`;
    })
    .join("\n");
}
