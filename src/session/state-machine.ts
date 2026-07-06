// ── Types ──────────────────────────────────────────────────

import type { MemberOperationalState } from "./context";
export type { MemberOperationalState };

export type MemberEvent =
  | { type: "task_started" }
  | { type: "task_completed" }
  | { type: "process_exit"; isCrashLoop: boolean }
  /** Emitted after a member process has been spawned and its RPC is ready (ready promise resolved). */
  | { type: "started" }
  | { type: "stopped" };

// ── transitionState ────────────────────────────────────────
// Pure function: maps (current state, event) → next state.
// Deterministic, no side effects, no external dependencies.

export function transitionState(
  current: MemberOperationalState,
  event: MemberEvent
): MemberOperationalState {
  switch (event.type) {
    case "task_started":
      // A crashed member must be explicitly restarted before running tasks
      return current === "crashed" ? "crashed" : "working";

    case "task_completed":
      // Only working → idle; other states stay unchanged
      return current === "working" ? "idle" : current;

    case "process_exit":
      // process_exit only applies to non-crashed/stopped members
      if (current === "crashed") return "crashed";
      if (current === "stopped") return "stopped";
      return event.isCrashLoop ? "crashed" : "stopped";

    case "started":
      // Started is emitted after handle.start()'s ready promise resolves,
      // indicating the member's RPC process is ready to receive commands.
      // Resets any prior state to idle.
      return "idle";

    case "stopped":
      // Intentional stop transitions any state to stopped
      return "stopped";
  }
}
