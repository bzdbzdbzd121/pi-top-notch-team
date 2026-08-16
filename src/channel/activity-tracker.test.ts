import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyActivityEvent,
  createActivityTracker,
  derivePhase,
  STALE_AFTER_MS,
  TOOL_NAME_MAX_CHARS,
  type ActivityPhase,
  type MemberActivity,
} from "./activity-tracker";

// ── Fixtures ───────────────────────────────────────────────

/** Event factory helpers (raw RPC event shapes, as delivered by member stdout). */
const ev = {
  agentStart: () => ({ type: "agent_start" }),
  agentEnd: () => ({ type: "agent_end" }),
  msgUpdate: (sub: string) => ({ type: "message_update", assistantMessageEvent: { type: sub } }),
  msgStart: (role = "assistant") => ({ type: "message_start", message: { role } }),
  msgEnd: (role = "assistant") => ({ type: "message_end", message: { role } }),
  toolStart: (toolName?: string) => ({ type: "tool_execution_start", toolName }),
  toolUpdate: (toolName?: string) => ({ type: "tool_execution_update", toolName }),
  toolEnd: () => ({ type: "tool_execution_end" }),
};

function initial(now = 1000): MemberActivity {
  return {
    phase: "idle",
    ended: false,
    toolName: undefined,
    toolNameTruncated: false,
    phaseSince: now,
    lastDeltaAt: now,
    streams: { thinking: false, text: false, toolcall: false, executing: false },
  };
}

/** Shortcut: run a deterministic event sequence from a fresh state. */
function run(now = 1000, ...events: { type: string }[]): MemberActivity {
  let state = initial(now);
  for (const e of events) {
    state = applyActivityEvent(state, e, ++now);
  }
  return state;
}

// ── Transition table: full mapping ─────────────────────────

