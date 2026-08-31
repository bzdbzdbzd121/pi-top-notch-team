import type { TeamMessage } from "./types";

/**
 * TL wait gate (S3) — buffers member→TL messages while a team_send_and_wait
 * wait is in flight, so they can be delivered the moment ALL members go idle
 * (the all-idle gate, decision #38) instead of sitting in pi's
 * `_pendingNextTurnMessages` until the TL's turn ends.
 *
 * Why buffering instead of pi's nextTurn queue: `_pendingNextTurnMessages`
 * has no public read/drain API (pi 0.83.0 agent-session.js — only push at
 * sendCustomMessage and inject+clear inside prompt()). The delivery decision
 * must therefore happen at message-arrival time: while a wait gate is active,
 * `sendToTl` buffers here; when the gate opens, `waitWithAllIdleCheck`
 * drains and re-delivers via a plain `pi.sendMessage` (steer — see below).
 *
 * Delivery timing (pi 0.83.0 verified): during a tool execution the agent
 * run is active (`_isAgentRunActive` covers the whole run, including tool
 * execution), so `sendCustomMessage` without `deliverAs` takes the steer
 * branch → the agent loop's steering queue is drained AFTER tool results
 * are appended and BEFORE the next assistant completion (agent-loop.js
 * runLoop: `pendingMessages = await config.getSteeringMessages()` at each
 * iteration end) — the TL sees the messages in the SAME turn, right after
 * the team_send_and_wait tool result, with zero streaming interruption.
 * Nothing is streaming during tool execution, so steer cannot interrupt.
 *
 * Robustness: if the TL run was aborted just before the flush, sendCustom-
 * Message falls to the not-streaming/no-triggerTurn branch and appends the
 * message to history without a turn — the message still lands in context
 * for the next completion instead of being lost.
 *
 * Counting semantics: `beginWait`/`endWait` are balanced by the single
 * `waitWithAllIdleCheck` caller (try/finally). Concurrent waits (parallel
 * tool calls) are tolerated — the first gate to open drains everything
 * buffered so far; both gates open at all-idle ≈ the same moment.
 */
export interface TlWaitGate {
  /** Mark a team_send_and_wait wait as in flight (member→TL messages buffer). */
  beginWait(): void;
  /** Mark the wait as ended (buffering stops; late arrivals use nextTurn). */
  endWait(): void;
  /** True while at least one wait is in flight. */
  isWaitActive(): boolean;
  /** Buffer a member→TL message for delivery at gate open. */
  buffer(msg: TeamMessage): void;
  /** Take all buffered messages (atomic drain). */
  drain(): TeamMessage[];
}

export function createTlWaitGate(): TlWaitGate {
  let activeWaits = 0;
  let buffered: TeamMessage[] = [];
  return {
    beginWait() {
      activeWaits++;
    },
    endWait() {
      activeWaits = Math.max(0, activeWaits - 1);
    },
    isWaitActive() {
      return activeWaits > 0;
    },
    buffer(msg: TeamMessage) {
      buffered.push(msg);
    },
    drain(): TeamMessage[] {
      const out = buffered;
      buffered = [];
      return out;
    },
  };
}
