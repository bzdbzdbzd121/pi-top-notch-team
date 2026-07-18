import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemberProcessHandle } from "../process/member-process";
import { transitionState } from "../session/state-machine";
import type { MemberOperationalState } from "../session/context";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { TeamMessage } from "../channel/types";
import type { ProcessManager } from "../process/manager";

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
  /** Optional ProcessManager for auto-restart handling on process exit. */
  processManager?: ProcessManager;
  /**
   * Track per-member last assistant text for auto-reply fallback.
   * Populated at message_end, consumed at agent_end auto-reply.
   */
  lastAssistantTexts?: Map<string, string>;
  /**
   * Members that sent team_send_message to TL in the current turn.
   * Cleared at agent_start, set at tool_execution_end for team_send_message to "tl".
   * Used to distinguish "member replied properly" from "member forgot to reply".
   */
  perTurnReplied?: Set<string>;
  /**
   * Pending auto-reply setTimeout references per member.
   * Set at agent_end when auto-reply is needed, cleared at agent_start or on tool reply.
   */
  pendingAutoReplies?: Map<string, NodeJS.Timeout>;
}

// ── Dedup helpers ───────────────────────────────────────────
// Replace individual setTimeout(delete, 60s) with timestamp-based
// Map pruning. On each insertion, expired entries are cleaned up
// and a max-size cap prevents unbounded growth.

/**
 * Mark a dedup key as processed, storing its expiry timestamp.
 * Lazy cleanup: only prunes expired entries when size exceeds 2x max.
 * Typical case is O(1) — just a map set.
 */
export function markDedupProcessed(
  map: Map<string, number>,
  key: string
): void {
  const expiry = Date.now() + DEDUP_TTL_MS;
  map.set(key, expiry);

  // Lazy cleanup: only prune when map exceeds 2x the max size
  if (map.size > DEDUP_MAX_SIZE * 2) {
    const now = Date.now();
    for (const [k, ts] of map) {
      if (ts < now) {
        map.delete(k);
      }
    }
  }
}

/**
 * Check if a dedup key was recently processed (within DEDUP_TTL_MS).
 * Lazily removes the entry if expired (single-entry cleanup).
 */
export function wasDedupProcessed(
  map: Map<string, number>,
  key: string
): boolean {
  const expiry = map.get(key);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
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

// ── Helper: extract assistant text from message_end event ──

function extractAssistantText(message: any): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((c: any) => (typeof c === "object" ? c.text ?? "" : String(c)))
      .join(" ");
  }
  return "";
}

// ── Auto-reply timeout (ms) ────────────────────────────────
// Must be long enough to survive inter-turn gaps in multi-turn agent sessions
// but short enough that team_send_and_wait doesn't hang indefinitely.
// Tool execution (file reads, simple operations) typically completes well
// under 3s; LLM-only turns (thinking) may take longer, but agent_start
// will fire and cancel the pending auto-reply.
const AUTO_REPLY_TIMEOUT_MS = 3000;

/** Cancel a pending auto-reply timeout for a member, if any. */
function cancelPendingAutoReply(memberName: string, deps: EventHandlerDeps): void {
  const timer = deps.pendingAutoReplies?.get(memberName);
  if (timer) {
    clearTimeout(timer);
    deps.pendingAutoReplies?.delete(memberName);
  }
}

/**
 * Schedule an auto-reply for a member that has a pending TL request
 * but hasn't called team_send_message. The reply uses the last assistant
 * text captured at message_end.
 */
function scheduleAutoReply(memberName: string, deps: EventHandlerDeps): void {
  // Cancel any existing pending auto-reply first
  cancelPendingAutoReply(memberName, deps);

  const timer = setTimeout(() => {
    deps.pendingAutoReplies?.delete(memberName);

    // Re-check: member might have been stopped or the corrId resolved
    const pendingCorrId = deps.lastPendingCorrId.get(memberName);
    if (!pendingCorrId) return;

    // Check if responseWaiter still has this corrId pending
    // resolveIfWaiting returns false if not found (already resolved or never existed)
    const resolved = deps.responseWaiter.resolveIfWaiting(
      pendingCorrId,
      memberName,
      deps.lastAssistantTexts?.get(memberName) ?? "（任务完成，未生成报告）"
    );
    if (resolved) {
      deps.lastPendingCorrId.delete(memberName);
    }
  }, AUTO_REPLY_TIMEOUT_MS);

  deps.pendingAutoReplies?.set(memberName, timer);
}