describe("applyActivityEvent — transition table", () => {
  it("agent_start: clears streams/toolName, lands on thinking as the default starting phase (D1)", () => {
    const state = run(1000, ev.agentStart());
    expect(state.phase).toBe("thinking");
    expect(state.ended).toBe(false);
    expect(state.streams).toEqual({ thinking: false, text: false, toolcall: false, executing: false });
    expect(state.toolName).toBeUndefined();
    expect(state.phaseSince).toBe(1001);
    expect(state.lastDeltaAt).toBe(1001);
  });

  it("agent_start on a dirty mid-turn state resets leftover streams (no cross-turn pollution)", () => {
    let state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_start"), ev.msgUpdate("text_delta"));
    state = applyActivityEvent(state, ev.agentStart(), 5000);
    expect(state.phase).toBe("thinking");
    expect(state.streams).toEqual({ thinking: false, text: false, toolcall: false, executing: false });
    expect(state.phaseSince).toBe(5000);
  });

  it("thinking_start / thinking_delta activate the thinking stream", () => {
    for (const sub of ["thinking_start", "thinking_delta"]) {
      const state = run(1000, ev.agentStart(), ev.msgUpdate(sub));
      expect(state.streams.thinking).toBe(true);
      expect(state.phase).toBe("thinking");
    }
  });

  it("text_start / text_delta activate the text stream → output phase", () => {
    for (const sub of ["text_start", "text_delta"]) {
      const state = run(1000, ev.agentStart(), ev.msgUpdate(sub));
      expect(state.streams.text).toBe(true);
      expect(state.phase).toBe("output");
    }
  });

  it("toolcall_start / toolcall_delta activate the toolcall stream → tool-calling phase", () => {
    for (const sub of ["toolcall_start", "toolcall_delta"]) {
      const state = run(1000, ev.agentStart(), ev.msgUpdate(sub));
      expect(state.streams.toolcall).toBe(true);
      expect(state.phase).toBe("tool-calling");
    }
  });

  it("*_end clears only its own stream flag (D6: no hardcoded fallback — priority derivation decides)", () => {
    // thinking_end with no other stream → working (honest gap fallback)
    let state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_start"), ev.msgUpdate("thinking_end"));
    expect(state.streams.thinking).toBe(false);
    expect(state.phase).toBe("working");

    // text_end with thinking still active → back to thinking
    state = run(1000, ev.agentStart(), ev.msgUpdate("text_start"), ev.msgUpdate("thinking_start"), ev.msgUpdate("text_end"));
    expect(state.streams.text).toBe(false);
    expect(state.streams.thinking).toBe(true);
    expect(state.phase).toBe("thinking");
  });

  it("tool_execution_start: executing phase + toolName precomputed (D10)", () => {
    const state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"));
    expect(state.streams.executing).toBe(true);
    expect(state.phase).toBe("executing");
  });

  it("tool_execution_update keeps executing (no phase change, stream stays set)", () => {
    let state = run(1000, ev.agentStart(), ev.toolStart("bash"), ev.toolUpdate("bash"));
    expect(state.phase).toBe("executing");
    state = applyActivityEvent(state, ev.toolUpdate("bash"), 5000);
    expect(state.phase).toBe("executing");
    expect(state.streams.executing).toBe(true);
  });

  it("tool_execution_update WITHOUT toolName PRESERVES the stored toolName (P1 — never cleared by a nameless update)", () => {
    let state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"));
    expect(state.toolName).toBe("bash -");
    state = applyActivityEvent(state, ev.toolUpdate(), 5000);
    expect(state.toolName).toBe("bash -");
    expect(state.toolNameTruncated).toBe(true);
    expect(state.phase).toBe("executing");
  });

  it("tool_execution_update WITH a new toolName recomputes the stored form", () => {
    const state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"), ev.toolUpdate("git status"));
    expect(state.toolName).toBe("git st");
    expect(state.toolNameTruncated).toBe(true);
  });

  it("tool_execution_update with the SAME name skips re-truncation (P2 — per-activity event must not re-slice)", () => {
    let state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"));
    state = applyActivityEvent(state, ev.toolUpdate("bash -c make"), 5000);
    expect(state.toolName).toBe("bash -");
    expect(state.toolNameTruncated).toBe(true);
  });

  it("A1: update whose truncated form matches but truncation STATUS differs recomputes the flag (no stale ellipsis)", () => {
    // Stored: "bash -c make" → "bash -" (truncated). A new update carries
    // exactly TOOL_NAME_MAX_CHARS chars — same stored form, but NOT truncated:
    // the stale flag must be corrected even though the name string matches.
    let state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"));
    state = applyActivityEvent(state, ev.toolUpdate("bash -"), 5000);
    expect(state.toolName).toBe("bash -");
    expect(state.toolNameTruncated).toBe(false);
  });

  it("tool_execution_update on a fresh member (missed start) fail-softs into executing", () => {
    const state = run(1000, ev.toolUpdate("bash -c make"));
    expect(state.phase).toBe("executing");
    expect(state.toolName).toBe("bash -");
  });

  it("tool_execution_end: clears executing; returns to a still-active stream (D5 — not working)", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("text_start"), ev.toolStart("bash"), ev.toolEnd());
    expect(state.streams.executing).toBe(false);
    expect(state.streams.text).toBe(true);
    expect(state.phase).toBe("output");
  });

  it("tool_execution_end with no other active stream → working (D3: honest fallback, not idle)", () => {
    const state = run(1000, ev.agentStart(), ev.toolStart("bash"), ev.toolEnd());
    expect(state.phase).toBe("working");
  });

  it("message_end: clears ALL stream flags, lands on working — NEVER idle (D4)", () => {
    const state = run(
      1000,
      ev.agentStart(),
      ev.msgUpdate("thinking_start"),
      ev.msgUpdate("text_start"),
      ev.toolStart("bash"),
      ev.msgEnd()
    );
    expect(state.streams).toEqual({ thinking: false, text: false, toolcall: false, executing: false });
    expect(state.phase).toBe("working");
  });

  it("out-of-order defense: message_end during executing clears ALL streams and self-heals to working (P5 — never idle)", () => {
    const state = run(1000, ev.agentStart(), ev.toolStart("bash"), ev.msgEnd());
    expect(state.streams).toEqual({ thinking: false, text: false, toolcall: false, executing: false });
    expect(state.phase).toBe("working");
    // The name survives the stream wipe (retained until the next stage event).
    expect(state.toolName).toBe("bash");
  });

  it("agent_end: authoritative zero point → idle (D9: direct, no delay)", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"), ev.agentEnd());
    expect(state.phase).toBe("idle");
    expect(state.ended).toBe(true);
    expect(state.streams).toEqual({ thinking: false, text: false, toolcall: false, executing: false });
  });

  it("unknown / irrelevant events are idempotent — same object identity returned (N5: zero allocation)", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"));
    const irrelevant = [
      { type: "process_exit", memberName: "m", exitCode: 1 },
      { type: "process_error", memberName: "m" },
      { type: "response", id: 1, command: "prompt", success: true },
      { type: "some_future_event" },
      { type: "message_update" }, // missing assistantMessageEvent
      { type: "message_update", assistantMessageEvent: { type: "unknown_subtype" } },
      { type: "message_start", message: { role: "user" } },
    ];
    for (const e of irrelevant) {
      expect(applyActivityEvent(state, e, 5000)).toBe(state);
    }
  });

  it("agent_end discards stale deltas from the finished turn until the next agent_start", () => {
    let state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"), ev.agentEnd());
    expect(state.phase).toBe("idle");

    // Stale events from the finished turn must NOT flip the member back to busy.
    for (const e of [
      ev.msgUpdate("thinking_delta"),
      ev.msgUpdate("text_start"),
      ev.toolStart("bash"),
      ev.toolEnd(),
      ev.msgEnd(),
    ]) {
      state = applyActivityEvent(state, e, 5000);
      expect(state.phase, `event ${e.type} after agent_end`).toBe("idle");
      expect(state.streams).toEqual({ thinking: false, text: false, toolcall: false, executing: false });
    }
  });

  it("agent_start revives an ended member (next turn)", () => {
    const state = run(1000, ev.agentStart(), ev.agentEnd(), ev.agentStart());
    expect(state.phase).toBe("thinking");
    expect(state.ended).toBe(false);
  });

  it("a never-started member (fresh entry) accepts stream events — the idle gate only applies to ended turns", () => {
    // Fresh state is not "ended", so a missed agent_start cannot wedge the display.
    const state = applyActivityEvent(initial(1000), ev.toolStart("bash"), 1001);
    expect(state.phase).toBe("executing");
  });
});

