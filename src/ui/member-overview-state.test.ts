import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  buildInspectorHeader, buildOverviewLines, buildOverviewTrail,
  getOverviewWindowOffset, type OverviewRow,
} from "./member-overview-state";
import type { OverviewAction } from "./member-overview-store";

const row = (name: string, patch: Partial<OverviewRow> = {}): OverviewRow => ({
  name, label: name, state: "working", percent: 42, actions: [], ...patch,
});
const actions = (...kinds: OverviewAction["kind"][]): OverviewAction[] =>
  kinds.map((kind, id) => ({ id, kind, status: "done" }));
const plain = (rows: OverviewRow[], width = 100) =>
  buildOverviewLines(rows, undefined, 0, rows.length, width).map(stripAnsi);
const members = Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` }));
const icons = (text: string) => stripAnsi(text).match(/💭|✏️|📖|📝|🔧|✅|🗜️|💥|⏹️/gu) ?? [];

// Chronological storage stays oldest-first; only the display order changes.
describe("overview rows", () => {
  it("starts with a member row without a table header or a current-status text column", () => {
    const lines = plain([row("开发"), row("审查")]);
    expect(lines[0]).toContain("开发");
    expect(lines[1]).toContain("审查");
    expect(lines.join("\n")).not.toMatch(/成员 \d|当前状态|上下文|最近操作|工作中|思考中|执行工具/);
  });

  it("keeps roster order and emphasizes the selected name", () => {
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => `\x1b[1m${s}\x1b[22m` };
    const rows = [row("开发"), row("审查", { state: "crashed" }), row("测试", { state: "idle" })];
    const lines = buildOverviewLines(rows, "审查", 0, 5, 100, theme);
    expect(lines.map(stripAnsi).slice(0, 3).map(l => l.match(/开发|审查|测试/)?.[0])).toEqual(["开发", "审查", "测试"]);
    expect(lines[1]).toContain("› ");
    expect(lines[1]).toContain("\x1b[1m审查\x1b[22m");
    expect(lines).toHaveLength(5);
    expect(stripAnsi(lines[4]).trim()).toBe("");
  });

  it.each([
    [{ state: "compacting", phase: "executing" }, "🗜️"],
    [{ state: "crashed", phase: "executing" }, "💥"],
    [{ state: "stopped", phase: "thinking", started: false }, "⏹️"],
    [{ state: "stopped", started: true }, "⏹️"],
    [{ phase: "thinking" }, "💭"],
    [{ phase: "tool-calling" }, "🔧"],
    [{ phase: "executing" }, "🔧"],
    [{ phase: "output" }, "✏️"],
    [{ phase: "working" }, "💭"],
    [{ phase: "idle" }, "💭"],
    [{ state: "idle", phase: "executing" }, "✅"],
  ] as [Partial<OverviewRow>, string][])("uses the leftmost trail icon for current state %j", (patch, expected) => {
    const line = plain([row("成员", { actions: actions("read", "modify"), ...patch })])[0];
    expect(icons(line)[0]).toBe(expected);
    expect(line).not.toMatch(/压缩中|崩溃|未启动|已停止|思考中|准备调用|执行工具|输出中|工作中|空闲/);
  });

  it("uses the current active read as the leftmost status without duplicating that operation", () => {
    const line = plain([row("开发", {
      phase: "executing",
      actions: [{ id: 1, kind: "thinking", status: "done" }, { id: 2, kind: "read", status: "active" }],
    })])[0];
    expect(icons(line)).toEqual(["📖", "💭"]);
  });

  it("does not duplicate an authoritative idle marker already present in history", () => {
    const line = plain([row("开发", { state: "idle", actions: actions("read", "complete") })])[0];
    expect(icons(line)).toEqual(["✅", "📖"]);
  });

  it.each([
    [{ percent: null }, "?"], [{ percent: undefined }, "?"],
    [{ percent: 41.6 }, "42%"], [{ percent: 41.6, contextStale: true }, "~42%"],
    [{ percent: null, contextStale: true }, "?"],
    [{ state: "stopped", percent: 42 }, "—"], [{ state: "crashed", percent: 42 }, "—"],
  ] as [Partial<OverviewRow>, string][])("formats context honestly %j", (patch, expected) => {
    const line = plain([row("成员", patch)])[0];
    expect(line).toContain(` ${expected} `);
    if (patch.percent == null) expect(line).not.toContain("0%");
    if (patch.state === "stopped" || patch.state === "crashed") expect(line).not.toContain("42%");
  });

  it.each([
    [0, "[░░░░░░░░░░]"], [42, "[████░░░░░░]"],
    [75, "[████████░░]"], [100, "[██████████]"], [125, "[██████████]"],
  ])("draws a horizontal context bar for %i percent", (percent, bar) => {
    const line = plain([row("开发", { percent: percent as number })])[0];
    expect(line).toContain(bar as string);
    expect(line).toContain(`${percent}%`);
  });

  it("distinguishes unknown context from zero and retains the stale marker next to the bar", () => {
    const unknown = plain([row("开发", { percent: null })])[0];
    const zero = plain([row("开发", { percent: 0 })])[0];
    const stale = plain([row("开发", { percent: 42, contextStale: true })])[0];
    expect(unknown).toContain("[··········]");
    expect(unknown).toContain(" ? ");
    expect(unknown).not.toContain("0%");
    expect(zero).toContain("[░░░░░░░░░░]");
    expect(stale).toContain("[████░░░░░░]");
    expect(stale).toContain("~42%");
  });

  it("uses all body rows for members and scrolls selection into the window", () => {
    const rows = members.map(m => row(m.name));
    expect(getOverviewWindowOffset(rows, "m20", 0, 5)).toBe(16);
    expect(getOverviewWindowOffset(rows, "m2", 17, 5)).toBe(2);
    expect(getOverviewWindowOffset(rows, undefined, 999, 5)).toBe(19);
    expect(getOverviewWindowOffset(rows, undefined, -10, 5)).toBe(0);
    const window = buildOverviewLines(rows, "m20", 0, 5, 100).map(stripAnsi);
    expect(window[4]).toContain("› m20");
    expect(window.map(l => l.match(/m\d+/)?.[0])).toEqual(["m16", "m17", "m18", "m19", "m20"]);
    expect(buildOverviewLines([row("唯一成员")], undefined, 0, 1, 80)[0]).toContain("唯一成员");
  });

  it("handles empty members and tiny heights", () => {
    expect(buildOverviewLines([], undefined, 0, 0, 50)).toEqual([]);
    expect(buildOverviewLines([], undefined, 0, 1, 50).map(stripAnsi)[0]).toContain("暂无成员");
    expect(getOverviewWindowOffset([], undefined, 99, 0)).toBe(0);
  });

  it("distinguishes duplicate labels using identifiers even when labels are long", () => {
    const lines = plain([row("backend", { label: "开发" }), row("frontend", { label: "开发" })]);
    expect(lines[0]).toContain("backend");
    expect(lines[1]).toContain("frontend");
    const label = "这是非常非常长的重复成员名称";
    const long = plain([row("alpha", { label }), row("beta", { label })], 60);
    expect(long[0]).toContain("alpha");
    expect(long[1]).toContain("beta");
  });

  it("prioritizes current-state icon and usage on narrow screens", () => {
    const line = plain([row("a", { label: "非常非常非常长的成员名称", actions: actions("read", "modify", "tool") })], 24)[0];
    expect(line).toContain("42%");
    expect(icons(line)[0]).toBe("💭");
    expect(line).not.toContain("工作");
    expect(line).toContain("…");
  });

  it.each([16, 17])("visibly moves selection at width %i", width => {
    const rows = [row("甲"), row("乙")];
    const first = buildOverviewLines(rows, "甲", 0, 2, width).map(stripAnsi);
    const second = buildOverviewLines(rows, "乙", 0, 2, width).map(stripAnsi);
    expect(first).not.toEqual(second);
    expect(first[0]).toMatch(/^› /);
    expect(first[1]).toMatch(/^  /);
    expect(second[0]).toMatch(/^  /);
    expect(second[1]).toMatch(/^› /);
    expect(second[1]).toContain("42%");
    expect(second[1]).toContain("乙");
    for (const line of [...first, ...second]) expect(visibleWidth(line)).toBe(width);
  });

  it("retains the selection marker below the column budget", () => {
    const rows = [row("甲"), row("乙")];
    const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m` };
    for (let width = 1; width < 18; width++) {
      const lines = buildOverviewLines(rows, "乙", 0, 2, width, theme);
      expect(stripAnsi(lines[0]).startsWith("›")).toBe(false);
      expect(stripAnsi(lines[1]).startsWith("›"), `width=${width}`).toBe(true);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("limits the whole trail to 20 icons including current state and reports hidden records", () => {
    const history = actions(...Array.from({ length: 64 }, () => "read" as const));
    const line = plain([row("开发", { phase: "thinking", actions: history })], 200)[0];
    expect(icons(line)).toHaveLength(20);
    expect(icons(line)[0]).toBe("💭");
    expect(line).toContain("(45)"); // 19 historical records + one live status slot.
    const narrow = plain([row("开发", { phase: "thinking", actions: history })], 64)[0];
    const visibleHistory = icons(narrow).length - 1;
    expect(visibleHistory).toBeLessThan(19);
    expect(narrow).toContain(`(${64 - visibleHistory})`);
  });

  it("still hides the counter when all cumulatively counted records are visible", () => {
    const history = actions("read", "read", "modify", "tool", "output");
    const line = plain([row("开发员", { phase: "thinking", actions: history, actionCount: 5 })], 200)[0];
    expect(icons(line)).toHaveLength(6); // The synthetic current icon is not a record.
    expect(line).not.toMatch(/\(\d+\)/);
  });

  it.each([64, 65, 120, 1000])("uses cumulative action count %i rather than the 64 retained entries", actionCount => {
    const history = actions(...Array.from({ length: 64 }, () => "read" as const));
    const line = plain([row("开发员", { phase: "thinking", actions: history, actionCount })], 200)[0];
    expect(icons(line)).toHaveLength(20);
    expect(line).toContain(`(${actionCount - 19})`);
  });

  it.each([24, 32, 64, 100])("keeps a complete cumulative counter at width %i", width => {
    const history = actions(...Array.from({ length: 64 }, () => "read" as const));
    const line = plain([row("开发员", { phase: "thinking", actions: history, actionCount: 1000000 })], width)[0];
    const visibleRecords = icons(line).length - 1;
    expect(line).toContain(`(${1000000 - visibleRecords})`);
    expect(visibleWidth(line)).toBe(width);
  });

  it.each([undefined, NaN, -1, 1, Infinity])("falls back safely when cumulative count is invalid: %s", actionCount => {
    const history = actions(...Array.from({ length: 64 }, () => "read" as const));
    const line = plain([row("开发员", { phase: "thinking", actions: history, actionCount })], 200)[0];
    expect(line).toContain("(45)");
  });

  it.each([16, 18, 24, 32, 48, 64, 100])("reserves the overflow count instead of losing it at width %i", width => {
    const history = actions(...Array.from({ length: 64 }, () => "read" as const));
    const line = plain([row("开发员", { phase: "thinking", actions: history })], width)[0];
    const visibleHistory = icons(line).length - 1;
    expect(icons(line)[0]).toBe("💭");
    expect(line).toContain(`(${64 - visibleHistory})`);
    expect(line).toContain("42%");
    if (width >= 24) expect(line).toMatch(/\[[█░]+\]/);
    expect(visibleWidth(line)).toBe(width);
  });

  it("fits CJK, emoji, combining marks and ANSI at every width including zero", () => {
    const history = actions(...Array.from({ length: 64 }, (_, i) => i % 2 ? "output" : "compacting"));
    const rows = [row("a", { label: "\x1b[31m程序👩‍💻研发e\u0301\x1b[0m", actions: history }), row("b", { label: "全角ＡＢＣ\r\n\t成员", percent: null })];
    const theme = { fg: (_c: string, s: string) => `\x1b[36m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[22m` };
    for (let width = 0; width <= 160; width++) {
      const lines = buildOverviewLines(rows, "a", 0, 4, width, theme);
      expect(lines).toHaveLength(4);
      for (const line of lines) {
        expect(visibleWidth(line), `width=${width} ${stripAnsi(line)}`).toBe(width);
        expect(stripAnsi(line)).not.toMatch(/[\r\n\t]|\uFFFD|\u200d(?:…|$)/u);
      }
    }
  });
});

