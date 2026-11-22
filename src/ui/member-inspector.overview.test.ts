import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemberInspectorState } from "./member-inspector-state";
import { MemberInspectorComponent } from "./member-inspector";
import type { OverviewAction } from "./member-overview-store";

const members = [{ name: "a", label: "分析员" }, { name: "b", label: "编码员" }];
const keys = { left: "\x1b[D", right: "\x1b[C", down: "\x1b[B", enter: "\r" };
/** Colourless theme: no getColorMode/getFgAnsi → the timeline renders plain text. */
const PLAIN_THEME = { fg: (_: string, s: string) => s, bold: (s: string) => s };
/** Colour-capable theme: token ANSI comes from the palette, fg/bold stay plain. */
const COLOR_THEME = {
  ...PLAIN_THEME,
  getColorMode: () => "truecolor" as const,
  getFgAnsi: (token: string) => token === "syntaxType" ? "\x1b[38;2;7;7;7m" : undefined,
};
function setup(names = members, isCompacting?: (name: string) => boolean, theme: any = PLAIN_THEME) {
  const handles = new Map(names.map(m => [m.name, {
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn(async (cmd: any) => ({ success: true, data: cmd.type === "get_session_stats" ? { contextUsage: { percent: 42, tokens: 420, contextWindow: 1000 } } : { entries: [], leafId: null } })),
  }]));
  const state = new MemberInspectorState(names);
  const deps = {
    getMembers: () => names,
    getHandle: (name: string) => handles.get(name) as any,
    memberOpsStates: new Map(names.map(m => [m.name, "working" as const])),
    getRecentActions: (): readonly OverviewAction[] => [{ id: 1, kind: "read", status: "done", at: 0 }],
    isCompacting,
    getTimelineInfo: () => ({ truncated: false, turns: [] as (readonly [number, number])[] }),
    getLastActivityAt: undefined as (() => number | undefined) | undefined,
  };
  const tui = { requestRender: vi.fn() };
  const comp = new MemberInspectorComponent(tui, theme, vi.fn(), deps, state);
  return { comp, state, handles, deps, tui };
}
/** Lines of the rendered frame without ANSI, for content-based assertions. */
const plain = (lines: string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const emoji = /\p{Extended_Pictographic}/u;
/**
 * Land the fake clock on a 3 s boundary: a later "advance N ms" then crosses no
 * timeline tick unless the test advances past a full step on purpose.
 */
const atBoundary = (): number => {
  const aligned = Math.ceil(Date.now() / 3000) * 3000;
  vi.setSystemTime(aligned);
  return aligned;
};
/** The body row that belongs to one member (skips header/footer lines). */
const rowOf = (lines: string[], name: string): string =>
  plain(lines.slice(3).filter(line => line.includes(name)));

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
    const frame = plain(comp.render(100));
    expect(frame).toContain("分析员");
    expect(frame).not.toMatch(emoji);
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

  it("renders the axis first, then member rows, with no headings, emoji, or icon legend", async () => {
    const { comp } = setup();
    await (comp as any).pollStats();
    const lines = comp.render(100);
    // Body line 0 is the clock axis (§4.9); members follow.
    expect(plain([lines[3]!])).toContain("现在");
    expect(plain(lines)).toContain("分析员");
    expect(plain(lines)).toContain("编码员");
    const joined = plain(lines);
    expect(joined).toContain("[██░░] 42%");
    expect(joined).toContain("等待中");
    expect(joined).toContain("ctrl+b 全部中断");
    expect(joined).not.toMatch(/当前状态|上下文|最近操作|图标/);
    expect(joined).not.toMatch(emoji);
    comp.close();
  });

  it("repaints when the record sequence changes and never shows the old (N) counter", async () => {
    const { comp, deps, tui } = setup();
    let actions: OverviewAction[] = [{ id: 1, kind: "read", status: "done", at: 0 }];
    deps.getRecentActions = () => actions;
    comp.render(200);
    const rendered = tui.requestRender.mock.calls.length;
    actions = [...actions, { id: 2, kind: "modify", status: "done", at: 0 }];
    comp.onMemberEvent("a", { type: "tool_execution_end" });
    await vi.advanceTimersByTimeAsync(600);
    expect(tui.requestRender.mock.calls.length).toBeGreaterThan(rendered);
    const wide = plain(comp.render(200));
    expect(wide).not.toMatch(/\(\d+\)/);
    // Narrow screens fall back to the newest-first colour-block sequence.
    const narrow = plain(comp.render(30));
    expect(narrow).toContain("█");
    expect(narrow).not.toMatch(emoji);
    comp.close();
  });

  it("shows confirmed compaction only, not the dispatch preflight reservation", () => {
    let compacting = false;
    const { comp, deps } = setup(members, () => compacting);
    deps.memberOpsStates.set("a", "compacting" as any);
    // The reservation alone must not claim a real compaction: the row reads 空闲.
    expect(rowOf(comp.render(100), "分析员")).not.toContain("压缩中");
    expect(rowOf(comp.render(100), "分析员")).toContain("空闲");
    compacting = true;
    expect(rowOf(comp.render(100), "分析员")).toContain("压缩中");
    // Manual/member-side compaction may be real while the control map is idle.
    deps.memberOpsStates.set("a", "idle" as any);
    expect(rowOf(comp.render(100), "分析员")).toContain("压缩中");
    // Process death remains authoritative over a late compaction observation.
    deps.memberOpsStates.set("a", "crashed" as any);
    const crashed = rowOf(comp.render(100), "分析员");
    expect(crashed).toContain("已崩溃");
    expect(crashed).not.toContain("压缩中");
    compacting = false;
    deps.memberOpsStates.set("a", "idle" as any);
    expect(rowOf(comp.render(100), "分析员")).not.toContain("压缩中");
    comp.close();
  });

  it("collects exactly the visible members and pages by the shared capacity", () => {
    const names = Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` }));
    const { comp, state, deps } = setup(names);
    const getActions = vi.fn(deps.getRecentActions);
    deps.getRecentActions = getActions;
    const oldRows = process.stdout.rows;
    try {
      process.stdout.rows = 24; // 20 overlay lines − 7 chrome = 13 body lines = axis + 12 members.
      const lines = comp.render(100);
      expect(getActions).toHaveBeenCalledTimes(12);
      // The 12th member owns the last body line, i.e. the axis takes the first one.
      expect(plain([lines[3]!])).toContain("现在");
      const last = lines.slice(3).findIndex(line => plain([line]).includes("成员11"));
      expect(last).toBe(12); // body line 12 → the 12th member owns the last body line
      comp.handleInput("\x1b[6~");
      expect(state.selectedName).toBe("m12");
      expect(plain(comp.render(100))).toContain("› 成员12");
      // End scrolls the window so the final member stays visible and nothing overflows.
      comp.handleInput("\x1b[F");
      const bottom = plain(comp.render(100));
      expect(bottom).toContain("成员23");
      expect(state.selectedName).toBe("m23");
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
      const joined = plain(lines);
      expect(joined).toContain("分析员");
      expect(joined).toContain("等待中");
      expect(joined).toContain("42%");
      expect(joined).not.toMatch(emoji);
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
    atBoundary();
    const { comp, handles, tui, deps } = setup(Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` })));
    const actions = vi.fn(deps.getRecentActions);
    deps.getRecentActions = actions;
    comp.render(100); // the overlay is open and drawn before the storm
    for (const name of handles.keys()) for (let i = 0; i < 500; i++) {
      comp.onMemberEvent(name, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想" } });
    }
    await vi.advanceTimersByTimeAsync(600);
    const rendered = tui.requestRender.mock.calls.length;
    expect(rendered).toBeLessThanOrEqual(2); // Bounded: 12 000 deltas collapse to at most one frame.
    for (const name of handles.keys()) comp.onMemberEvent(name, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "想" } });
    await vi.advanceTimersByTimeAsync(600);
    expect(tui.requestRender).toHaveBeenCalledTimes(rendered);
    for (const h of handles.values()) expect(h.sendCommandAndWait).not.toHaveBeenCalled();
    // Liveness: a semantic record change still repaints immediately.
    let extra = false;
    const base = deps.getRecentActions;
    deps.getRecentActions = () => extra ? [...base(), { id: 9, kind: "read", status: "done", at: 1 }] : base();
    extra = true;
    comp.onMemberEvent("m0", { type: "tool_execution_end" });
    await vi.advanceTimersByTimeAsync(600);
    expect(tui.requestRender.mock.calls.length).toBeGreaterThan(rendered);
    actions.mockClear();
    comp.render(100);
    expect(actions.mock.calls.length).toBeLessThanOrEqual(12); // Every body line is a member row except the axis.
    comp.handleInput("\x1b[F");
    expect(plain(comp.render(100))).toContain("成员23");
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