// ── Multi-stream concurrency priority (D5) ─────────────────

describe("multi-stream priority: executing > tool-calling > output > thinking", () => {
  it("thinking + text parallel → output (higher priority wins)", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"), ev.msgUpdate("text_start"));
    expect(state.phase).toBe("output");
  });

  it("text + toolcall parallel → tool-calling", () => {
    const state = run(
      1000,
      ev.agentStart(),
      ev.msgUpdate("text_start"),
      ev.msgUpdate("toolcall_start")
    );
    expect(state.phase).toBe("tool-calling");
  });

  it("toolcall + executing → executing (heaviest wins)", () => {
    const state = run(
      1000,
      ev.agentStart(),
      ev.msgUpdate("toolcall_start"),
      ev.toolStart("bash")
    );
    expect(state.phase).toBe("executing");
  });

  it("executing ends while toolcall stream still active → tool-calling (not working)", () => {
    const state = run(
      1000,
      ev.agentStart(),
      ev.msgUpdate("toolcall_start"),
      ev.toolStart("bash"),
      ev.toolEnd()
    );
    expect(state.streams.toolcall).toBe(true);
    expect(state.phase).toBe("tool-calling");
  });

  it("text stream ends while thinking still active → thinking", () => {
    const state = run(
      1000,
      ev.agentStart(),
      ev.msgUpdate("thinking_start"),
      ev.msgUpdate("text_start"),
      ev.msgUpdate("text_end")
    );
    expect(state.phase).toBe("thinking");
  });

  it("no active streams → working gap fallback", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_end"));
    expect(state.phase).toBe("working");
  });
});

// ── phaseSince semantics ───────────────────────────────────

describe("phaseSince — current-phase start timestamp (duration micro-caption source)", () => {
  it("unchanged while the phase persists (deltas within one phase)", () => {
    let state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"), ev.msgUpdate("thinking_delta"));
    const since = state.phaseSince;
    state = applyActivityEvent(state, ev.msgUpdate("thinking_delta"), 5000);
    expect(state.phase).toBe("thinking");
    expect(state.phaseSince).toBe(since);
  });

  it("reset on every phase transition", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_start"), ev.msgUpdate("text_start"));
    expect(state.phase).toBe("output");
    expect(state.phaseSince).toBe(1003); // the event that caused the transition
  });
});

// ── Staleness judgment (D7, lazy at read time) ─────────────

