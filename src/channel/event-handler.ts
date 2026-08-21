import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemberProcessHandle } from "../process/member-process";
import { transitionState } from "../session/state-machine";
import type { MemberOperationalState } from "../session/context";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { TeamMessage } from "../channel/types";
import type { ProcessManager } from "../process/manager";
import type { ResolvedAutoCompact } from "../settings/resolve-auto-compact";
import { DEFAULT_TIMEOUT_MINUTES } from "../settings/resolve-auto-compact";
import { createAutoCompactRuntime, type AutoCompactRuntime } from "./auto-compact";

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
  /**
   * Optional activity hook for the Member Inspector (成员检视浮窗).
   * Called at the top of every member RPC event so UI observers can mark
   * tabs dirty and throttle a get_messages refetch — or, for streaming
   * deltas (message_start / message_update / message_end), assemble the
   * live partial message locally. Must be cheap — it fires on
   * high-frequency events like message_update.
   */
  onMemberActivity?: (memberName: string, event: any) => void;
  /**
   * Member process handles by name (Phase 1). Powers the get_state query
   * after prompt rejections and the compaction_end flush dispatch. Absent =
   * the corresponding branches are inert (legacy minimal setups).
   */
  memberHandles?: Map<string, MemberProcessHandle>;
  /**
   * Shared auto-compaction runtime (from createMessageChannel). Powers the
   * compaction_end consumption branch (endCompaction + flushPending + the
   * timeout mark) and the get_state state-correction query. Absent = the
   * corresponding branches are inert.
   */
  autoCompact?: AutoCompactRuntime;
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
  // Per-member state-event generation (review fix 建议 2): bumped on every
  // state-affecting event (agent_start / agent_end / process_exit /
  // process_error). The async rejection correction captures it at rejection
  // time and skips applying when it changed — a newer authority (a real turn
  // / a crash) owns the state while the get_state answer was in flight.
  let stateGeneration = 0;

  return (event: any) => {
    const {
      memberOpsStates: states,
      messageQueue: mq,
      responseWaiter: rw,
      lastPendingCorrId: lpc,
      recentlyProcessedMessages: rpm,
    } = deps;

    // Notify activity observers (Member Inspector dirty-marking). Cheap and
    // synchronous; the observer is responsible for throttling any follow-up.
    // The FULL event is passed so stream deltas (message_start / message_update
    // / message_end) can be assembled into a live partial message instead of
    // waiting for the refetch.
    if (typeof event?.type === "string") {
      try {
        deps.onMemberActivity?.(memberName, event);
      } catch {
        // N4: activity observers (Member Inspector / activity tracker) are
        // best-effort display consumers — an observer bug must never break
        // the state machine updates that follow in this handler.
      }
    }

    // ── Surface fire-and-forget prompt rejections from the member's RPC layer ──
    // Channel prompts go through sendCommand (no id attached, no response
    // consumer). If the member's pi rejects the prompt, the error response
    // arrives here as a plain event — without this branch it is silently
    // swallowed: the member never receives the message and team_send_and_wait
    // hangs until the all-idle fallback. Responses WITH an id belong to
    // sendCommandAndWait callers (stats / compact / Member Inspector), which
    // consume their own errors — skip those.
    if (
      event.type === "response" &&
      event.command === "prompt" &&
      event.success === false &&
      event.id === undefined
    ) {
      const reason = typeof event.error === "string" ? event.error : "未知原因";
      const pendingCorrId = lpc.get(memberName);
      if (pendingCorrId) {
        rw.resolveIfWaiting(
          pendingCorrId,
          memberName,
          `[消息未送达] 成员 "${memberName}" 的 pi 进程拒收了任务消息：${reason}`
        );
        lpc.delete(memberName);
      }
      // Honest notification (Phase 1, beta E): the message is LOST — the
      // member's pi rejected the prompt. The old wording ("已直接派发任务")
      // claimed the opposite. The state correction below restores the
      // operational state to what the member actually reports (compacting /
      // idle) — never a fabricated `working` (that was the permanent-hang
      // black hole after a compaction timeout).
      deps.pi.sendMessage({
        customType: "team-route",
        content: `⚠️ 成员 "${memberName}" 拒收了消息通道下发的 prompt，消息未送达（已丢失，请稍后重试）。\n原因：${reason}\n已查询成员实际状态并按实际恢复；若成员仍在压缩，积压消息将在压缩结束后自动补发。`,
        display: true,
      });
      // State correction: ask the member (get_state.isCompacting) instead of
      // guessing — the most common rejection cause is a compaction still
      // running on the member side (the TL-side timeout lease expired while
      // the member-side compaction continued). Async, fail-open. The snapshot
      // pins the state + generation at rejection time so a STALE query answer
      // (a real turn / a crash arriving during the ≤3s window) never
      // overwrites newer state (review fix 建议 2).
      const stateSnapshot = {
        state: states.get(memberName) ?? "idle",
        generation: stateGeneration,
      };
      void correctStateAfterPromptRejection(memberName, deps, stateSnapshot, () => stateGeneration);
      return;
    }

    // ── Compaction lifecycle (Phase 1: event-driven exit) ──
    // compaction_end is the authoritative heartbeat: it fires on the member
    // side whenever a compaction actually finishes (success or failure). The
    // TL-side timeout lease says nothing about the member-side state — this
    // branch is the event-driven counterpart of the lease: exit compacting
    // (compacting → idle) and flush messages queued while the compaction
    // ran (→ working → agent_end → idle full chain). Without it, a
    // compaction that outlived the lease would leave the member stuck in
    // compacting/working forever (F7 blind spot — the wait tools' all-idle
    // check would never release).
    if (event.type === "compaction_end") {
      const runtime = deps.autoCompact;
      if (!runtime) return; // no shared runtime → nothing to reset/flush
      // Heartbeat accounting (Phase 2): the batch barrier marks a member
      // attempted when its compaction settled via the event; compactNow
      // suppresses the near-miss stale mark when a heartbeat arrived during
      // the lease. Counted in BOTH paths below (in-flight record + close).
      runtime.markCompactionEnd(memberName);
      // In-flight lease: the member emits compaction_end BEFORE the compact
      // response (agent-session.js emits, rpc-mode.js writes the response
      // afterwards), so during a healthy in-lease compaction this branch runs
      // while compactNow still awaits the response. The lease-owning flow
      // (inline post-compact path / batch barrier) owns the exit
      // (endCompaction) and the ORDERED flush (current message first, then
      // pending FIFO) — acting here would (a) invert the dispatch order
      // (pending B before the triggering A) and (b) reset compacting early,
      // opening a double-compaction window before the response settles
      // (Phase-1 review fix, 重要). Defer and return. Only lease-expired
      // heartbeats (timeout already settled the lease) fall through to the
      // exit+flush below.
      if (runtime.hasInFlightCompaction(memberName)) {
        return;
      }
      closeCompactionAndFlush(deps, memberName);
      return;
    }

    // ── Member operational state tracking (via pure state machine) ──
    if (event.type === "agent_start") {
      // Bump the state-generation: a real turn is the newest authority — the
      // async rejection correction must not overwrite its state (建议 2).
      stateGeneration++;
      states.set(memberName, transitionState(states.get(memberName) ?? "idle", { type: "task_started" }));

      // Cancel any pending auto-reply — more turns are coming
      cancelPendingAutoReply(memberName, deps);
      // Clear per-turn reply flag to track fresh for this new turn
      deps.perTurnReplied?.delete(memberName);

      return;
    }
    if (event.type === "agent_end") {
      // Bump the state-generation (see agent_start).
      stateGeneration++;
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
      // Bump the state-generation (see agent_start).
      stateGeneration++;
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
      // Phase 2 (三出口之③): the process is gone — messages sitting in the
      // pending queue would be orphaned forever (no compaction_end will ever
      // flush them). Drain the queue, resolve the pending corrIds (消息未送
      // 达), consume the timeout mark silently (no future heartbeat to
      // notify) and notify the TL with a summary. Runs on intentional stops
      // too (wasRunning=false) — a stopped member orphans pending as well.
      drainPendingOnProcessExit(exitMemberName, deps);
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
      // Bump the state-generation (see agent_start).
      stateGeneration++;
      // Clean up auto-reply tracking
      cancelPendingAutoReply(errMemberName, deps);
      deps.perTurnReplied?.delete(errMemberName);

      const currentState = states.get(errMemberName) ?? "idle";
      states.set(errMemberName, transitionState(currentState, { type: "process_exit", isCrashLoop: true }));
      // Phase 2 (三出口之③): same pending drain as process_exit.
      drainPendingOnProcessExit(errMemberName, deps);
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

/**
 * Restore a member's operational state after a prompt rejection, based on
 * what the member's pi actually reports (get_state.isCompacting — "ask
 * instead of guess", beta form). A rejection is most often caused by a
 * compaction still running on the member side (the TL-side timeout lease
 * expired while the member-side compaction continued); the state left
 * behind is `working` and nothing would ever clear it — the wait tools'
 * all-idle check hangs forever.
 *
 * - isCompacting === true  → compacting (exit = the compaction_end branch):
 *   new messages then queue via sendToMember's compacting branch and are
 *   flushed when the compaction actually ends — a second compaction can
 *   structurally never start (double-compaction loop eliminated).
 * - isCompacting === false → idle (via the pure state machine,
 *   task_completed — a re-dispatch is then safe).
 * - query failure          → idle (conservative) + notify.
 * - handle / runtime unavailable → no-op (cannot query; leave as-is).
 *
 * Staleness guard (review fix 建议 2): the query window is up to 3s. If a
 * real turn (agent_start/agent_end) or a process exit arrives during it,
 * the answer is STALE — applying it would overwrite the newer state (e.g.
 * a false idle over a running turn, releasing the wait tools early; or a
 * stale compacting over a new prompt). Apply only when the state is
 * unchanged since the rejection AND no state-affecting event arrived.
 * Note: compaction_end is deliberately NOT counted — on the single pipe, a
 * TRUE answer is always written before the compaction_end event (the member
 * was still compacting when it answered), while a FALSE answer may arrive
 * after it (the member answered once the compaction ended) — and that
 * late-false is exactly the closing path (working → idle). Counting the
 * event would kill that path and strand the settled-lease heartbeat flow in
 * `working` (the branch's endCompaction is a no-op on working; only the
 * query answer can close it).
 */
async function correctStateAfterPromptRejection(
  memberName: string,
  deps: EventHandlerDeps,
  snapshot: { state: MemberOperationalState; generation: number },
  getCurrentGeneration: () => number
): Promise<void> {
  const handle = deps.memberHandles?.get(memberName);
  const runtime = deps.autoCompact;
  if (!handle || !runtime) return;

  const isCompacting = await runtime.queryCompactionState(memberName, handle);
  const states = deps.memberOpsStates;
  // Staleness guard: skip when a newer authority took over the state.
  if ((states.get(memberName) ?? "idle") !== snapshot.state) return;
  if (getCurrentGeneration() !== snapshot.generation) return;
  if (isCompacting === true) {
    states.set(
      memberName,
      transitionState(states.get(memberName) ?? "idle", { type: "compaction_confirmed" })
    );
    return;
  }
  states.set(
    memberName,
    transitionState(states.get(memberName) ?? "idle", { type: "task_completed" })
  );
  if (isCompacting === null) {
    deps.pi.sendMessage({
      customType: "team-route",
      content: `⚠️ 查询成员 "${memberName}" 实际状态失败，已按保守选择恢复为 idle。若该成员实际仍在压缩，请稍后检视其状态。`,
      display: true,
    });
  }
}

/**
 * Phase 2 (三出口之③): drain a member's pending queue after its process
 * exits/errors. Messages queued during a compaction would be orphaned
 * forever — no compaction_end will ever flush them (the process is gone).
 * Resolves each queued message's corrId with the 消息未送达 semantics,
 * consumes the timeout mark silently (no future heartbeat to notify), and
 * notifies the TL with a content summary so the work can be re-dispatched
 * after a restart. No-op when nothing is queued. Runs on intentional stops
 * too (a stopped member orphans pending just the same).
 */
function drainPendingOnProcessExit(memberName: string, deps: EventHandlerDeps): void {
  const runtime = deps.autoCompact;
  if (!runtime) return;
  const pending = runtime.flushPending(memberName);
  // Consume silently — a later compaction_end (from a NEW process) must not
  // mis-fire the timeout notification.
  runtime.takeCompactionTimeout(memberName);
  if (pending.length === 0) return;
  for (const msg of pending) {
    if (msg.correlationId) {
      deps.responseWaiter.resolveIfWaiting(
        msg.correlationId,
        memberName,
        `[消息未送达] 成员 "${memberName}" 进程已退出，其待派发消息已移除`
      );
    }
  }
  const lpcCorr = deps.lastPendingCorrId.get(memberName);
  if (lpcCorr && pending.some((m) => m.correlationId === lpcCorr)) {
    deps.lastPendingCorrId.delete(memberName);
  }
  const summary = pending.map((m) => m.content.slice(0, 60)).join(" | ");
  deps.pi.sendMessage({
    customType: "team-message",
    content: `⚠️ 成员 "${memberName}" 进程已退出，其待派发队列中的 ${pending.length} 条消息已移除（概要：${summary}）。进程重启后请重新派发。`,
    display: true,
  });
}

// ── createSendToMember ─────────────────────────────────────
// Creates the sendToMember callback used by the router config.

/**
 * Dependencies shared by the inline dispatch path (createSendToMember) and
 * the compaction_end flush path (createMemberEventHandler). Both dispatch
 * channel prompts to member handles with identical semantics.
 */
export interface PromptDispatchDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  memberHandles: Map<string, MemberProcessHandle>;
  lastPendingCorrId: Map<string, string>;
  responseWaiter: ResponseWaiter;
}

/** Build the channel prompt text for a TeamMessage. */
function buildPromptMessage(msg: TeamMessage): string {
  return `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`;
}

/**
 * Fire-and-forget prompt dispatch to a member handle: mark the member
 * working (task_started), then sendCommand with streamingBehavior followUp
 * (pi queues the prompt when the member is still streaming — a dispatch is
 * never lost to "Agent is already processing" rejections). On sendCommand
 * failure: resolve any pending wait and notify the TL (fail-open).
 */
export function dispatchPromptToMember(
  deps: PromptDispatchDeps,
  memberName: string,
  msg: TeamMessage
): void {
  const handle = deps.memberHandles.get(memberName);
  if (!handle) return;
  // Mark member as working when we send a prompt
  deps.memberOpsStates.set(
    memberName,
    transitionState(deps.memberOpsStates.get(memberName) ?? "idle", { type: "task_started" })
  );
  try {
    handle.sendCommand({
      type: "prompt",
      message: buildPromptMessage(msg),
      // If the member's agent is still streaming (working, or inside its
      // post-agent_end settlement window — auto-retry / auto-compaction /
      // listener drain), pi queues this prompt as a followUp instead of
      // rejecting it. No effect when the member is idle.
      streamingBehavior: "followUp",
    });
  } catch (err) {
    const reason = `发送消息给成员 "${memberName}" 失败：${err instanceof Error ? err.message : String(err)}`;
    const pendingCorrId = deps.lastPendingCorrId.get(memberName);
    if (pendingCorrId) {
      deps.responseWaiter.resolveIfWaiting(pendingCorrId, memberName, reason);
      deps.lastPendingCorrId.delete(memberName);
    }
    deps.pi.sendMessage({ customType: "team-route", content: reason, display: true });
  }
}

/** Adapt close-deps (or EventHandlerDeps) to PromptDispatchDeps; null when memberHandles is absent. */
function toPromptDispatchDeps(deps: CompactionCloseDeps): PromptDispatchDeps | null {
  if (!deps.memberHandles) return null;
  return {
    pi: deps.pi,
    memberOpsStates: deps.memberOpsStates,
    memberHandles: deps.memberHandles,
    lastPendingCorrId: deps.lastPendingCorrId,
    responseWaiter: deps.responseWaiter,
  };
}

/** Dependencies of the shared compaction-lifecycle close (Phase 2). */
interface CompactionCloseDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  memberHandles?: Map<string, MemberProcessHandle>;
  lastPendingCorrId: Map<string, string>;
  responseWaiter: ResponseWaiter;
  autoCompact?: AutoCompactRuntime;
}

