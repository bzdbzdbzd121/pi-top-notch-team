// ── Constants ──────────────────────────────────────────────

/**
 * Staleness threshold (ms): a thinking / tool-calling / output phase that has
 * seen no events for this long is downgraded to `working` at READ time (D7).
 * Executing is exempt — long tool executions legitimately produce no deltas.
 * The judgment is lazy: derivePhase() applies it only when the phase is read,
 * so no timer, no background scan, and no event-path cost.
 */
export const STALE_AFTER_MS = 30_000;

// ── Types ──────────────────────────────────────────────────

/**
 * Fine-grained member activity phases (display layer only).
 * Priority order when multiple streams are active (D5):
 * executing > tool-calling > output > thinking; no active stream → working;
 * agent_end (authoritative zero point) → idle.
 */
export type ActivityPhase =
  | "thinking"
  | "tool-calling"
  | "executing"
  | "output"
  | "working"
  | "idle";

/** Per-stream liveness flags — the basis of multi-stream priority (D5). */
export interface ActivityStreams {
  thinking: boolean;
  text: boolean;
  toolcall: boolean;
  executing: boolean;
}

/**
 * Per-member activity state stored by the tracker. Immutable — every event
 * produces a new object (small; the state machine is display-layer only).
 */
export interface MemberActivity {
  /** Phase derived at the last event (event truth). derivePhase() re-derives
   *  with staleness at read time (lazy, D3). */
  phase: ActivityPhase;
  /**
   * Internal marker: true after agent_end (authoritative zero point). The
   * post-agent_end stale-delta gate applies ONLY to ended turns — a
   * never-started member (fresh entry) still accepts stream events, so a
   * missed agent_start can never wedge the display.
   */
  ended: boolean;
  /** Timestamp (ms) of the most recent tracked event — staleness judgment. */
  lastDeltaAt: number;
  streams: ActivityStreams;
}

// ── Internal helpers ───────────────────────────────────────

/** Shared immutable empty-streams object — never mutated (updates spread-copy). */
const EMPTY_STREAMS: ActivityStreams = {
  thinking: false,
  text: false,
  toolcall: false,
  executing: false,
};

/** message_update assistantMessageEvent.type → stream flag mapping. */
const STREAM_BY_SUBTYPE: Record<string, keyof ActivityStreams> = {
  thinking_start: "thinking",
  thinking_delta: "thinking",
  thinking_end: "thinking",
  text_start: "text",
  text_delta: "text",
  text_end: "text",
  toolcall_start: "toolcall",
  toolcall_delta: "toolcall",
  toolcall_end: "toolcall",
};

/**
 * Priority derivation from stream flags (D5): executing > tool-calling >
 * output > thinking; no active stream → working. O(1) boolean checks only.
 */
function phaseFromStreams(streams: ActivityStreams): ActivityPhase {
  if (streams.executing) return "executing";
  if (streams.toolcall) return "tool-calling";
  if (streams.text) return "output";
  if (streams.thinking) return "thinking";
  return "working";
}

function createInitialState(now: number): MemberActivity {
  return {
    phase: "idle",
    ended: false,
    lastDeltaAt: now,
    streams: EMPTY_STREAMS,
  };
}

/** Apply a stream/flag update: bump lastDeltaAt, re-derive phase. */
function finalize(
  state: MemberActivity,
  streams: ActivityStreams,
  now: number
): MemberActivity {
  return {
    ...state,
    streams,
    lastDeltaAt: now,
    phase: phaseFromStreams(streams),
  };
}

// ── Pure transition function ───────────────────────────────

/**
 * Pure transition function: (state, raw member RPC event, now) → next state.
 * Deterministic and side-effect free; the only dependency is `now` (injected
 * for testability). N5 discipline: no string building, no UI/theme access,
 * no pi-tui imports; events it does not recognize return the SAME state
 * reference (zero allocation, idempotent).
 *
 * Event → rule (from the design):
 *   agent_start               → clear streams, land on thinking (D1)
 *   message_update (delta)    → set/clear the mapped stream flag; *_end clears
 *                               only its own stream (D6 — no hardcoded fallback)
 *   tool_execution_start      → executing (v2: no toolName — merged with
 *   tool_execution_update       update; same effect, see below)
 *   tool_execution_end        → clear executing; returns to any still-active
 *                               stream via priority (D5)
 *   message_end               → clear ALL stream flags; lands on working, never
 *                               idle (D4 — in-turn multi-message gaps must not
 *                               report idle; first anti-stuck insurance)
 *   agent_end                 → authoritative zero point: idle (D9, no delay)
 *   anything else             → idempotent ignore (incl. process_* — process
 *                               states are the logical layer's overlay; the
 *                               INTEGRATION layer must tracker.delete() a
 *                               member's entry on process_exit, otherwise a
 *                               member that crashed mid-execution stays
 *                               `executing` forever — it is staleness-exempt)
 *
 * v2 simplification (user-confirmed final plan): tool-name and duration
 * fields removed (display is icon + label + percent only). tool_execution_start and
 * tool_execution_update are merged into one case — without the name logic
 * they are structurally identical (per-activity updates must not clear
 * anything). The P1/P2/A1 review fixes and the D10 truncation lived on the
 * removed name logic and are deleted with it.
 *
 * The post-agent_end gate discards stale deltas from the finished turn: after
 * agent_end, only agent_start revives the member.
 */
