// ── Types ──────────────────────────────────────────────────

import type { MemberOperationalState } from "./context";
export type { MemberOperationalState };

export type MemberEvent =
  | { type: "task_started" }
  | { type: "task_completed" }
  | { type: "process_exit"; isCrashLoop: boolean }
  /** Emitted when Auto-Compaction begins for an idle member (before dispatching a new prompt). */
  | { type: "compaction_started" }
  /** Emitted when Auto-Compaction ends (success, failure, or timeout) — the pending prompt is dispatched right after. */
  | { type: "compaction_completed" }
  /**
   * Emitted when get_state authoritatively confirms a compaction is running
   * (post-rejection correction — the rejection branch asks the member instead
   * of guessing). Corrects the `working` state left behind by the failed
   * dispatch; the exit is the compaction_end event branch (Phase 1).
   */
  | { type: "compaction_confirmed" }
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
      // A crashed member must be explicitly restarted before running tasks.
      // A compacting member stays compacting — the compaction turn's own
      // RPC events are shielded so they don't corrupt the display state;
      // the dispatch logic exits compacting explicitly via compaction_completed.
      if (current === "crashed") return "crashed";
      if (current === "compacting") return "compacting";
      return "working";

    case "task_completed":
      // Only working → idle; compacting is shielded (see task_started).
      if (current === "working") return "idle";
      return current;

    case "compaction_started":
      // Only an idle member can enter compaction (checked before dispatch).
      return current === "idle" ? "compacting" : current;

    case "compaction_completed":
      // Compaction finished — member is back to idle; the pending prompt
      // dispatch immediately follows with task_started → working.
      return current === "compacting" ? "idle" : current;

    case "compaction_confirmed":
      // Authoritative confirmation (get_state.isCompacting) that the
      // member-side compaction is running — corrects the `working` state
      // left behind by a rejected dispatch (the compaction-timeout black
      // hole). crashed/stopped members have no running compaction to wait
      // for (process_exit wins). Exit: the compaction_end event branch.
      if (current === "crashed" || current === "stopped") return current;
      return "compacting";

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
