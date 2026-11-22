import { describe, expect, it, vi } from "vitest";
import { createMemberOverviewStore } from "./member-overview-store.js";

const delta = (type: string, contentIndex = 0, extra: object = {}) => ({
  type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra },
});
const tool = (type: string, toolCallId?: string, toolName = "read", extra: object = {}) =>
  ({ type: `tool_execution_${type}`, toolCallId, toolName, ...extra });
/** Injected clock: every timestamp assertion below is deterministic. */
const fakeClock = (start = 1_000) => {
  let now = start;
  return {
    now: () => now,
    set: (value: number) => { now = value; },
  };
};

describe("member overview store", () => {
  it("agent_start does not fabricate thinking; ignores bad/unknown events", () => {
    const s = createMemberOverviewStore();
    for (const e of [null, {}, { type: "unknown" }, { type: "agent_start" }, delta("thinking_delta", -1), delta("text_start", NaN)])
      expect(s.onEvent("a", e)).toBe(false);
    expect(s.getRecentActions("a")).toEqual([]);
  });

  it("records once per block, repairs missing start, and ends only that block", () => {
    const s = createMemberOverviewStore();
    expect(s.onEvent("a", delta("thinking_delta"))).toBe(true);
    for (let i = 0; i < 1000; i++) expect(s.onEvent("a", delta("thinking_delta"))).toBe(false);
    expect(s.onEvent("a", delta("text_start", 1))).toBe(true);
    expect(s.onEvent("a", delta("thinking_end"))).toBe(true);
    expect(s.onEvent("a", delta("thinking_delta"))).toBe(false);
    expect(s.getRecentActions("a").map(a => [a.kind, a.status])).toEqual([["thinking", "done"], ["output", "active"]]);
    s.onEvent("a", delta("text_start", 2));
    expect(s.getRecentActions("a")).toHaveLength(3);
  });

  it("message generation scopes indices and message_end blocks late delta", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", { type: "message_start", message: { role: "assistant" } });
    s.onEvent("a", delta("text_start"));
    s.onEvent("a", { type: "message_end", message: { role: "assistant", content: [] } });
    expect(s.onEvent("a", delta("thinking_delta", 1))).toBe(false);
    s.onEvent("a", { type: "message_start", message: { role: "assistant" } });
    s.onEvent("a", delta("text_start"));
    expect(s.getRecentActions("a").map(a => a.status)).toEqual(["done", "active"]);
  });

  it("agent_end records one completion, closes active actions and gates late events until new run", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", delta("thinking_start"));
    expect(s.onEvent("a", { type: "agent_end" })).toBe(true);
    for (const e of [{ type: "agent_end" }, delta("text_delta"), tool("start", "late"), { type: "message_start" }])
      expect(s.onEvent("a", e)).toBe(false);
    expect(s.getRecentActions("a").map(a => [a.kind, a.status])).toEqual([["thinking", "done"], ["complete", "done"]]);
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", delta("thinking_start"));
    expect(s.getRecentActions("a")).toHaveLength(3);
  });

  it("updates generation → execution → failure in the same action ID, without storing parameters", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    expect(s.onEvent("a", delta("toolcall_start"))).toBe(false);
    expect(s.onEvent("a", delta("toolcall_end", 0, { toolCall: { id: "t1", name: "read", arguments: { secret: "private" } } }))).toBe(true);
    const id = s.getRecentActions("a")[0].id;
    expect(s.getRecentActions("a")[0].kind).toBe("tool");
    clock.set(1_100);
    expect(s.onEvent("a", tool("start", "t1"))).toBe(true);
    expect(s.getRecentActions("a")[0]).toEqual({ id, kind: "read", status: "active", toolName: "read", at: 1_000 });
    expect(s.onEvent("a", tool("update", "t1", "read", { partialResult: "private" }))).toBe(false);
    clock.set(1_200);
    expect(s.onEvent("a", tool("end", "t1", "read", { isError: true, result: "private" }))).toBe(true);
    expect(s.onEvent("a", { type: "message_end", message: { role: "toolResult", toolCallId: "t1", isError: true } })).toBe(false);
    expect(s.getRecentActions("a")).toEqual([{ id, kind: "read", status: "error", toolName: "read", at: 1_000, endedAt: 1_200 }]);
  });

  it("supports ID exposed on start/partial without retaining the original event", () => {
    const s = createMemberOverviewStore();
    const event = delta("toolcall_start", 0, { partial: { content: [{ type: "toolCall", id: "p", name: "write" }] } });
    s.onEvent("a", event);
    s.onEvent("a", tool("start", "p", "write"));
    expect(s.getRecentActions("a").map(a => a.kind)).toEqual(["modify"]);
  });

  it("keeps parallel tools and two successive reads separate", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", tool("start", "r1"));
    s.onEvent("a", tool("start", "r2"));
    s.onEvent("a", tool("end", "r2"));
    expect(s.getRecentActions("a").map(a => a.status)).toEqual(["active", "done"]);
    s.onEvent("a", tool("end", "r1"));
    expect(s.getRecentActions("a").map(a => a.kind)).toEqual(["read", "read"]);
  });

  it.each(["write", "edit", "bash", "custom"])("classifies %s by name, not arguments", name => {
    const s = createMemberOverviewStore();
    s.onEvent("a", tool("start", "x", name, { args: { command: "cat /secret" } }));
    expect(s.getRecentActions("a")[0].kind).toBe(["write", "edit"].includes(name) ? "modify" : "tool");
  });

  it("missing IDs record execution starts only; end/progress never guess association", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", delta("toolcall_start"));
    s.onEvent("a", delta("toolcall_delta"));
    s.onEvent("a", tool("update"));
    s.onEvent("a", tool("end"));
    expect(s.getRecentActions("a")).toEqual([]);
    s.onEvent("a", tool("start"));
    s.onEvent("a", tool("start"));
    s.onEvent("a", tool("end"));
    expect(s.getRecentActions("a")).toHaveLength(2);
  });

  it("does not index oversized IDs or retain oversized tool names", () => {
    const s = createMemberOverviewStore();
    const id = "a".repeat(2000);
    expect(s.onEvent("a", delta("toolcall_end", 0, { toolCall: { id, name: "read" } }))).toBe(false);
    s.onEvent("a", tool("start", id, "x".repeat(2000)));
    s.onEvent("a", tool("end", id));
    expect(s.getRecentActions("a")).toHaveLength(1);
    expect(s.getRecentActions("a")[0].toolName!.length).toBeLessThanOrEqual(80);
  });

  it("continues the cumulative count after history eviction without unbounded storage", () => {
    const s = createMemberOverviewStore();
    expect(s.getActionCount("a")).toBe(0);
    for (let i = 0; i < 1000; i++) {
      s.onEvent("a", tool("start", `read-${i}`));
      s.onEvent("a", tool("end", `read-${i}`));
    }
    expect(s.getRecentActions("a")).toHaveLength(64);
    expect(s.getActionCount("a")).toBe(1000);
    expect(s.getActionCount("b")).toBe(0);
  });

  it("counts semantic appends, not streaming deltas or result updates", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", delta("thinking_start"));
    for (let i = 0; i < 1000; i++) s.onEvent("a", delta("thinking_delta"));
    s.onEvent("a", delta("thinking_end"));
    expect(s.getActionCount("a")).toBe(1);
    s.onEvent("a", tool("start", "read"));
    s.onEvent("a", tool("start", "read"));
    s.onEvent("a", tool("end", "read", "read", { isError: true }));
    expect(s.getActionCount("a")).toBe(2);
    s.onEvent("a", { type: "compaction_start" });
    s.onEvent("a", { type: "compaction_end" });
    expect(s.getActionCount("a")).toBe(3);
  });

  it("preserves member totals across restart, but clears them on removal or session clear", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", tool("start", "first"));
    s.onEvent("a", { type: "process_exit", exitCode: 0 });
    s.onEvent("a", { type: "process_started" });
    s.onEvent("a", tool("start", "second"));
    s.onEvent("b", tool("start", "independent"));
    expect(s.getActionCount("a")).toBe(3);
    expect(s.getActionCount("b")).toBe(1);
    s.syncMembers(["a"]);
    expect(s.getActionCount("a")).toBe(3);
    expect(s.getActionCount("b")).toBe(0);
    s.clear();
    expect(s.getActionCount("a")).toBe(0);
  });

  it("stores at most 64 actions and bounds every correlation Map with eviction", () => {
    const s = createMemberOverviewStore();
    const set = Map.prototype.set;
    let largest = 0;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, k, v) {
      const result = set.call(this, k, v);
      largest = Math.max(largest, this.size);
      return result;
    });
    try {
      for (let i = 0; i < 2000; i++) {
        s.onEvent("a", delta("text_start", i));
        s.onEvent("a", tool("start", `t${i}`));
      }
    } finally { spy.mockRestore(); }
    expect(largest).toBeLessThanOrEqual(64);
    const before = s.getRecentActions("a");
    expect(before).toHaveLength(64);
    expect(before[0].id).toBeLessThan(before[63].id);
    expect(s.onEvent("a", tool("end", "t0"))).toBe(false);
    expect(s.onEvent("a", delta("text_delta", 0))).toBe(false);
    expect(s.getRecentActions("a")).toEqual(before);
  });

  it("evicted tool generation deltas cannot resurrect an old action", () => {
    const s = createMemberOverviewStore();
    for (let i = 0; i < 100; i++)
      s.onEvent("a", delta("toolcall_start", i, { toolCallId: `t${i}` }));
    expect(s.onEvent("a", delta("toolcall_delta", 0, { toolCallId: "t0" }))).toBe(false);
    expect(s.getRecentActions("a")).toHaveLength(64);
  });

  it("returns immutable snapshots and stores no body/result/raw RPC object", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", delta("text_start", 0, { content: "secret-body", delta: "secret-body" }));
    const snapshot = s.getRecentActions("a");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    s.onEvent("a", delta("text_end"));
    expect(snapshot[0].status).toBe("active");
    expect(JSON.stringify(s.getRecentActions("a"))).not.toContain("secret-body");
  });

  it("process death closes active actions and deduplicates error+exit; only a real restart revives the member", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", tool("start", "same"));
    s.onEvent("a", { type: "process_error", error: "private" });
    expect(s.onEvent("a", { type: "process_exit", exitCode: 1 })).toBe(false);
    expect(s.onEvent("a", delta("text_delta"))).toBe(false);
    expect(s.getRecentActions("a").map(a => [a.kind, a.status])).toEqual([["read", "error"], ["crashed", "error"]]);
    // A death-late agent_start from the dying process must not resurrect it.
    expect(s.onEvent("a", { type: "agent_start" })).toBe(false);
    expect(s.onEvent("a", tool("start", "same"))).toBe(false);
    expect(s.getTimelineInfo("a").openTurnStart).toBeUndefined();
    // The starter's process_started is the one legitimate revival edge.
    s.onEvent("a", { type: "process_started" });
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", tool("start", "same"));
    expect(s.getRecentActions("a")).toHaveLength(3);
    expect(s.getRecentActions("a")[2].status).toBe("active");
  });

  it.each([0, 143, null])("normal exit %s is stopped, not crashed", exitCode => {
    const s = createMemberOverviewStore();
    s.onEvent("a", { type: "process_exit", exitCode });
    expect(s.getRecentActions("a")[0]).toMatchObject({ kind: "stopped", status: "done" });
  });

  it("deduplicates compaction RPC and operational edges and suppresses compact agent_end completion", () => {
    const s = createMemberOverviewStore();
    expect(s.markCompacting("a", true)).toBe(true);
    expect(s.onEvent("a", { type: "compaction_start" })).toBe(false);
    s.onEvent("a", { type: "agent_start" });
    expect(s.onEvent("a", { type: "agent_end" })).toBe(false);
    expect(s.onEvent("a", { type: "compaction_end" })).toBe(true);
    expect(s.markCompacting("a", false)).toBe(false);
    expect(s.onEvent("a", { type: "compaction_end" })).toBe(false);
    expect(s.getRecentActions("a").map(a => [a.kind, a.status])).toEqual([["compacting", "done"]]);
    s.onEvent("a", { type: "auto_compaction_start" });
    s.onEvent("a", { type: "auto_compaction_end", errorMessage: "failure" });
    expect(s.getRecentActions("a")[1]).toMatchObject({ kind: "compacting", status: "error" });
  });

  it("compaction end before agent_end does not fabricate a normal completion", () => {
    const s = createMemberOverviewStore();
    s.markCompacting("a", true);
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", { type: "compaction_end" });
    expect(s.onEvent("a", { type: "agent_end" })).toBe(false);
    expect(s.getRecentActions("a").map(a => a.kind)).toEqual(["compacting"]);
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", { type: "agent_end" });
    expect(s.getRecentActions("a").map(a => a.kind)).toEqual(["compacting", "complete"]);
  });

  it.each([
    {}, { result: undefined }, { result: null }, { result: {} },
    { aborted: true }, { errorMessage: "Nothing to compact" },
    { result: { summary: "not committed" }, aborted: true },
  ])("does not invent an initial compaction from an unconfirmed end %j", fields => {
    const s = createMemberOverviewStore();
    s.onEvent("a", { type: "process_started" });
    expect(s.onEvent("a", { type: "compaction_end", ...fields })).toBe(false);
    expect(s.onEvent("a", { type: "auto_compaction_end", ...fields })).toBe(false);
    expect(s.getRecentActions("a")).toEqual([]);
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", delta("thinking_start"));
    expect(s.getRecentActions("a").map(action => action.kind)).toEqual(["thinking"]);
  });

  it("a successful result repairs a missed compaction start without inventing an active interval", () => {
    const s = createMemberOverviewStore();
    const event = { type: "compaction_end", result: { summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 5000 }, aborted: false };
    expect(s.onEvent("a", { type: "compaction_end" })).toBe(false);
    expect(s.onEvent("a", event)).toBe(true);
    expect(s.onEvent("a", event)).toBe(false);
    expect(s.getRecentActions("a")[0]).toMatchObject({ kind: "compacting", status: "done" });
  });

  it("keeps real started compactions and their failures even when the end has no result", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", { type: "compaction_start" });
    s.onEvent("a", { type: "compaction_end", aborted: true });
    expect(s.getRecentActions("a").map(action => [action.kind, action.status])).toEqual([["compacting", "error"]]);
  });

  it("tracks real compaction independently of stats and validates get_state confirmation", () => {
    const s = createMemberOverviewStore();
    expect(s.isCompacting("a")).toBe(false);
    s.onEvent("a", { type: "response", command: "get_session_stats", success: true, data: { isCompacting: true } });
    s.onEvent("a", { type: "response", command: "get_state", success: false, data: { isCompacting: true } });
    s.onEvent("a", { type: "response", command: "get_state", success: true, data: { isCompacting: "true" } });
    expect(s.getRecentActions("a")).toEqual([]);
    const state = (isCompacting: boolean) => ({ type: "response", command: "get_state", success: true, data: { isCompacting } });
    expect(s.onEvent("a", state(true))).toBe(true);
    expect(s.isCompacting("a")).toBe(true);
    expect(s.onEvent("a", state(true))).toBe(false);
    expect(s.onEvent("a", state(false))).toBe(true);
    expect(s.isCompacting("a")).toBe(false);
    expect(s.getRecentActions("a").map(action => [action.kind, action.status])).toEqual([["compacting", "done"]]);
    s.onEvent("a", { type: "compaction_start" });
    s.onEvent("a", { type: "process_started" });
    expect(s.isCompacting("a")).toBe(false);
    expect(s.getRecentActions("a").every(action => action.status !== "active")).toBe(true);
  });

  it("keeps confirmed compaction state after its trail entry is evicted and clears on exit", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", { type: "compaction_start" });
    for (let i = 0; i < 65; i++) s.onEvent("a", tool("start", `parallel-${i}`));
    expect(s.getRecentActions("a").some(action => action.kind === "compacting")).toBe(false);
    expect(s.isCompacting("a")).toBe(true);
    expect(s.onEvent("a", { type: "compaction_end" })).toBe(true);
    expect(s.isCompacting("a")).toBe(false);
    s.onEvent("a", { type: "compaction_start" });
    s.onEvent("a", { type: "process_exit", exitCode: 0 });
    expect(s.isCompacting("a")).toBe(false);
    s.clear();
    expect(s.isCompacting("a")).toBe(false);
  });

  it("syncMembers removes deleted members, keeps retained history; clear resets all", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", delta("text_start"));
    s.onEvent("b", delta("text_start"));
    s.syncMembers(["a", "c"]);
    expect(s.getRecentActions("a")).toHaveLength(1);
    expect(s.getRecentActions("b")).toEqual([]);
    expect(s.getRecentActions("c")).toEqual([]);
    s.clear();
    expect(s.getRecentActions("a")).toEqual([]);
  });
});

