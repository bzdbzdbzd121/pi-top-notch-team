import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { createTeamStatusWidget } from "./team-status-widget";
import { createActivityTracker } from "../channel/activity-tracker";
import type { TeamContext, MemberOperationalState } from "../session/context";

// Real terminal-width helpers: Chinese, emoji, ANSI and combining marks must
// obey the same width budget as production.
function harness(labels: string[], states: MemberOperationalState[], teamName = "开发团队") {
  vi.useFakeTimers();
  const members = labels.map((label, i) => ({ name: `m${i}`, label, systemPrompt: "test" }));
  const memberOpsStates = new Map(members.map((m, i) => [m.name, states[i]]));
  const tracker = createActivityTracker();
  const theme = { fg: (color: string, text: string) => `\x1b[${color === "warning" ? 33 : 36}m${text}\x1b[0m` };
  let component: { render(width: number): string[]; invalidate(): void };
  const setWidget = vi.fn((_key: string, content: any) => {
    if (typeof content === "function") component = content({}, theme);
    else component = { render: () => content ?? [], invalidate() {} };
  });
  const getHandle = vi.fn(() => ({
    sendCommandAndWait: async () => ({ data: { contextUsage: { percent: 42, tokens: 420, contextWindow: 1000 } } }),
  }));
  const widget = createTeamStatusWidget({
    teamName,
    getMembers: () => members,
    teamCtx: { getHandle } as unknown as TeamContext,
    memberOpsStates,
    activityTracker: tracker,
  });
  widget.install({ setWidget }, theme);
  return {
    widget, members, memberOpsStates, tracker, theme, setWidget,
    render: (width: number) => component.render(width),
    line: (width: number) => stripAnsi(component.render(width)[0]),
    invalidate: () => component.invalidate(),
  };
}

afterEach(() => vi.useRealTimers());

