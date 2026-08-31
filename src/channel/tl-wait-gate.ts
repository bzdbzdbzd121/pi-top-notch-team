import type { TeamMessage } from "./types";

/**
 * TL wait gate (S3) — buffers member→TL messages while a team_send_and_wait
 * wait is in flight, so they can be returned INSIDE the tool result the
 * moment ALL members go idle (the all-idle gate, decision #38) — instead of
 * sitting in pi's `_pendingNextTurnMessages` until the TL's turn ends.
 *
 * Why buffering instead of pi's nextTurn queue: `_pendingNextTurnMessages`
 * has no public read/drain API (pi 0.83.0 agent-session.js — only push at
 * sendCustomMessage and inject+clear inside prompt()). The delivery decision
 * must therefore happen at message-arrival time: while a wait gate is active,
 * `sendToTl` buffers here; when the gate opens, `waitWithAllIdleCheck`
 * drains the gate and appends the messages to the team_send_and_wait tool
 * result as `[from message]` sections (after the replies, before nextSteps).
 *
 * Esc-abort safety (pi 0.83.0 verified, agent-loop.js executeToolCalls-
 * Sequential): a completed tool result is pushed into the conversation BEFORE
 * the abort-break — so the result (buffered messages included) lands in
 * history even when the user aborts mid-wait; the next turn sees it.
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