/**
 * Close a compaction lifecycle: consume the timeout mark (once), exit
 * compacting (compacting → idle) and flush pending messages in FIFO order
 * (dispatched via the shared prompt path). When the lease had previously
 * expired (mark present), notify the TL — the normal path stays silent.
 *
 * Shared by the compaction_end event branch (primary exit) and the
 * waitCompactionIdle fallback (event loss / auto-restart). Idempotent: the
 * mark is consumed exactly once and the pending queue is drained once, so a
 * second close (e.g. the event arriving after the poll already released) is
 * a no-op.
 */
export function closeCompactionAndFlush(deps: CompactionCloseDeps, memberName: string): void {
  const runtime = deps.autoCompact;
  if (!runtime) return;
  const timedOutAt = runtime.takeCompactionTimeout(memberName);
  runtime.endCompaction(memberName);
  const flushed = runtime.flushPending(memberName);
  const dispatch = toPromptDispatchDeps(deps);
  if (dispatch) {
    for (const pendingMsg of flushed) {
      dispatchPromptToMember(dispatch, memberName, pendingMsg);
    }
  }
  if (timedOutAt !== undefined) {
    const minutes = Math.max(1, Math.round((Date.now() - timedOutAt) / 60_000));
    deps.pi.sendMessage({
      customType: "team-message",
      content:
        flushed.length > 0
          ? `⚠️ 成员 "${memberName}" 的压缩已于 ${minutes} 分钟后结束，积压消息已自动补发。`
          : `⚠️ 成员 "${memberName}" 的压缩已于 ${minutes} 分钟后结束。`,
      display: true,
    });
  }
}