describe("team status single-line responsive layout", () => {
  it("uses one line without borders, English banners, totals or summary counts", () => {
    const h = harness(["分析", "开发"], ["idle", "working"]);
    const line = h.line(120);
    expect(h.render(120)).toHaveLength(1);
    expect(line).toContain("👤 开发团队");
    expect(line).toContain("💭 开发");
    expect(line).toContain("✅ 分析");
    expect(line).not.toMatch(/TEAM MODE|┌|└|人数|\d+人|运行\d|空闲\d/);
  });

  it("keeps zero-member design mode to one line too", () => {
    const h = harness([], []);
    expect(h.render(80)).toHaveLength(1);
    expect(h.line(80)).toContain("设计阶段");
    expect(h.line(80)).not.toMatch(/0人|尚无成员/);
  });

  it("ranks crashes before running/compacting, then idle/stopped, stable within each group", () => {
    const h = harness(["闲甲", "忙甲", "停甲", "崩甲", "压甲", "忙乙", "崩乙"],
      ["idle", "working", "stopped", "crashed", "compacting", "working", "crashed"]);
    const line = h.line(200);
    const ordered = ["崩甲", "崩乙", "忙甲", "压甲", "忙乙", "闲甲", "停甲"];
    for (let i = 1; i < ordered.length; i++) {
      expect(line.indexOf(ordered[i])).toBeGreaterThan(line.indexOf(ordered[i - 1]));
    }
    h.widget.refresh();
    expect(h.line(200)).toBe(line);
  });

  it("shows the exact omitted count and only complete member entries", () => {
    const h = harness(["甲甲", "乙乙", "丙丙", "丁丁", "戊戊", "己己"],
      ["working", "working", "idle", "idle", "idle", "idle"]);
    const line = h.line(45);
    const shown = h.members.filter(m => line.includes(m.label));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(6);
    expect(line).toContain(`… 另${6 - shown.length}人`);
    expect(line).not.toMatch(/\s{2}(?:💭|✅)\s*…/);
    expect(visibleWidth(h.render(45)[0])).toBeLessThanOrEqual(45);
  });

  it("reflows on resize without a member event, refresh, or new widget registration", () => {
    const h = harness(["甲甲", "乙乙", "丙丙", "丁丁"], ["working", "working", "idle", "idle"]);
    const calls = h.setWidget.mock.calls.length;
    const wide = h.line(120);
    expect(wide).not.toContain("另");
    expect(h.line(40)).toMatch(/另\d人/);
    expect(h.line(120)).toBe(wide);
    h.invalidate();
    expect(h.line(120)).toBe(wide);
    expect(h.setWidget).toHaveBeenCalledTimes(calls);
  });

  it("does not reserve overflow space when all entries fit exactly", () => {
    const h = harness(["甲甲", "乙乙", "丙丙"], ["working", "working", "idle"]);
    const width = visibleWidth(h.render(120)[0]);
    expect(h.line(width)).not.toContain("另");
    expect(h.line(width - 1)).toContain("另");
    expect(visibleWidth(h.render(width)[0])).toBe(width);
  });

  it("reapplies the current factory theme on invalidation without re-registering", () => {
    const h = harness(["测试"], ["crashed"]);
    const before = h.render(80)[0];
    const calls = h.setWidget.mock.calls.length;
    h.theme.fg = (_color, text) => `\x1b[31m${text}\x1b[0m`;
    h.invalidate();
    expect(h.render(80)[0]).not.toBe(before);
    expect(stripAnsi(h.render(80)[0])).toBe(stripAnsi(before));
    expect(h.setWidget).toHaveBeenCalledTimes(calls);
  });

  it("promotes a previously hidden member when it crashes", () => {
    const h = harness(["忙甲", "闲甲", "闲乙", "闲丙", "测试"],
      ["working", "idle", "idle", "idle", "idle"]);
    expect(h.line(40)).not.toContain("测试");
    h.memberOpsStates.set("m4", "crashed");
    h.widget.onMemberEvent("m4", { type: "process_exit" });
    vi.advanceTimersByTime(300);
    expect(h.line(40)).toContain("💥 测试 —");
    expect(h.line(40).indexOf("测试")).toBeLessThan(h.line(40).indexOf("另"));
  });

  it("retains context percent in whole entries without adding a total", async () => {
    const h = harness(["编码"], ["working"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.line(80)).toContain("编码 42%");
    // Existing integration coverage checks percent:null → '?' as well.
    expect(h.line(80)).not.toContain("1人");
  });

  it("limits long names while retaining the icon and percent", async () => {
    const h = harness(["非常非常非常非常非常长的成员名称"], ["working"], "非常非常非常非常非常长的团队名称");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.line(80)).toContain("💭");
    expect(h.line(80)).toContain("… 42%");
    expect(h.line(80)).not.toContain(h.members[0].label);
    expect(visibleWidth(h.render(80)[0])).toBeLessThanOrEqual(80);
  });

  it("handles narrow widths, CJK, emoji, ANSI and combining marks without wrapping", async () => {
    const h = harness(["程序👩‍💻研发e\u0301", "分析🧑‍🔬", "全角ＡＢＣ", "文档"],
      ["crashed", "working", "compacting", "idle"], "中英Mixed👩‍💻团队名称");
    await vi.advanceTimersByTimeAsync(0);
    for (let width = 0; width <= 160; width++) {
      const lines = h.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0]), `width=${width}, line=${stripAnsi(lines[0])}`).toBeLessThanOrEqual(width);
      expect(stripAnsi(lines[0])).not.toMatch(/[\r\n\t]/);
      expect(stripAnsi(lines[0])).not.toMatch(/\uFFFD|\u200d(?:…|$)/u);
    }
  });

  it("does not allow newlines in names to create extra physical lines", () => {
    const h = harness(["分析\n成员\tA"], ["idle"], "团队\r\n名称");
    expect(h.line(100)).not.toMatch(/[\r\n\t]/);
  });
});
