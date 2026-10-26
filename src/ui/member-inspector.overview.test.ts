import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemberInspectorState } from "./member-inspector-state";
import { MemberInspectorComponent } from "./member-inspector";

const members = [{ name: "a", label: "分析员" }, { name: "b", label: "编码员" }];
const keys = { left: "\x1b[D", right: "\x1b[C", down: "\x1b[B", enter: "\r" };
function setup(names = members, isCompacting?: (name: string) => boolean) {
  const handles = new Map(names.map(m => [m.name, {
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn(async (cmd: any) => ({ success: true, data: cmd.type === "get_session_stats" ? { contextUsage: { percent: 42, tokens: 420, contextWindow: 1000 } } : { entries: [], leafId: null } })),
  }]));
  const state = new MemberInspectorState(names);
  const deps = { getMembers: () => names, getHandle: (name: string) => handles.get(name) as any, memberOpsStates: new Map(names.map(m => [m.name, "working" as const])), getRecentActions: () => [{ id: 1, kind: "read" as const, status: "done" as const }], getActionCount: undefined as ((name: string) => number) | undefined, isCompacting };
  const tui = { requestRender: vi.fn() };
  const comp = new MemberInspectorComponent(tui, { fg: (_: string, s: string) => s, bold: (s: string) => s }, vi.fn(), deps, state);
  return { comp, state, handles, deps, tui };
}

