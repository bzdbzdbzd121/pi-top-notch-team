import { describe, expect, it, vi } from "vitest";
import { createMemberOverviewStore } from "./member-overview-store.js";

const delta = (type: string, contentIndex = 0, extra: object = {}) => ({
  type: "message_update", assistantMessageEvent: { type, contentIndex, ...extra },
});
const tool = (type: string, toolCallId?: string, toolName = "read", extra: object = {}) =>
  ({ type: `tool_execution_${type}`, toolCallId, toolName, ...extra });

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
    const s = createMemberOverviewStore();
    expect(s.onEvent("a", delta("toolcall_start"))).toBe(false);
    expect(s.onEvent("a", delta("toolcall_end", 0, { toolCall: { id: "t1", name: "read", arguments: { secret: "private" } } }))).toBe(true);
    const id = s.getRecentActions("a")[0].id;
    expect(s.getRecentActions("a")[0].kind).toBe("tool");
    expect(s.onEvent("a", tool("start", "t1"))).toBe(true);
    expect(s.getRecentActions("a")[0]).toEqual({ id, kind: "read", status: "active", toolName: "read" });
    expect(s.onEvent("a", tool("update", "t1", "read", { partialResult: "private" }))).toBe(false);
    expect(s.onEvent("a", tool("end", "t1", "read", { isError: true, result: "private" }))).toBe(true);
    expect(s.onEvent("a", { type: "message_end", message: { role: "toolResult", toolCallId: "t1", isError: true } })).toBe(false);
    expect(s.getRecentActions("a")).toEqual([{ id, kind: "read", status: "error", toolName: "read" }]);
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

  it("process death closes active actions, deduplicates error+exit, and restart preserves history but resets IDs", () => {
    const s = createMemberOverviewStore();
    s.onEvent("a", tool("start", "same"));
    s.onEvent("a", { type: "process_error", error: "private" });
    expect(s.onEvent("a", { type: "process_exit", exitCode: 1 })).toBe(false);
    expect(s.onEvent("a", delta("text_delta"))).toBe(false);
    expect(s.getRecentActions("a").map(a => [a.kind, a.status])).toEqual([["read", "error"], ["crashed", "error"]]);
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