describe("Member Inspector timeline wiring (P3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("puts the axis on the first body line and one member per remaining line", () => {
    const oldRows = process.stdout.rows;
    try {
      process.stdout.rows = 24; // 20 overlay lines − 7 chrome = 13 body lines
      const { comp } = setup();
      const lines = comp.render(100);
      const body = lines.slice(3, lines.length - 4);
      expect(body).toHaveLength(13);
      expect(plain([body[0]!])).toContain("现在");
      expect(plain([body[1]!])).toContain("分析员");
      expect(plain([body[2]!])).toContain("编码员");
      for (const line of lines) expect(visibleWidth(line)).toBe(100);
      // Body lines are `│` + 98 inner columns + `│`.
      for (const line of body) expect(visibleWidth(line.slice(1, -1))).toBe(98);
      comp.close();
    } finally {
      if (oldRows === undefined) delete (process.stdout as any).rows;
      else process.stdout.rows = oldRows;
    }
  });

  it("repaints on step boundaries while the overview is open, without any RPC", async () => {
    atBoundary();
    const { comp, tui, handles } = setup();
    comp.render(100); // inner 98 → lane 59 → 3 s per cell
    const before = tui.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const renders = tui.requestRender.mock.calls.length - before;
    // 60 s / 3 s = 20 boundaries; the alignment edge allows ±1.
    expect(renders).toBeGreaterThanOrEqual(19);
    expect(renders).toBeLessThanOrEqual(21);
    for (const h of handles.values()) expect(h.sendCommandAndWait).not.toHaveBeenCalled();
    comp.close();
  });

  it("does not repaint when neither the rows nor the anchor move", async () => {
    atBoundary();
    const { comp, tui } = setup();
    comp.render(100);
    const before = tui.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000); // still inside the same cell
    expect(tui.requestRender.mock.calls.length).toBe(before);
    (comp as any).refreshOverview(); // identical rows, identical anchor
    expect(tui.requestRender.mock.calls.length).toBe(before);
    comp.close();
  });

  it("stops repainting once the window is frozen (the tick keeps its own no-op)", async () => {
    atBoundary();
    const { comp, tui, deps } = setup();
    for (const name of deps.memberOpsStates.keys()) deps.memberOpsStates.set(name, "idle" as any);
    const lastActivity = Date.now() - 600_000; // a store watermark, not a moving clock
    deps.getLastActivityAt = () => lastActivity;
    comp.render(100);
    // Frozen: the right edge carries the last activity, not "now".
    expect(plain(comp.render(100))).not.toContain("现在");
    const before = tui.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tui.requestRender.mock.calls.length).toBe(before);
    comp.close();
  });

  it("stops the tick when leaving the overview and on close", async () => {
    atBoundary();
    const { comp, tui, state } = setup();
    comp.render(100);
    expect((comp as any).timelineTimer).not.toBeNull();
    comp.handleInput(keys.enter); // member page
    expect((comp as any).timelineTimer).toBeNull();
    comp.handleInput(keys.right); // member b
    comp.handleInput(keys.right); // cycles back to the overview
    expect(state.view).toEqual({ kind: "overview" });
    comp.render(100);
    expect((comp as any).timelineTimer).not.toBeNull();
    comp.close();
    expect((comp as any).timelineTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const rendered = tui.requestRender.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tui.requestRender.mock.calls.length).toBe(rendered);
  });

  it("writes the status word in both tiers, padded to the fixed field", () => {
    const { comp, deps } = setup(members, undefined, COLOR_THEME);
    // 3-char tier: 等待中 fills the 6-column field exactly.
    expect(plain(comp.render(100))).toContain("等待中 [");
    deps.memberOpsStates.set("a", "idle" as any);
    // 2-char word inside the same 6-column field → two padding spaces.
    expect(plain(comp.render(100))).toContain("空闲   [");
    // Fallback tier can only use the 2-char table.
    const narrow = plain(comp.render(30));
    expect(narrow).toContain("空闲");
    expect(narrow).not.toContain("等待中");
    comp.close();
  });

  it("colours the badge and the lane from the theme palette", () => {
    const { comp } = setup(members, undefined, COLOR_THEME);
    const frame = comp.render(100).join("\n");
    // waiting → busySilent → muted token is unavailable → fixed grey #808080.
    expect(frame).toContain("\x1b[38;2;128;128;128m等待中\x1b[39m");
    // unobserved cells → dim → fixed #666666.
    expect(frame).toContain("\x1b[38;2;102;102;102m░");
    // The colourless theme stays byte-clean (no escapes in the body).
    const plainComp = setup();
    expect(plainComp.comp.render(100).slice(3, -4).join("\n")).not.toContain("\x1b[");
    comp.close();
    plainComp.comp.close();
  });

  it("toggles the in-place colour legend with ? and restores the hint", () => {
    const { comp } = setup(members, undefined, COLOR_THEME);
    const before = comp.render(100);
    expect(plain(before)).toContain("? 颜色");
    comp.handleInput("?");
    const after = comp.render(100);
    // Same frame shape: the legend replaces the hint line, it does not add one.
    expect(after).toHaveLength(before.length);
    const footer = plain([after.at(-2)!]);
    expect(footer).toContain("思考");
    expect(footer).toContain("读取");
    expect(footer).toContain("空闲");
    expect(footer).not.toContain("ctrl+b 全部中断");
    // Each legend word carries its class colour (read → token syntaxType → #070707).
    expect(after.join("\n")).toContain("\x1b[38;2;7;7;7m读取\x1b[39m");
    comp.handleInput("?");
    expect(plain(comp.render(100))).toContain("ctrl+b 全部中断");
    comp.close();
  });

  it.each([
    ["legacy literal", "?"],
    ["kitty shift+? codepoint", "\x1b[63;2u"],
    ["kitty shift+/ base key", "\x1b[47;2u"],
    ["kitty shift+/ with press event", "\x1b[47;2:1u"],
    ["kitty plain ?", "\x1b[63u"],
    ["modifyOtherKeys shift+?", "\x1b[27;2;63~"],
    ["modifyOtherKeys shift+/ base key", "\x1b[27;2;47~"],
  ])("toggles the legend from %s", (_label, data) => {
    const { comp } = setup();
    comp.render(100);
    comp.handleInput(data);
    expect(plain(comp.render(100))).toContain("思考");
    comp.handleInput(data);
    expect(plain(comp.render(100))).not.toContain("思考");
    comp.close();
  });

  it("does not treat other printable keys as the legend key", () => {
    const { comp } = setup();
    comp.render(100);
    // Shift+H, a plain "/", ctrl/alt forms and the kitty release event must not toggle it.
    for (const data of ["\x1b[27;2;72~", "/", "\x1b[47u", "\x1b[47;5u", "\x1b[47;2:3u", "\x1b[63;2:3u"])
      comp.handleInput(data);
    expect(plain(comp.render(100))).toContain("ctrl+b 全部中断");
    comp.close();
  });

  it("adds no RPC of its own", async () => {
    atBoundary();
    const { comp, handles } = setup();
    comp.start();
    comp.render(100);
    await vi.advanceTimersByTimeAsync(10_000);
    comp.handleInput("?");
    comp.render(100);
    for (const handle of handles.values()) {
      for (const [command] of handle.sendCommandAndWait.mock.calls) expect(command.type).toBe("get_session_stats");
      expect(handle.sendCommand).not.toHaveBeenCalled();
    }
    comp.close();
  });
});

