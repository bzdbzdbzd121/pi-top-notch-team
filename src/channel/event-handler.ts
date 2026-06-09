import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemberProcessHandle } from "../process/member-process";
import { transitionState } from "../session/state-machine";
import type { MemberOperationalState } from "../session/context";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { TeamMessage } from "../channel/types";

// ── Constants ──────────────────────────────────────────────

/** Max input length for parseTeamMessageTag (prevents regex backtracking). */
const MAX_PARSE_LENGTH = 100_000;

/** TTL for recentlyProcessedMessages dedup entries. */
const DEDUP_TTL_MS = 60_000;
/** Max entries in recentlyProcessedMessages dedup map. */
const DEDUP_MAX_SIZE = 500;

// ── EventHandlerDeps ──────────────────────────────────────

export interface EventHandlerDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
  lastPendingCorrId: Map<string, string>;
  /** Map<dedupKey, timestamp> — replaces Set<string> + individual setTimeout pattern. */
  recentlyProcessedMessages: Map<string, number>;
}

// ── Dedup helpers ───────────────────────────────────────────
// Replace individual setTimeout(delete, 60s) with timestamp-based
// Map pruning. On each insertion, expired entries are cleaned up
// and a max-size cap prevents unbounded growth.

/**
 * Mark a dedup key as processed with the current timestamp.
 * Prunes expired entries and enforces a max size limit.
 */
export function markDedupProcessed(
  map: Map<string, number>,
  key: string
): void {
  const now = Date.now();
  map.set(key, now);

  // Prune expired entries (older than DEDUP_TTL_MS)
  for (const [k, ts] of map) {
    if (now - ts > DEDUP_TTL_MS) {
      map.delete(k);
    }
  }

  // If still over the max size after pruning, remove oldest entries
  if (map.size > DEDUP_MAX_SIZE) {
    // Sort by timestamp (oldest first) and keep only the newest DEDUP_MAX_SIZE
    const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.slice(0, map.size - DEDUP_MAX_SIZE);
    for (const [k] of toRemove) {
      map.delete(k);
    }
  }
}

/**
 * Check if a dedup key was recently processed (within DEDUP_TTL_MS).
 * Also removes the entry if it has expired.
 */
export function wasDedupProcessed(
  map: Map<string, number>,
  key: string
): boolean {
  const ts = map.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    map.delete(key);
    return false;
  }
  return true;
}

// ── parseTeamMessageTag ────────────────────────────────────
// R1-M-2: Strict non-greedy regex with input length guard.
// R1-L-7: Input length check to prevent regex backtracking DoS.

export function parseTeamMessageTag(
  text: string
): { to: string; subject?: string; content: string } | null {
  // R1-L-7: Guard against excessively long input to prevent regex backtracking
  if (text.length > MAX_PARSE_LENGTH) {
    return null;
  }

  // R1-M-2: Strict non-greedy pattern
  //   - to="..." is required and must be a non-empty quoted string
  //   - subject="..." is optional
  //   - [\s\S]*? is non-greedy so </team-message> closes at the first occurrence
  const m = text.match(
    /<team-message\s+to="([^"]+)"(?:\s+subject="([^"]*)")?>([\s\S]*?)<\/team-message>/
  );
  if (!m) return null;
  return { to: m[1], subject: m[2] || undefined, content: m[3].trim() };
}

// ── createMemberEventHandler ───────────────────────────────
// Creates the onEvent callback for a member process handle.
// Handles: agent_start, agent_end, tool_execution_end (team_send_message),
//          message_end (<team-message> backup), process_exit, process_error.