describe("member overview store timeline data (P1)", () => {
  it("stamps every record on arrival and gives point events a zero-length interval", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });

    // Records appended already terminal own exactly the cell at their start.
    expect(s.onEvent("a", { type: "agent_end" })).toBe(true);
    expect(s.getRecentActions("a")[0]).toEqual({ id: 1, kind: "complete", status: "done", at: 1_000, endedAt: 1_000 });
    clock.set(1_500);
    expect(s.onEvent("a", { type: "process_exit", exitCode: 0 })).toBe(true);
    expect(s.getRecentActions("a")[1]).toEqual({ id: 2, kind: "stopped", status: "done", at: 1_500, endedAt: 1_500 });
    clock.set(2_000);
    expect(s.onEvent("b", { type: "process_error" })).toBe(true);
    expect(s.getRecentActions("b")[0]).toEqual({ id: 3, kind: "crashed", status: "error", at: 2_000, endedAt: 2_000 });
    clock.set(2_500);
    expect(s.onEvent("c", { type: "compaction_end", result: { summary: "committed" } })).toBe(true);
    expect(s.getRecentActions("c")[0]).toEqual({ id: 4, kind: "compacting", status: "done", at: 2_500, endedAt: 2_500 });
  });

  it("writes an end time exactly once, even when the record transitions again", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    expect(s.onEvent("a", tool("start", "t1"))).toBe(true);
    clock.set(1_100);
    expect(s.onEvent("a", tool("end", "t1"))).toBe(true);
    clock.set(1_200);
    // A late toolResult upgrades the status but must never move the recorded end.
    expect(s.onEvent("a", { type: "message_end", message: { role: "toolResult", toolCallId: "t1", isError: true } })).toBe(true);
    expect(s.getRecentActions("a")[0]).toEqual({ id: 1, kind: "read", status: "error", toolName: "read", at: 1_000, endedAt: 1_100 });
    clock.set(1_300);
    expect(s.onEvent("a", tool("end", "t1"))).toBe(false);
    expect(s.getRecentActions("a")[0].endedAt).toBe(1_100);
  });

  it("clamps a backward clock jump without negative intervals, reordering, or lost events", () => {
    const clock = fakeClock(10_000_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", delta("thinking_start"));
    clock.set(10_000_000 - 3_600_000); // an hour backwards, e.g. an NTP correction
    expect(s.onEvent("a", delta("text_start", 1))).toBe(true);
    expect(s.onEvent("b", tool("start", "t"))).toBe(true);
    s.onEvent("a", delta("thinking_end"));
    s.onEvent("a", { type: "agent_end" });
    const [thinking, output] = s.getRecentActions("a");
    expect(thinking.at).toBe(10_000_000);
    expect(thinking.endedAt).toBe(10_000_000);
    expect(output.at - thinking.at).toBe(0);
    // One global clamp keeps cross-member order, not one clamp per member.
    expect(s.getRecentActions("b")[0].at).toBe(10_000_000);
    expect(s.getActionCount("a")).toBe(3);
    expect(s.getActionCount("b")).toBe(1);
    expect(s.getTimelineInfo("a").turns).toEqual([[10_000_000, 10_000_000]]);
    expect(s.getLastActivityAt()).toBe(10_000_000);
  });

  it("reports the observation horizon, truncation, and open turn", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    expect(s.getTimelineInfo("never-started")).toEqual({ truncated: false, turns: [] });

    s.onEvent("a", { type: "process_started" });
    expect(s.getTimelineInfo("a")).toEqual({ knownFrom: 1_000, truncated: false, turns: [] });
    clock.set(1_200);
    s.onEvent("a", tool("start", "r1"));
    expect(s.getTimelineInfo("a").knownFrom).toBe(1_000);
    expect(s.getTimelineInfo("a").truncated).toBe(false);

    // Overflow the bounded ring: the trusted horizon moves to the oldest survivor.
    for (let i = 0; i < 70; i++) s.onEvent("a", tool("start", `burst-${i}`));
    const info = s.getTimelineInfo("a");
    expect(s.getRecentActions("a")).toHaveLength(64);
    expect(s.getActionCount("a")).toBe(71);
    expect(info.truncated).toBe(true);
    expect(info.knownFrom).toBe(s.getRecentActions("a")[0].at);
    expect(info.knownFrom).toBe(1_200);

    // Keeping the member must not reset its evidence.
    s.syncMembers(["a"]);
    expect(s.getTimelineInfo("a")).toMatchObject({ knownFrom: 1_200, truncated: true });
  });

  it("keeps closed turn intervals ascending and bounded to the recent window", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    for (let i = 0; i < 20; i++) {
      clock.set(1_000 + i * 100);
      s.onEvent("a", { type: "agent_start" });
      clock.set(1_050 + i * 100);
      s.onEvent("a", { type: "agent_end" });
    }
    const info = s.getTimelineInfo("a");
    expect(info.turns).toHaveLength(16);
    expect(info.openTurnStart).toBeUndefined();
    expect(info.turns[15]).toEqual([2_900, 2_950]);
    for (let i = 1; i < info.turns.length; i++)
      expect(info.turns[i][0]).toBeGreaterThanOrEqual(info.turns[i - 1][1]);
  });

  it("closes the open turn and active records on process death, and does not resurrect them", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    s.onEvent("a", { type: "agent_start" });
    clock.set(1_100);
    s.onEvent("a", delta("thinking_start"));
    clock.set(1_400);
    s.onEvent("a", { type: "process_exit", exitCode: 1 });
    expect(s.getRecentActions("a")).toEqual([
      { id: 1, kind: "thinking", status: "error", at: 1_100, endedAt: 1_400 },
      { id: 2, kind: "crashed", status: "error", at: 1_400, endedAt: 1_400 },
    ]);
    const afterDeath = s.getTimelineInfo("a");
    expect(afterDeath).toEqual({ knownFrom: 1_000, truncated: false, turns: [[1_000, 1_400]] });
    clock.set(1_800);
    s.onEvent("a", { type: "process_started" });
    expect(s.getTimelineInfo("a")).toEqual({ knownFrom: 1_000, truncated: false, turns: [[1_000, 1_400]] });
  });

  it("re-opens cleanly after a turn whose end was never observed", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    s.onEvent("a", { type: "agent_start" });
    clock.set(1_500);
    s.onEvent("a", { type: "agent_start" });
    expect(s.getTimelineInfo("a").turns).toEqual([[1_000, 1_500]]);
    expect(s.getTimelineInfo("a").openTurnStart).toBe(1_500);
  });

  it("tracks the team-wide last activity for the frozen-window anchor", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    expect(s.getLastActivityAt()).toBeUndefined();
    s.onEvent("a", { type: "agent_start" }); // observation only, no record
    expect(s.getLastActivityAt()).toBeUndefined();
    clock.set(1_200);
    s.onEvent("a", delta("thinking_start"));
    expect(s.getLastActivityAt()).toBe(1_200);
    clock.set(1_400);
    s.onEvent("b", tool("start", "t"));
    expect(s.getLastActivityAt()).toBe(1_400);
    clock.set(1_600);
    s.onEvent("a", delta("thinking_end")); // the end extends the latest activity
    expect(s.getLastActivityAt()).toBe(1_600);
    clock.set(1_800);
    s.onEvent("a", { type: "agent_start" });
    expect(s.getLastActivityAt()).toBe(1_600);
    s.syncMembers(["a"]);
    expect(s.getLastActivityAt()).toBe(1_600);
    s.clear();
    expect(s.getLastActivityAt()).toBeUndefined();
  });

  it("does not open a never-closing turn for a death-late agent_start", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    s.onEvent("a", { type: "agent_start" });
    clock.set(1_500);
    s.onEvent("a", { type: "process_exit", exitCode: 1 });
    clock.set(2_000);
    expect(s.onEvent("a", { type: "agent_start" })).toBe(false);
    const info = s.getTimelineInfo("a");
    expect(info.openTurnStart).toBeUndefined();
    expect(info.turns).toEqual([[1_000, 1_500]]);
    expect(s.getActionCount("a")).toBe(1);
  });

  it("stamps a real compaction interval and closes it exactly once", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    expect(s.onEvent("a", { type: "compaction_start" })).toBe(true);
    clock.set(4_000);
    expect(s.onEvent("a", { type: "compaction_end" })).toBe(true);
    expect(s.getRecentActions("a")).toEqual([
      { id: 1, kind: "compacting", status: "done", at: 1_000, endedAt: 4_000 },
    ]);
    clock.set(5_000);
    expect(s.onEvent("a", { type: "compaction_end" })).toBe(false);
    expect(s.getRecentActions("a")[0]).toMatchObject({ at: 1_000, endedAt: 4_000 });
  });

  it("closes the open turn on process_error too", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    s.onEvent("a", { type: "agent_start" });
    clock.set(2_500);
    s.onEvent("a", { type: "process_error", error: "boom" });
    const info = s.getTimelineInfo("a");
    expect(info.openTurnStart).toBeUndefined();
    expect(info.turns).toEqual([[1_000, 2_500]]);
  });

  it("flips truncation exactly when the 65th record evicts the oldest", () => {
    const clock = fakeClock(1_000);
    const s = createMemberOverviewStore({ clock: clock.now });
    for (let index = 0; index < 64; index++) {
      clock.set(1_000 + index);
      s.onEvent("a", tool("start", `t${index}`));
    }
    expect(s.getRecentActions("a")).toHaveLength(64);
    expect(s.getTimelineInfo("a")).toMatchObject({ knownFrom: 1_000, truncated: false });
    clock.set(2_000);
    s.onEvent("a", tool("start", "t64"));
    const info = s.getTimelineInfo("a");
    expect(s.getRecentActions("a")).toHaveLength(64);
    expect(info.truncated).toBe(true);
    expect(info.knownFrom).toBe(1_001);
    expect(info.knownFrom).toBe(s.getRecentActions("a")[0].at);
  });

  it("returns immutable timeline snapshots", () => {
    const s = createMemberOverviewStore({ clock: fakeClock(1_000).now });
    s.onEvent("a", { type: "agent_start" });
    s.onEvent("a", { type: "agent_end" });
    const info = s.getTimelineInfo("a");
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(info.turns)).toBe(true);
    expect(Object.isFrozen(info.turns[0])).toBe(true);
    expect(Object.isFrozen(s.getTimelineInfo("absent"))).toBe(true);
  });

  it("falls back to the wall clock when no clock is injected", () => {
    const s = createMemberOverviewStore();
    const before = Date.now();
    s.onEvent("a", tool("start", "t"));
    const at = s.getRecentActions("a")[0].at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});