describe("Member Inspector timeline honesty (P4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  /** Lane part of a body row: drop the fixed-width context field. */
  const laneOf = (row: string): string => row.replace(/\[[█░·]{4}\] [^ ]{1,5}/u, "");
  const idleTeam = (deps: { memberOpsStates: Map<string, any> }) => {
    for (const name of deps.memberOpsStates.keys()) deps.memberOpsStates.set(name, "idle");
  };

  it("freezes an idle team at its last activity and says how long ago", () => {
    atBoundary();
    const { comp, deps } = setup();
    idleTeam(deps);
    deps.getLastActivityAt = () => Date.now() - 12 * 60_000;
    const frame = plain(comp.render(100));
    expect(frame).not.toContain("现在");
    expect(frame).toContain("停在 12 分钟前");
    expect(frame).toContain("ctrl+b 全部中断");
    comp.close();
  });

  it("returns to now as soon as a new record lands", () => {
    atBoundary();
    const { comp, deps } = setup();
    idleTeam(deps);
    let last = Date.now() - 12 * 60_000;
    deps.getLastActivityAt = () => last;
    expect(plain(comp.render(100))).toContain("停在 12 分钟前");
    last = Date.now();
    const frame = plain(comp.render(100));
    expect(frame).toContain("现在");
    expect(frame).not.toContain("停在");
    comp.close();
  });

  it("keeps a forward clock jump as a frozen past instead of a blank screen", () => {
    atBoundary();
    const { comp, deps } = setup();
    idleTeam(deps);
    const last = Date.now() - 3_600_000; // the activity is an hour behind the clock
    deps.getLastActivityAt = () => last;
    deps.getTimelineInfo = () => ({ knownFrom: last, truncated: false, turns: [] });
    deps.getRecentActions = () => [{ id: 1, kind: "read", status: "done", at: last }];
    const lines = comp.render(100);
    const frame = plain(lines);
    expect(frame).toContain("停在 60 分钟前");
    // The old activity is still visible: frozen at it, solid block in the last cell.
    expect(laneOf(rowOf(lines, "分析员"))).toContain("█");
    for (const line of lines) expect(visibleWidth(line)).toBe(100);
    comp.close();
  });

  it("does not paint a burst for stamps left in the future by a rollback", () => {
    atBoundary();
    const { comp, deps } = setup();
    const now = Date.now();
    deps.getTimelineInfo = () => ({ knownFrom: now - 200_000, truncated: false, turns: [] });
    deps.getRecentActions = () => [{ id: 1, kind: "read", status: "done", at: now + 3_600_000 }];
    const lines = comp.render(100);
    const lane = laneOf(rowOf(lines, "分析员"));
    expect(lane).not.toContain("█");
    expect(lane).not.toContain("▓");
    expect(plain(lines)).not.toMatch(/NaN/);
    comp.close();
  });

  it("stripes history we never observed and never invents idle time", () => {
    const { comp, deps } = setup();
    const now = Date.now();
    deps.getTimelineInfo = () => ({ knownFrom: now - 30_000, truncated: false, turns: [] });
    deps.getRecentActions = () => [];
    const lane = laneOf(rowOf(comp.render(100), "分析员"));
    expect(lane).toContain("░"); // left of the observation horizon
    expect(lane).not.toContain("█"); // and no fabricated activity
    comp.close();
  });

  it("renders a never-observed team as stripes without errors", () => {
    const { comp, deps } = setup();
    deps.getTimelineInfo = () => ({ truncated: false, turns: [] });
    deps.getLastActivityAt = () => undefined;
    deps.getRecentActions = () => [];
    const lines = comp.render(100);
    for (const line of lines) expect(visibleWidth(line)).toBe(100);
    for (const name of ["分析员", "编码员"]) {
      const lane = laneOf(rowOf(lines, name));
      expect(lane).toContain("░");
      expect(lane).not.toContain("█");
    }
    expect(plain(lines)).not.toMatch(/NaN|undefined/);
    comp.close();
  });

  it("ignores invalid timestamps coming from the store", () => {
    const { comp, deps } = setup();
    const now = Date.now();
    deps.getTimelineInfo = () => ({ knownFrom: now - 200_000, truncated: false, turns: [] });
    deps.getRecentActions = () => [
      { id: 1, kind: "read", status: "done", at: Number.NaN },
      { id: 2, kind: "modify", status: "done", at: Number.POSITIVE_INFINITY },
      { id: 3, kind: "tool", status: "done", at: -1 },
    ];
    const lines = comp.render(100);
    const lane = laneOf(rowOf(lines, "分析员"));
    expect(lane).not.toContain("█");
    expect(plain(lines)).not.toMatch(/NaN|Infinity/);
    for (const line of lines) expect(visibleWidth(line)).toBe(100);
    comp.close();
  });
});