// ── createMemberEventHandler ───────────────────────────────
// Creates the onEvent callback for a member process handle.
// Handles: agent_start, agent_end, tool_execution_end (team_send_message),
//          message_end (<team-message> backup + auto-reply tracking),
//          process_exit, process_error.

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

      // Cancel any pending auto-reply — more turns are coming
      cancelPendingAutoReply(memberName, deps);
      // Clear per-turn reply flag to track fresh for this new turn
      deps.perTurnReplied?.delete(memberName);

      return;
    }
    if (event.type === "agent_end") {
      states.set(memberName, transitionState(states.get(memberName) ?? "idle", { type: "task_completed" }));

      // Agent turn ended. If member has a pending TL request and didn't
      // call team_send_message this turn, schedule an auto-reply.
      // The timeout is cancelled by:
      //   - next agent_start (more turns coming), OR
      //   - team_send_message tool execution (member replied properly)
      const pendingCorrId = lpc.get(memberName);
      const hasReplied = deps.perTurnReplied?.has(memberName);
      if (pendingCorrId && !hasReplied) {
        scheduleAutoReply(memberName, deps);
      }

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

      // Auto-populate correlation ID (only for TL-directed messages).
      // Always use the stored corr from lpc as ground truth — the member's
      // own corr tag is unreliable and often wrong. Set correlationId on the
      // TeamMessage object so sendToTl uses it directly (bypassing content parsing).
      let content = teamMsg.content;
      let correlationId: string | undefined;
      if (teamMsg.to === "tl") {
        const stored = lpc.get(teamMsg.from);
        if (stored) {
          correlationId = stored;
          // Strip any existing wrong corr tag and use the stored one instead
          content = content.replace(/<corr:[a-zA-Z0-9_-]+>/g, "").trim();
          content = content + `\n\n<corr:${stored}>`;
        }

        // Mark this member as having replied — prevents auto-reply at agent_end
        deps.perTurnReplied?.add(teamMsg.from);
        // Cancel any pending auto-reply — member replied properly via tool
        cancelPendingAutoReply(teamMsg.from, deps);
      }
      mq.enqueue({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: teamMsg.from,
        to: teamMsg.to,
        subject: teamMsg.subject,
        content,
        correlationId,
        timestamp: teamMsg.timestamp ?? Date.now(),
      });
      return;
    }

    // Backup: check assistant text for <team-message> tags
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractAssistantText(event.message);

      // Store the last assistant text for potential auto-reply
      deps.lastAssistantTexts?.set(memberName, text);

      const parsed = parseTeamMessageTag(text);
      if (!parsed) return;

      // De-duplication (Map-based, also removes expired entries)
      const dedupKey = `${memberName}:${parsed.content?.slice(0, 80) ?? ""}`;
      if (wasDedupProcessed(rpm, dedupKey)) return;

      // Auto-populate correlation ID for backup path.
      // Always use stored corr as ground truth (same logic as tool_execution_end path).
      let backupContent = parsed.content;
      let correlationId: string | undefined;
      if (parsed.to === "tl") {
        const stored = lpc.get(memberName);
        if (stored) {
          correlationId = stored;
          backupContent = backupContent.replace(/<corr:[a-zA-Z0-9_-]+>/g, "").trim();
          backupContent = backupContent + "\n\n<corr:" + stored + ">";
        }
      }
      mq.enqueue({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: memberName,
        to: parsed.to,
        subject: parsed.subject,
        content: backupContent,
        correlationId,
        timestamp: Date.now(),
      });
      return;
    }

    // Handle process exit
    if (event.type === "process_exit") {
      const exitMemberName = event.memberName;
      // Clean up auto-reply tracking for this member
      cancelPendingAutoReply(exitMemberName, deps);
      deps.perTurnReplied?.delete(exitMemberName);

      const exitCode: number | null = event.exitCode;
      const isNormalExit =
        exitCode === null || exitCode === 0 || exitCode === 143;

      const currentState = states.get(exitMemberName) ?? "idle";
      states.set(exitMemberName, transitionState(currentState, {
        type: "process_exit",
        isCrashLoop: !isNormalExit,
      }));
      if (!event.wasRunning) return;

      if (!isNormalExit) {
        const pendingCorrId = lpc.get(exitMemberName);
        if (pendingCorrId) {
          rw.resolveIfWaiting(
            pendingCorrId,
            exitMemberName,
            "[成员进程已崩溃，消息无法送达]"
          );
          lpc.delete(exitMemberName);
        }
        deps.pi.sendMessage({
          customType: "team-message",
          content: `Member "${exitMemberName}" 进程异常退出（code: ${exitCode}），需检查崩溃原因。`,
          display: true,
          details: { crashEvent: event },
        });
      } else {
        deps.pi.sendMessage({
          customType: "team-message",
          content: `Member "${exitMemberName}" 进程已正常停止（code: ${exitCode}）。`,
          display: true,
        });
      }

      // Notify ProcessManager for auto-restart handling (only for unexpected exits)
      deps.processManager?.handleExit(exitMemberName, exitCode);

      return;
    }

    if (event.type === "process_error") {
      const errMemberName = event.memberName;
      // Clean up auto-reply tracking
      cancelPendingAutoReply(errMemberName, deps);
      deps.perTurnReplied?.delete(errMemberName);

      const currentState = states.get(errMemberName) ?? "idle";
      states.set(errMemberName, transitionState(currentState, { type: "process_exit", isCrashLoop: true }));
      const pendingCorrId = lpc.get(errMemberName);
      if (pendingCorrId) {
        rw.resolveIfWaiting(
          pendingCorrId,
          errMemberName,
          "[成员进程错误，消息无法送达]"
        );
        lpc.delete(errMemberName);
      }
      deps.pi.sendMessage({
        customType: "team-message",
        content: `Member "${errMemberName}" 进程异常，需检查崩溃原因。`,
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