export function applyActivityEvent(
  state: MemberActivity,
  event: any,
  now: number
): MemberActivity {
  const type = typeof event?.type === "string" ? event.type : "";

  // Idle gate: events arriving after agent_end belong to the finished turn
  // (delayed delivery) — discard until the next agent_start. Never-started
  // members (ended: false) are NOT gated.
  if (state.ended && type !== "agent_start") return state;

  switch (type) {
    case "agent_start": {
      // Fresh turn: wipe leftover streams from the previous turn.
      return {
        ...state,
        streams: EMPTY_STREAMS,
        ended: false,
        phase: "thinking",
        lastDeltaAt: now,
      };
    }

    case "agent_end": {
      return {
        ...state,
        streams: EMPTY_STREAMS,
        ended: true,
        phase: "idle",
        lastDeltaAt: now,
      };
    }

    case "message_update": {
      const sub = event?.assistantMessageEvent?.type;
      const stream = typeof sub === "string" ? STREAM_BY_SUBTYPE[sub] : undefined;
      if (!stream) return state; // unknown/absent subtype — idempotent
      const active = !sub.endsWith("_end");
      return finalize(state, { ...state.streams, [stream]: active }, now);
    }

    case "message_end": {
      // First anti-stuck insurance: wipe all stream flags → working.
      return finalize(state, EMPTY_STREAMS, now);
    }

    case "tool_execution_start":
    case "tool_execution_update": {
      // v2: merged — with the tool-name display removed, start and update are
      // structurally identical: keep executing active. A per-activity update
      // must never clear anything. (P1/P2/A1 and D10 lived on the removed
      // name logic.)
      return finalize(state, { ...state.streams, executing: true }, now);
    }

    case "tool_execution_end": {
      return finalize(state, { ...state.streams, executing: false }, now);
    }

    default:
      return state; // unknown events — idempotent ignore
  }
}

// ── Phase derivation (lazy, read time) ─────────────────────

/**
 * Derive the effective phase at read time. Pure. Applies the D7 staleness
 * judgment lazily: thinking / tool-calling / output with no events for
 * STALE_AFTER_MS degrade to `working`; executing is exempt (long tool
 * executions legitimately produce no deltas); working and idle never degrade.
 * Stored `phase` is event truth — staleness is display-only.
 *
 * When no stream is active, the stored phase is the authority (e.g. the D1
 * initial `thinking` right after agent_start, or `working` after message_end /
 * tool_execution_end) — stream flags alone cannot express those phases.
 */
export function derivePhase(
  state: MemberActivity,
  now: number = Date.now()
): ActivityPhase {
  // Authoritative zero point: after agent_end (or for never-started members),
  // the member is idle regardless of any leftover stream flags.
  if (state.phase === "idle") return "idle";
  const s = state.streams;
  const phase =
    s.thinking || s.text || s.toolcall || s.executing
      ? phaseFromStreams(s)
      : state.phase;
  if (
    (phase === "thinking" || phase === "tool-calling" || phase === "output") &&
    now - state.lastDeltaAt > STALE_AFTER_MS
  ) {
    return "working";
  }
  return phase;
}

// ── Tracker container ──────────────────────────────────────

export interface ActivityTracker {
  /**
   * Single O(1) entry for every member RPC event (N5): read state, transition,
   * write back. No string building, no UI access, no allocation for ignored
   * events (applyActivityEvent returns the same reference → no Map write).
   */
  onEvent(memberName: string, event: any): void;
  /** Current activity of one member (phase derived with staleness at read
   *  time). Undefined when the member has no tracked state yet. */
  getActivity(memberName: string, now?: number): MemberActivity | undefined;
  /** Snapshot of all tracked members' activities (render path). */
  getActivities(now?: number): Map<string, MemberActivity>;
  /** Remove one member's entry (member removed / deleted). */
  delete(memberName: string): void;
  /** Wipe all entries (widget uninstall path — no leaks). */
  clear(): void;
  readonly size: number;
}

/**
 * Per-member activity Map container. Lazy initialization: entries are created
 * on the first recognized event, so dynamic members appear automatically and
 * the map stays empty when no member has ever emitted an event. Pure display
 * layer — it never writes to memberOpsStates / state-machine (control plane
 * red line) and knows nothing about pi or the TUI.
 */
export function createActivityTracker(): ActivityTracker {
  const members = new Map<string, MemberActivity>();

  return {
    onEvent(memberName, event) {
      if (
        typeof event !== "object" ||
        event === null ||
        typeof event.type !== "string"
      ) {
        return;
      }
      // P4: single clock read — lastDeltaAt stays same-source.
      const now = Date.now();
      const current = members.get(memberName) ?? createInitialState(now);
      const next = applyActivityEvent(current, event, now);
      if (next !== current) members.set(memberName, next);
    },

    getActivity(memberName, now) {
      const state = members.get(memberName);
      if (!state) return undefined;
      const t = now ?? Date.now();
      const phase = derivePhase(state, t);
      return phase === state.phase ? state : { ...state, phase };
    },

    getActivities(now) {
      const t = now ?? Date.now();
      const out = new Map<string, MemberActivity>();
      for (const [name, state] of members) {
        const phase = derivePhase(state, t);
        out.set(name, phase === state.phase ? state : { ...state, phase });
      }
      return out;
    },

    delete(memberName) {
      members.delete(memberName);
    },

    clear() {
      members.clear();
    },

    get size() {
      return members.size;
    },
  };
}