describe("newest-first action icons", () => {
  it("inserts new operations on the left without reversing the stored array", () => {
    const history = actions("thinking", "read", "read", "modify", "tool");
    expect(stripAnsi(buildOverviewTrail(history, 30))).toBe("🔧 📝 📖 📖 💭");
    expect(history.map(action => action.kind)).toEqual(["thinking", "read", "read", "modify", "tool"]);
    expect(stripAnsi(buildOverviewTrail(history, 8))).toBe("🔧 (4)");
    expect(buildOverviewTrail([], 10)).toBe("—");
    expect(buildOverviewTrail(actions("read"), 1)).toBe("");
  });

  it("caps history at 20 icons and counts both cap and width overflow", () => {
    const history = actions(...Array.from({ length: 25 }, () => "read" as const));
    const wide = stripAnsi(buildOverviewTrail(history, 200));
    expect(icons(wide)).toHaveLength(20);
    expect(wide).toMatch(/\(5\)$/);
    const narrow = stripAnsi(buildOverviewTrail(history, 20));
    expect(icons(narrow).length).toBeLessThan(20);
    expect(narrow).toMatch(new RegExp(`\\(${25 - icons(narrow).length}\\)$`));
    expect(stripAnsi(buildOverviewTrail(actions(...Array.from({ length: 20 }, () => "read" as const)), 200))).not.toMatch(/\(0\)/);
  });

  it("subtracts visible real records, including a reused current record, from the cumulative total", () => {
    const history = actions(...Array.from({ length: 64 }, () => "read" as const));
    const trail = stripAnsi(buildOverviewTrail(history, 200, undefined, undefined, 120));
    expect(icons(trail)).toHaveLength(20);
    expect(trail).toContain("(100)");
    const active = [...history.slice(0, -1), { id: 100, kind: "read" as const, status: "active" as const }];
    const line = plain([row("开发员", { phase: "executing", actions: active, actionCount: 120 })], 200)[0];
    expect(icons(line)).toHaveLength(20);
    expect(icons(line)[0]).toBe("📖");
    expect(line).toContain("(100)");
  });

  it("never splits an icon or overflow counter", () => {
    const history = actions("read", "output", "compacting");
    const valid = ["", "(3)", "🗜️", "🗜️ (2)", "🗜️ ✏️ 📖"];
    for (let width = 0; width <= 12; width++) {
      const trail = stripAnsi(buildOverviewTrail(history, width));
      expect(valid).toContain(trail);
      expect(visibleWidth(trail)).toBeLessThanOrEqual(width);
    }
    expect(stripAnsi(buildOverviewTrail(actions("complete", "crashed", "stopped"), 20))).toBe("⏹️ 💥 ✅");
  });

  it("underlines active/failed actions, without exposing tool names", () => {
    const theme = { fg: (c: string, s: string) => `\x1b[${c === "error" ? "31" : "36"}m${s}\x1b[0m` };
    const trail = buildOverviewTrail([
      { id: 1, kind: "read", status: "active", toolName: "secret-path" },
      { id: 2, kind: "modify", status: "error" },
      { id: 3, kind: "complete", status: "done" },
    ], 20, theme);
    expect(stripAnsi(trail)).toBe("✅ 📝 📖");
    expect(trail.match(/\x1b\[4m/g)).toHaveLength(2);
    expect(trail).toContain("\x1b[31m");
    expect(trail).not.toContain("secret-path");
  });
});

describe("horizontal inspector tab window", () => {
  it("pins overview and keeps the active member visible with hidden-side markers", () => {
    const header = stripAnsi(buildInspectorHeader(members, { kind: "member", name: "m12" }, undefined, 42));
    expect(header).toContain("总览");
    expect(header).toContain("❰成员12❱");
    expect(header).toContain("‹");
    expect(header).toContain("›");
    expect(header).not.toContain("成员0 ");
  });

  it("anchors overview member tabs around the selected row", () => {
    const header = stripAnsi(buildInspectorHeader(members, { kind: "overview" }, "m20", 42));
    expect(header).toContain("❰总览❱");
    expect(header).toContain("成员20");
    expect(header).not.toContain("❰成员20❱");
  });

  it("shows all members without unnecessary arrows when they fit", () => {
    const header = stripAnsi(buildInspectorHeader(members.slice(0, 2), { kind: "overview" }, undefined, 60));
    expect(header).toContain("成员0");
    expect(header).toContain("成员1");
    expect(header).not.toMatch(/[‹›]/);
  });

  it("distinguishes duplicate member labels in tabs", () => {
    const header = stripAnsi(buildInspectorHeader([{ name: "alpha", label: "开发" }, { name: "beta", label: "开发" }], { kind: "member", name: "beta" }, undefined, 60));
    expect(header).toContain("alpha");
    expect(header).toContain("beta");
  });

  it("retains a recognizable overview label at tiny widths", () => {
    expect(stripAnsi(buildInspectorHeader(members, { kind: "overview" }, "m20", 2))).toBe("总");
    expect(stripAnsi(buildInspectorHeader([], { kind: "overview" }, undefined, 4))).toBe("总览");
  });

  it("reflows on resize, uses whole graphemes, and handles stale selections", () => {
    const list = [{ name: "a", label: "\x1b[31m程序👩‍💻研发e\u0301\x1b[0m" }, ...members];
    for (let width = 0; width <= 120; width++) {
      for (const name of ["a", "m20", "missing"]) {
        const header = buildInspectorHeader(list, { kind: "member", name }, undefined, width);
        expect(visibleWidth(header)).toBe(width);
        expect(stripAnsi(header)).not.toMatch(/[\r\n\t]|\uFFFD|\u200d(?:…|$)/u);
      }
    }
    expect(stripAnsi(buildInspectorHeader([], { kind: "overview" }, undefined, 20))).toContain("总览");
  });
});