describe("Member Inspector overview integration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("defaults to overview without loading any conversation; arrows include overview", async () => {
    const { comp, state, handles } = setup();
    expect(state.view).toEqual({ kind: "overview" });
    expect(state.activeTab).toBeUndefined();
    comp.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(comp.render(100).join("\n")).toContain("总览");
    expect(comp.render(100).join("\n")).toContain("📖");
    for (const h of handles.values()) expect(h.sendCommandAndWait.mock.calls.every(([c]) => c.type === "get_session_stats")).toBe(true);
    comp.handleInput(keys.left);
    expect(state.activeTab?.name).toBe("b");
    comp.handleInput(keys.right);
    expect(state.view).toEqual({ kind: "overview" });
    comp.handleInput(keys.down);
    expect(state.selectedName).toBe("b");
    comp.handleInput(keys.enter);
    expect(state.activeTab?.name).toBe("b");
    expect(state.inputOpen).toBe(false);
    comp.handleInput(keys.enter);
    expect(state.inputOpen).toBe(true);
    comp.close();
  });

  it("renders the compact overview without table headings, a status text column, or icon legends", async () => {
    const { comp } = setup();
    await (comp as any).pollStats();
    const lines = comp.render(100);
    expect(lines[3]).toContain("分析员");
    expect(lines[4]).toContain("编码员");
    const joined = lines.join("\n");
    expect(joined).toContain("[████░░░░░░] 42%");
    expect(joined).toContain("ctrl+b 全部中断");
    expect(joined).not.toMatch(/当前状态|上下文|最近操作|工作中|📖读取|💭思考|✏️输出|📝修改|🔧工具/);
    comp.close();
  });

  it("keeps the hidden counter growing beyond 45 with a bounded 64-entry history", async () => {
    const { comp, deps, tui } = setup();
    deps.getRecentActions = () => Array.from({ length: 64 }, (_, id) => ({ id, kind: "read" as const, status: "done" as const }));
    let total = 64;
    deps.getActionCount = () => total;
    expect(comp.render(200)[3]).toContain("(45)");
    comp.onMemberEvent("a", { type: "tool_execution_end" });
    await vi.advanceTimersByTimeAsync(600);
    const rendered = tui.requestRender.mock.calls.length;
    total = 65;
    comp.onMemberEvent("a", { type: "tool_execution_end" });
    await vi.advanceTimersByTimeAsync(600);
    expect(tui.requestRender.mock.calls.length).toBeGreaterThan(rendered);
    expect(comp.render(200)[3]).toContain("(46)");
    total = 120;
    expect(comp.render(200)[3]).toContain("(101)");
    comp.close();
  });

  it("shows confirmed compaction only, not the dispatch preflight reservation", () => {
    let compacting = false;
    const { comp, deps } = setup(members, () => compacting);
    deps.memberOpsStates.set("a", "compacting" as any);
    expect(comp.render(100)[3]).not.toContain("🗜️");
    expect(comp.render(100)[3]).toContain("✅");
    compacting = true;
    expect(comp.render(100)[3]).toContain("🗜️");
    // Manual/member-side compaction may be real while the control map is idle.
    deps.memberOpsStates.set("a", "idle" as any);
    expect(comp.render(100)[3]).toContain("🗜️");
    // Process death remains authoritative over a late compaction observation.
    deps.memberOpsStates.set("a", "crashed" as any);
    expect(comp.render(100)[3]).toContain("💥");
    expect(comp.render(100)[3]).not.toContain("🗜️");
    compacting = false;
    deps.memberOpsStates.set("a", "idle" as any);
    expect(comp.render(100)[3]).not.toContain("🗜️");
    comp.close();
  });

  it("fetches history icons for every visible member and pages by the full headerless height", () => {
    const names = Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` }));
    const { comp, state, deps } = setup(names);
    const getActions = vi.fn(deps.getRecentActions);
    deps.getRecentActions = getActions;
    const oldRows = process.stdout.rows;
    try {
      process.stdout.rows = 24; // 20 overlay lines minus seven chrome lines = 13 member rows.
      const lines = comp.render(100);
      expect(getActions).toHaveBeenCalledTimes(13);
      expect(lines[15]).toContain("成员12");
      expect(lines[15]).toContain("📖");
      comp.handleInput("\x1b[6~");
      expect(state.selectedName).toBe("m13");
      expect(comp.render(100).join("\n")).toContain("› 成员13");
    } finally {
      if (oldRows === undefined) delete (process.stdout as any).rows;
      else process.stdout.rows = oldRows;
      comp.close();
    }
  });

  it("overview cannot send single-member controls or toggle conversation modes", () => {
    const { comp, state, handles } = setup();
    for (const key of ["i", "\x01", "\x0f"]) {
      comp.handleInput(key);
      expect(state.notice).toContain("进入成员会话");
      expect(comp.render(100).join("\n")).toContain(state.notice);
    }
    comp.handleInput("e"); comp.handleInput("t");
    expect(state.expanded).toBe(false); expect(state.showThinking).toBe(false);
    for (const h of handles.values()) expect(h.sendCommand).not.toHaveBeenCalled();
    comp.handleInput("\x02");
    for (const h of handles.values()) expect(h.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    comp.close();
  });

  it("immediately polls stats at most four concurrently and stops requeue after close", async () => {
    const { comp, handles } = setup(Array.from({ length: 9 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` })));
    const releases: (() => void)[] = [];
    let active = 0; let peak = 0;
    for (const h of handles.values()) h.sendCommandAndWait.mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--; return { success: true, data: { contextUsage: { percent: 42 } } } as any;
    });
    comp.start();
    expect(active).toBe(4);
    for (let batch = 0; batch < 3; batch++) {
      releases.splice(0).forEach(resolve => resolve());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(peak).toBe(4);
    expect([...handles.values()].reduce((n,h) => n+h.sendCommandAndWait.mock.calls.length,0)).toBe(9);
    comp.close();
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains stale stats with ~, rejects removed/replaced handles and uses ? for null", async () => {
    const { comp, state, handles, tui } = setup();
    await (comp as any).pollStats();
    expect(comp.render(100).join("\n")).toContain("42%");
    const renders = tui.requestRender.mock.calls.length;
    await (comp as any).pollStats();
    expect(tui.requestRender).toHaveBeenCalledTimes(renders); // unchanged snapshot, no redraw
    handles.get("a")!.sendCommandAndWait.mockRejectedValueOnce(new Error("timeout"));
    await (comp as any).pollStats();
    expect(comp.render(100).join("\n")).toContain("~42%");
    handles.get("a")!.sendCommandAndWait.mockResolvedValueOnce({ data: { contextUsage: { percent: null } } } as any);
    await (comp as any).pollStats();
    expect(state.tabs[0].contextInfo?.percent).toBeNull();
    expect(comp.render(100).join("\n")).not.toContain("0%");
    const old = state.tabs[0].contextInfo;
    handles.get("a")!.sendCommandAndWait.mockImplementationOnce(async () => {
      handles.set("a", { sendCommand: vi.fn(), sendCommandAndWait: vi.fn() } as any);
      return { data: { contextUsage: { percent: 99 } } } as any;
    });
    await (comp as any).pollStats();
    expect(state.tabs[0].contextInfo).toBe(old);
    comp.close();
  });

  it("preserves notice and new-below without a status footer; frame fits seven-line chrome and tiny sizes", () => {
    const { comp, state } = setup();
    state.openMember("a");
    state.tabs[0].newBelow = true;
    state.notice = "✓ 已发送";
    expect(comp.render(100).join("\n")).toContain("✓ 已发送");
    expect(comp.render(100).join("\n")).toContain("↓ 有更新");
    expect(comp.render(100).join("\n")).not.toContain("💭 分析员");
    const oldRows = process.stdout.rows;
    try {
      for (const rows of [3, 5, 8, 10, 24]) for (const width of [1, 2, 5, 18, 80]) {
        process.stdout.rows = rows;
        const lines = comp.render(width);
        expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * .85));
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        if (width >= 2 && lines.length >= 2) expect(lines.at(-1)).toContain("╯");
        if (width >= 18 && lines.length < 7) expect(lines.join("\n")).toContain("Esc");
      }
    } finally { if (oldRows === undefined) delete (process.stdout as any).rows; else process.stdout.rows = oldRows; }
    comp.close();
  });

  it.each([9, 10])("keeps the selected overview member and context visible at terminal rows=%i", (rows) => {
    const { comp, state } = setup();
    state.tabs[0].contextInfo = { percent: 42, tokens: 420, contextWindow: 1000 };
    state.tabs[1].contextInfo = { percent: 73, tokens: 730, contextWindow: 1000 };
    const oldRows = process.stdout.rows;
    try {
      process.stdout.rows = rows;
      const lines = comp.render(100);
      const joined = lines.join("\n");
      expect(joined).toContain("分析员");
      expect(joined).toContain("💭");
      expect(joined).not.toContain("工作中");
      expect(joined).toContain("42%");
      expect(joined).toContain("Esc 关闭");
      expect(lines[0]).toMatch(/^╭/);
      expect(lines.at(-1)).toMatch(/╯$/);
      expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * .85));
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
      comp.handleInput(keys.down);
      const selected = comp.render(100).join("\n");
      expect(selected).toContain("编码员");
      expect(selected).toContain("73%");
    } finally {
      if (oldRows === undefined) delete (process.stdout as any).rows;
      else process.stdout.rows = oldRows;
      comp.close();
    }
  });

  it("coalesces 24-member delta storms without history RPC or redundant render requests", async () => {
    const { comp, handles, tui, deps } = setup(Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` })));
    const actions = vi.fn(deps.getRecentActions);
    deps.getRecentActions = actions;
    for (const name of handles.keys()) for (let i = 0; i < 500; i++) {
      comp.onMemberEvent(name, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想" } });
    }
    await vi.advanceTimersByTimeAsync(600);
    const rendered = tui.requestRender.mock.calls.length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(2);
    for (const name of handles.keys()) comp.onMemberEvent(name, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想" } });
    await vi.advanceTimersByTimeAsync(600);
    expect(tui.requestRender).toHaveBeenCalledTimes(rendered);
    for (const h of handles.values()) expect(h.sendCommandAndWait).not.toHaveBeenCalled();
    actions.mockClear();
    comp.render(100);
    expect(actions.mock.calls.length).toBeLessThanOrEqual(13); // Every body line is now a member row.
    comp.handleInput("\x1b[F");
    expect(comp.render(100).join("\n")).toContain("成员23");
    comp.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not commit or launch more stats after close while four requests are in flight", async () => {
    const { comp, state, handles, tui } = setup(Array.from({ length: 9 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` })));
    const releases: (() => void)[] = [];
    for (const h of handles.values()) h.sendCommandAndWait.mockImplementation(async () => {
      await new Promise<void>(resolve => releases.push(resolve));
      return { data: { contextUsage: { percent: 77 } } } as any;
    });
    comp.start();
    expect(releases).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(6000);
    expect(releases).toHaveLength(4); // no overlapping poll
    comp.close();
    const rendered = tui.requestRender.mock.calls.length;
    releases.forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(10000);
    expect(state.tabs.every(tab => tab.contextInfo === null)).toBe(true);
    expect(tui.requestRender).toHaveBeenCalledTimes(rendered);
    expect([...handles.values()].reduce((n, h) => n + h.sendCommandAndWait.mock.calls.length, 0)).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects stale stats for removed members, marks missing usage stale, and recovers on success", async () => {
    const names = [...members];
    const { comp, state, handles, deps } = setup(names);
    await (comp as any).pollStats();
    const a = state.tabs[0];
    handles.get("a")!.sendCommandAndWait.mockResolvedValueOnce({ data: {} } as any);
    await (comp as any).pollStats();
    expect(a.contextStale).toBe(true);
    await (comp as any).pollStats();
    expect(a.contextStale).toBe(false);
    handles.get("a")!.sendCommandAndWait.mockImplementationOnce(async () => {
      names.splice(0, 1);
      return { data: { contextUsage: { percent: 99 } } } as any;
    });
    await (comp as any).pollStats();
    expect(a.contextInfo?.percent).toBe(42);
    deps.memberOpsStates.set("b", "stopped" as any);
    expect(comp.render(100).join("\n")).not.toContain("42%");
    comp.close();
  });

  it("reserves new-below before hints and clips only stale-width visible history on resize", async () => {
    const { comp, state, handles } = setup();
    state.openMember("a");
    handles.get("a")!.sendCommandAndWait.mockResolvedValue({ data: { messages: [{ role: "user", content: "很长的会话".repeat(100) }] } } as any);
    comp.render(140);
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    state.tabs[0].newBelow = true;
    state.notice = "发送结果".repeat(50);
    const smaller = comp.render(60);
    expect(smaller.join("\n")).toContain("↓ 有更新");
    for (const line of smaller) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    state.openInput();
    expect(comp.render(60).join("\n")).toContain("↓ 有更新");
    comp.close();
  });

  it("keeps page identity through additions/removals and empty teams", () => {
    const state = new MemberInspectorState(members);
    state.moveOverviewSelection(1, 2);
    state.openMember("b");
    state.syncMembers([{ name: "z", label: "新增" }, ...members]);
    expect(state.activeTab?.name).toBe("b");
    state.syncMembers([members[0]]);
    expect(state.view).toEqual({ kind: "overview" });
    expect(state.selectedName).toBe("a");
    state.syncMembers([]);
    state.switchTab(1);
    expect(state.view).toEqual({ kind: "overview" });
    const { comp } = setup([]);
    comp.handleInput(keys.enter);
    expect(comp.render(80).join("\n")).toContain("暂无成员");
    comp.close();
  });
});