describe("derivePhase — staleness (30s, exempt executing, lazy)", () => {
  it("thinking with no events for >30s downgrades to working", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"));
    expect(derivePhase(state, state.lastDeltaAt + STALE_AFTER_MS + 1)).toBe("working");
  });

  it("boundary: exactly STALE_AFTER_MS is NOT stale; 1ms more is", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"));
    const lastDelta = state.lastDeltaAt;
    expect(derivePhase(state, lastDelta + STALE_AFTER_MS)).toBe("thinking");
    expect(derivePhase(state, lastDelta + STALE_AFTER_MS + 1)).toBe("working");
  });

  it("executing is EXEMPT — long tool execution without deltas stays executing (no false downgrade)", () => {
    const state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"));
    expect(derivePhase(state, 1001 + STALE_AFTER_MS * 10)).toBe("executing");
  });

  it("tool-calling and output are also stale-checked", () => {
    const toolcall = run(1000, ev.agentStart(), ev.msgUpdate("toolcall_start"));
    expect(derivePhase(toolcall, toolcall.lastDeltaAt + STALE_AFTER_MS + 1)).toBe("working");
    const output = run(1000, ev.agentStart(), ev.msgUpdate("text_start"));
    expect(derivePhase(output, output.lastDeltaAt + STALE_AFTER_MS + 1)).toBe("working");
  });

  it("any new event resets the staleness clock", () => {
    let state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"));
    state = applyActivityEvent(state, ev.msgUpdate("thinking_delta"), 1001 + STALE_AFTER_MS);
    expect(derivePhase(state, state.lastDeltaAt + STALE_AFTER_MS + 1)).toBe("working");
    expect(derivePhase(state, state.lastDeltaAt + STALE_AFTER_MS)).toBe("thinking");
  });

  it("working and idle are never stale-downgraded", () => {
    const working = run(1000, ev.agentStart(), ev.msgUpdate("thinking_end"));
    expect(derivePhase(working, 1001 + STALE_AFTER_MS * 10)).toBe("working");
    const idle = run(1000, ev.agentStart(), ev.agentEnd());
    expect(derivePhase(idle, 1001 + STALE_AFTER_MS * 10)).toBe("idle");
  });
});

// ── D10: toolName precomputation ───────────────────────────

describe("D10 — toolName truncated at event time, renderers consume the stored form", () => {
  it("long tool names are truncated to TOOL_NAME_MAX_CHARS and flagged", () => {
    const long = "bash -c make -j8 all";
    const state = run(1000, ev.agentStart(), ev.toolStart(long));
    expect(state.toolName).toBe(long.slice(0, TOOL_NAME_MAX_CHARS));
    expect(state.toolName).toHaveLength(TOOL_NAME_MAX_CHARS);
    expect(state.toolNameTruncated).toBe(true);
  });

  it("short tool names are stored verbatim without the flag", () => {
    const short = "read";
    const state = run(1000, ev.agentStart(), ev.toolStart(short));
    expect(state.toolName).toBe(short);
    expect(state.toolNameTruncated).toBe(false);
  });

  it("missing toolName → executing without a name", () => {
    const state = run(1000, ev.agentStart(), ev.toolStart(undefined));
    expect(state.phase).toBe("executing");
    expect(state.toolName).toBeUndefined();
    expect(state.toolNameTruncated).toBe(false);
  });

  it("toolName is retained after tool_execution_end (no 2s fade; replaced by the next stage event)", () => {
    const state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"), ev.toolEnd());
    expect(state.phase).toBe("working");
    expect(state.toolName).toBe("bash -");
  });

  it("toolName is overwritten by the next tool execution and cleared at turn boundaries (no cross-turn residue)", () => {
    let state = run(1000, ev.agentStart(), ev.toolStart("bash -c make"), ev.toolEnd(), ev.toolStart("git status"));
    expect(state.toolName).toBe("git st");

    state = applyActivityEvent(state, ev.agentEnd(), 9000);
    expect(state.toolName).toBeUndefined();

    state = applyActivityEvent(state, ev.agentStart(), 10000);
    expect(state.toolName).toBeUndefined();
  });
});

// ── derivePhase on constructed states (priority rule) ──────