export interface SendToMemberDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  memberHandles: Map<string, MemberProcessHandle>;
  /** ResponseWaiter for resolving pending team_send_and_wait when routing fails. */
  responseWaiter: ResponseWaiter;
  /** Correlation IDs for pending team_send_and_wait requests. */
  lastPendingCorrId: Map<string, string>;
  /**
   * Resolve the effective Auto-Compaction config. Called on every dispatch
   * so settings changes mid-session take effect. Absent = feature disabled.
   */
  getAutoCompact?: () => ResolvedAutoCompact;
  /**
   * Shared auto-compaction runtime. When provided (see createMessageChannel),
   * the inline dispatch path and the batch pre-check barrier (tl-tools)
   * share ONE pending/flush mechanism — messages queued during a compaction
   * started by either path are never orphaned. Absent = a private runtime is
   * created (behavior unchanged).
   */
  autoCompact?: AutoCompactRuntime;
}

export function createSendToMember(
  deps: SendToMemberDeps
): (memberName: string, msg: TeamMessage) => void {
  const { pi, memberOpsStates, memberHandles } = deps;

  // Shared auto-compaction runtime: all compaction primitives (state
  // transitions, pending queue, flush) live here so the inline path and the
  // batch pre-check barrier use the same pending/flush mechanism.
  const autoCompact = deps.autoCompact ?? createAutoCompactRuntime(memberOpsStates);

  // Prompt dispatch deps — shared with the compaction_end flush path so
  // both use the exact same send semantics (working mark + followUp).
  const promptDeps: PromptDispatchDeps = {
    pi,
    memberOpsStates,
    memberHandles,
    lastPendingCorrId: deps.lastPendingCorrId,
    responseWaiter: deps.responseWaiter,
  };

  // Compaction-lifecycle close deps — shared by the compaction_end branch
  // (via the handler) and the Phase-2 fallback watcher below.
  const closeDeps: CompactionCloseDeps = {
    pi,
    memberOpsStates,
    memberHandles,
    lastPendingCorrId: deps.lastPendingCorrId,
    responseWaiter: deps.responseWaiter,
    autoCompact,
  };

  /** Auto-compaction notices go to the TL session as team messages. */
  function notify(content: string): void {
    pi.sendMessage({ customType: "team-message", content, display: true });
  }

  // ── Phase 2: stuck-compaction fallback (三出口之②) ──
  // After a compactNow lease TIMEOUT the message is queued (never dispatched
  // into the still-running compaction) and the compaction_end event is the
  // PRIMARY exit. This watcher covers the fallback exits: the event LOST
  // (pipe/network) or the member auto-restarted (events not replayed) →
  // waitCompactionIdle polls get_state and closes+flushes when the
  // compaction actually ends; the compaction NEVER ends → the secondary
  // budget expires → the pending messages are abandoned (corrIds resolved,
  // TL notified for manual intervention). One watcher per member (deduped).
  const activeFallbackWatchers = new Set<string>();

  /**
   * Queue a message into a compaction that has NO in-flight lease (its lease
   * already timed out — the stuck case). Starts the fallback watcher. The
   * 入队竞态闭合 (alpha): when the member is no longer compacting (a close
   * already ran — e.g. the compaction_end was processed while the lease was
   * still settling and flushed the empty queue), queueing would orphan the
   * message — dispatch directly instead.
   */
  function queueDuringStuckCompaction(
    memberName: string,
    msg: TeamMessage,
    cfg?: ResolvedAutoCompact
  ): void {
    if (autoCompact.queueDuringCompaction(memberName, msg)) {
      startFallbackWatcher(memberName, cfg);
      return;
    }
    // 竞态闭合: not compacting anymore — dispatch straight through.
    dispatchPromptToMember(promptDeps, memberName, msg);
  }

  /** Start (once per member) the waitCompactionIdle fallback watcher. */
  function startFallbackWatcher(memberName: string, cfg?: ResolvedAutoCompact): void {
    if (activeFallbackWatchers.has(memberName)) return;
    const handle = memberHandles.get(memberName);
    if (!handle) return;
    activeFallbackWatchers.add(memberName);
    // Secondary budget = one lease period (与批屏障 batchMaxWaitMinutes 语义
    // 统一：等待计入预算；0/缺省用默认超时）。
    const budgetMs = (cfg?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000;
    void (async () => {
      try {
        const result = await autoCompact.waitCompactionIdle(memberName, handle, budgetMs);
        // If a NEW compaction cycle started while we polled, its lease-owning
        // flow (or its own branch deferral) owns the lifecycle — never close
        // or abandon under someone else's lease.
        if (autoCompact.hasInFlightCompaction(memberName)) return;
        if (result.ok) {
          // Compaction ended (event lost / auto-restart) — close + flush.
          closeCompactionAndFlush(closeDeps, memberName);
        } else {
          // Budget exhausted — the compaction never ended: abandon.
          abandonPendingMessages(memberName, result.error);
        }
      } finally {
        activeFallbackWatchers.delete(memberName);
      }
    })();
  }

  /**
   * Abandon a member's pending messages after the secondary budget expired:
   * drain the queue, resolve each corrId (the team_send_and_wait waiter is
   * unblocked with the [已放弃] semantics), and notify the TL with the
   * manual-intervention advice (stop_member / /team stop + resume).
   */
  function abandonPendingMessages(memberName: string, reason: string): void {
    const pending = autoCompact.flushPending(memberName);
    if (pending.length === 0) return;
    for (const msg of pending) {
      if (msg.correlationId) {
        deps.responseWaiter.resolveIfWaiting(
          msg.correlationId,
          memberName,
          `[任务已放弃] 成员 "${memberName}" 压缩超时上限（${reason}），消息已放弃，请重新派发`
        );
      }
    }
    const lpcCorr = deps.lastPendingCorrId.get(memberName);
    if (lpcCorr && pending.some((m) => m.correlationId === lpcCorr)) {
      deps.lastPendingCorrId.delete(memberName);
    }
    const summary = pending.map((m) => m.content.slice(0, 60)).join(" | ");
    pi.sendMessage({
      customType: "team-message",
      content: `⚠️ 成员 "${memberName}" 压缩超时上限，${pending.length} 条已排队任务已放弃（概要：${summary}）。请 stop_member 或 /team stop 后 /team resume 恢复。`,
      display: true,
    });
  }

  /**
   * Auto-Compaction flow — composed from AutoCompactRuntime primitives.
   * Success is silent; failures fail open with honest notifications.
   *
   * Phase 2 timeout semantics: a compactNow TIMEOUT is a lease expiry, not
   * a compaction end — the member-side compaction may still be running and
   * would synchronously reject any dispatched prompt (message lost + state
   * black hole, the Phase-1 root cause). The message is therefore QUEUED
   * (state stays compacting) and the compaction_end event flushes it; the
   * fallback watcher covers event loss / auto-restart / never-ending
   * compactions (三出口). Non-timeout failures mean the member-side
   * compaction already settled — dispatch is safe (fail-open as before).
   */
  async function runAutoCompactAndDispatch(
    memberName: string,
    msg: TeamMessage,
    handle: MemberProcessHandle,
    cfg: ResolvedAutoCompact
  ): Promise<void> {
    // Phase tracking for honest failure notifications.
    let phase: "stats" | "compact" = "stats";
    try {
      const statsResult = await autoCompact.queryStats(memberName, handle);
      if (!statsResult.ok) {
        // Fail-open: the runtime kept the real failure reason so the
        // notification below matches the pre-refactor inline behavior.
        throw new Error(statsResult.error);
      }

      if (autoCompact.shouldCompact(statsResult.stats, cfg)) {
        phase = "compact";
        const compactResult = await autoCompact.compactNow(memberName, handle, cfg);
        if (!compactResult.ok && compactResult.timedOut) {
          // Phase 2: lease expired, member-side compaction may still run —
          // keep compacting, queue the message, let the heartbeat flush it.
          // (The runtime recorded the timeout mark for the close notification;
          // a near-miss heartbeat during the lease suppresses it.)
          notify(
            `[自动压缩] 成员 "${memberName}" 压缩超过 ${cfg.timeoutMinutes} 分钟未完成，任务已排队，将在压缩结束后自动派发。`
          );
          queueDuringStuckCompaction(memberName, msg, cfg);
          return; // no endCompaction, no dispatch — the waiting flow owns it
        }
        if (!compactResult.ok) {
          throw new Error(compactResult.error);
        }
        // Success is silent — the TL does not need to perceive the process.
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (phase === "stats") {
        notify(`[自动压缩] 无法查询成员 "${memberName}" 的上下文用量（${reason}），已跳过压缩检查并直接派发任务。`);
      } else {
        notify(`[自动压缩] 成员 "${memberName}" 自动压缩未完成（${reason}），已直接派发任务。`);
      }
    }
    // Settled path (success / non-timeout failure): exit compacting and
    // dispatch — fail-open regardless of outcome above. Order is locked by
    // tests: reset state → dispatch current message → flush messages queued
    // during compaction (FIFO via the runtime).
    autoCompact.endCompaction(memberName);
    dispatchPromptToMember(promptDeps, memberName, msg);
    for (const pendingMsg of autoCompact.flushPending(memberName)) {
      dispatchPromptToMember(promptDeps, memberName, pendingMsg);
    }
  }

  /** Resolve any pending team_send_and_wait for a member that can't be reached. */
  function resolvePendingWaitIfAny(memberName: string, reason: string): void {
    const pendingCorrId = deps.lastPendingCorrId.get(memberName);
    if (pendingCorrId) {
      deps.responseWaiter.resolveIfWaiting(pendingCorrId, memberName, reason);
      deps.lastPendingCorrId.delete(memberName);
    }
  }

  return (memberName: string, msg: TeamMessage) => {
    const handle = memberHandles.get(memberName);
    if (!handle) {
      resolvePendingWaitIfAny(memberName, `消息目标 "${memberName}" 不存在或未启动。请先使用 start_member 启动该成员。`);
      pi.sendMessage({
        customType: "team-route",
        content: `无法路由消息到未知成员 "${memberName}"（该成员可能未启动）`,
        display: true,
      });
      return;
    }

    const state = memberOpsStates.get(memberName) ?? "idle";

    // A compaction is already in progress for this member — queue the message
    // in the shared runtime and let the in-flight flow flush it after
    // compaction completes. Phase 2: when the compaction has NO in-flight
    // lease (its lease already timed out — the stuck case), also start the
    // fallback watcher (event-loss poll + secondary timeout).
    if (state === "compacting") {
      if (autoCompact.hasInFlightCompaction(memberName)) {
        autoCompact.queueDuringCompaction(memberName, msg);
      } else {
        queueDuringStuckCompaction(memberName, msg, deps.getAutoCompact?.());
      }
      return;
    }

    const cfg = deps.getAutoCompact?.();
    // skipAutoCompact = the compaction decision was already made by the batch
    // pre-check barrier — bypass the inline check entirely (E12: prevents a
    // second compaction when usage is still over threshold; also enforces
    // "at most one compaction per dispatch" for barrier-compacted members).
    if (cfg?.enabled && state === "idle" && !msg.skipAutoCompact) {
      // Mark compacting synchronously (before any await) to close the race
      // where a second dispatch to the same idle member would double-compact.
      autoCompact.beginCompaction(memberName);
      void runAutoCompactAndDispatch(memberName, msg, handle, cfg);
      return;
    }

    // Direct dispatch (working member / marked message / disabled config).
    // Drain messages queued during a compaction that ended WITHOUT flushing
    // first — the batch barrier's endCompaction resets state only. FIFO: the
    // queued messages arrived earlier, so they go out before this one (D2:
    // messages can never be orphaned in the shared pending). No-op when the
    // queue is empty.
    for (const pendingMsg of autoCompact.flushPending(memberName)) {
      dispatchPromptToMember(promptDeps, memberName, pendingMsg);
    }
    dispatchPromptToMember(promptDeps, memberName, msg);
  };
}