export function createMemberEventHandler(
  memberName: string,
  deps: EventHandlerDeps
): (event: any) => void {
  return (event: any) => {
    const {
      memberOpsStates: states,
      messageQueue: mq,
      responseWaiter: rw,
      lastPendingCorrId: lpc,
      recentlyProcessedMessages: rpm,
    } = deps;

    // ── Member operational state tracking (via pure state machine) ──
    if (event.type === "agent_start") {
      states.set(memberName, transitionState(states.get(memberName) ?? "idle", { type: "task_started" }));
      return;
    }
    if (event.type === "agent_end") {
      states.set(memberName, transitionState(states.get(memberName) ?? "idle", { type: "task_completed" }));
      return;
    }

    // Primary: team_send_message tool result
    if (
      event.type === "tool_execution_end" &&
      event.toolName === "team_send_message"
    ) {
      const teamMsg = event.result?.details?.teamMessage;
      if (!teamMsg) return;

      // Record fingerprint for de-duplication (Map-based, auto-pruning)
      const dedupKey = `${teamMsg.from}:${teamMsg.content?.slice(0, 80) ?? ""}`;
      markDedupProcessed(rpm, dedupKey);

      // Auto-populate correlation ID (only for TL-directed messages)
      let content = teamMsg.content;
      if (teamMsg.to === "tl" && !/<corr:[a-zA-Z0-9_-]+>/.test(content)) {
        const stored = lpc.get(teamMsg.from);
        if (stored) {
          content = content + `\n\n<corr:${stored}>`;
        }
      }
      mq.enqueue({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: teamMsg.from,
        to: teamMsg.to,
        subject: teamMsg.subject,
        content,
        timestamp: teamMsg.timestamp ?? Date.now(),
      });
      return;
    }

    // Backup: check assistant text for <team-message> tags
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text =
        typeof event.message.content === "string"
          ? event.message.content
          : event.message.content
              ?.map((c: any) => c.text ?? "")
              .join(" ") ?? "";
      const parsed = parseTeamMessageTag(text);
      if (!parsed) return;

      // De-duplication (Map-based, also removes expired entries)
      const dedupKey = `${memberName}:${parsed.content?.slice(0, 80) ?? ""}`;
      if (wasDedupProcessed(rpm, dedupKey)) return;

      // Auto-populate correlation ID for backup path
      let backupContent = parsed.content;
      if (
        parsed.to === "tl" &&
        !/<corr:[a-zA-Z0-9_-]+>/.test(backupContent)
      ) {
        const stored = lpc.get(memberName);
        if (stored) {
          backupContent = backupContent + "\n\n<corr:" + stored + ">";
        }
      }
      mq.enqueue({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: memberName,
        to: parsed.to,
        subject: parsed.subject,
        content: backupContent,
        timestamp: Date.now(),
      });
      return;
    }

    // Handle process exit
    if (event.type === "process_exit") {
      const exitCode: number | null = event.exitCode;
      const isNormalExit =
        exitCode === null || exitCode === 0 || exitCode === 143;

      const currentState = states.get(event.memberName) ?? "idle";
      states.set(event.memberName, transitionState(currentState, {
        type: "process_exit",
        isCrashLoop: !isNormalExit,
      }));
      if (!event.wasRunning) return;

      if (!isNormalExit) {
        const pendingCorrId = lpc.get(event.memberName);
        if (pendingCorrId) {
          rw.resolveIfWaiting(
            pendingCorrId,
            event.memberName,
            "[成员进程已崩溃，消息无法送达]"
          );
          lpc.delete(event.memberName);
        }
        deps.pi.sendMessage({
          customType: "team-message",
          content: `Member "${event.memberName}" 进程异常退出（code: ${exitCode}），需检查崩溃原因。`,
          display: true,
          details: { crashEvent: event },
        });
      } else {
        deps.pi.sendMessage({
          customType: "team-message",
          content: `Member "${event.memberName}" 进程已正常停止（code: ${exitCode}）。`,
          display: true,
        });
      }
      return;
    }

    if (event.type === "process_error") {
      const memberName = event.memberName;
      const currentState = states.get(memberName) ?? "idle";
      states.set(memberName, transitionState(currentState, { type: "process_exit", isCrashLoop: true }));
      const pendingCorrId = lpc.get(memberName);
      if (pendingCorrId) {
        rw.resolveIfWaiting(
          pendingCorrId,
          memberName,
          "[成员进程错误，消息无法送达]"
        );
        lpc.delete(memberName);
      }
      deps.pi.sendMessage({
        customType: "team-message",
        content: `Member "${memberName}" 进程异常，需检查崩溃原因。`,
        display: true,
      });
      return;
    }
  };
}

// ── createSendToMember ─────────────────────────────────────
// Creates the sendToMember callback used by the router config.

export interface SendToMemberDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  memberHandles: Map<string, MemberProcessHandle>;
}

export function createSendToMember(
  deps: SendToMemberDeps
): (memberName: string, msg: TeamMessage) => void {
  const { pi, memberOpsStates, memberHandles } = deps;

  return (memberName: string, msg: TeamMessage) => {
    const handle = memberHandles.get(memberName);
    if (!handle) {
      pi.sendMessage({
        customType: "team-route",
        content: `无法路由消息到未知成员 "${memberName}"（该成员可能未启动）`,
        display: true,
      });
      return;
    }

    // Mark member as working when we send a prompt
    memberOpsStates.set(memberName, transitionState(memberOpsStates.get(memberName) ?? "idle", { type: "task_started" }));

    try {
      handle.sendCommand({
        type: "prompt",
        message: `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`,
      });
    } catch (err) {
      pi.sendMessage({
        customType: "team-route",
        content: `发送消息给成员 "${memberName}" 失败：${err instanceof Error ? err.message : String(err)}`,
        display: true,
      });
    }
  };
}