describe("derivePhase — priority derivation (no events needed)", () => {
  function withStreams(overrides: Partial<MemberActivity["streams"]>): MemberActivity {
    return {
      ...initial(1000),
      phase: "working",
      streams: { thinking: false, text: false, toolcall: false, executing: false, ...overrides },
    };
  }

  it("executing > tool-calling > output > thinking > working", () => {
    expect(derivePhase(withStreams({ executing: true, toolcall: true, text: true, thinking: true }), 1001)).toBe("executing");
    expect(derivePhase(withStreams({ toolcall: true, text: true, thinking: true }), 1001)).toBe("tool-calling");
    expect(derivePhase(withStreams({ text: true, thinking: true }), 1001)).toBe("output");
    expect(derivePhase(withStreams({ thinking: true }), 1001)).toBe("thinking");
    expect(derivePhase(withStreams({}), 1001)).toBe("working");
  });

  it("idle state stays idle regardless of streams (authoritative zero point)", () => {
    const idle = { ...withStreams({ thinking: true }), phase: "idle" as ActivityPhase };
    expect(derivePhase(idle, 1001)).toBe("idle");
  });
});

// ── createActivityTracker container ────────────────────────

describe("createActivityTracker — per-member Map container", () => {
  it("lazily initializes per member; getActivity returns undefined for unknown members", () => {
    const tracker = createActivityTracker();
    expect(tracker.getActivity("coder")).toBeUndefined();
    tracker.onEvent("coder", ev.agentStart());
    expect(tracker.getActivity("coder")?.phase).toBe("thinking");
    expect(tracker.getActivity("analyst")?.phase).toBeUndefined();
  });

  it("onEvent is the single entry; getActivity derives phase with staleness at READ time (lazy, D3)", () => {
    const tracker = createActivityTracker();
    tracker.onEvent("coder", { type: "agent_start" });
    tracker.onEvent("coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
    // Read far beyond the last delta → stale downgrade, without any event in between.
    expect(tracker.getActivity("coder", Date.now() + STALE_AFTER_MS + 1000)?.phase).toBe("working");
    // Read with the current time → fresh thinking.
    expect(tracker.getActivity("coder")?.phase).toBe("thinking");
  });

  it("members are isolated: events for one member never affect another", () => {
    const tracker = createActivityTracker();
    tracker.onEvent("a", ev.agentStart());
    tracker.onEvent("b", ev.agentStart());
    tracker.onEvent("a", ev.toolStart("bash -c make"));
    expect(tracker.getActivity("a")?.phase).toBe("executing");
    expect(tracker.getActivity("b")?.phase).toBe("thinking");
  });

  it("getActivities returns the current snapshot", () => {
    const tracker = createActivityTracker();
    tracker.onEvent("a", ev.agentStart());
    tracker.onEvent("b", ev.agentStart());
    expect([...tracker.getActivities(1001).keys()].sort()).toEqual(["a", "b"]);
  });

  it("delete removes a single member; clear empties the whole map (uninstall path)", () => {
    const tracker = createActivityTracker();
    tracker.onEvent("a", ev.agentStart());
    tracker.onEvent("b", ev.agentStart());
    tracker.delete("a");
    expect(tracker.getActivity("a")).toBeUndefined();
    expect(tracker.getActivity("b")?.phase).toBe("thinking");
    tracker.clear();
    expect(tracker.getActivity("b")).toBeUndefined();
    expect(tracker.size).toBe(0);
  });
});

// ── N5: performance discipline locks ───────────────────────

describe("N5 — O(1) event-path discipline", () => {
  it("ignored events return the SAME object identity — zero allocation on the hot path", () => {
    const state = run(1000, ev.agentStart(), ev.msgUpdate("thinking_delta"));
    const before = state;
    expect(applyActivityEvent(state, { type: "process_exit", memberName: "m", exitCode: 1 }, 5000)).toBe(before);
    expect(applyActivityEvent(state, { type: "message_update" }, 5000)).toBe(before);
    expect(applyActivityEvent(state, { type: "response" }, 5000)).toBe(before);
  });

  it("module has no TUI/pi imports (pure module, standalone-runnable)", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "activity-tracker.ts"),
      "utf8"
    );
    // No import statements from any @earendil-works package (pi / pi-tui / theme).
    expect(source.match(/^\s*import\s+.*from\s+["']@earendil-works/s)).toBeNull();
  });
});
