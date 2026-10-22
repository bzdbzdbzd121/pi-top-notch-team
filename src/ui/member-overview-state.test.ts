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
  buildOverviewLines(rows, undefined, 0, rows.length + 1, width).map(stripAnsi);
const members = Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` }));

describe("overview rows", () => {
  it("keeps roster order across activity changes and emphasizes the selected name", () => {
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => `\x1b[1m${s}\x1b[22m` };
    const rows = [row("开发"), row("审查", { state: "crashed" }), row("测试", { state: "idle" })];
    const lines = buildOverviewLines(rows, "审查", 0, 5, 100, theme);
    expect(lines.map(stripAnsi).slice(1, 4).map(l => l.match(/开发|审查|测试/)?.[0])).toEqual(["开发", "审查", "测试"]);
    expect(lines[2]).toContain("› ");
    expect(lines[2]).toContain("\x1b[1m审查\x1b[22m");
    expect(lines).toHaveLength(5);
    expect(stripAnsi(lines[4]).trim()).toBe("");
  });

  it.each([
    [{ state: "compacting", phase: "executing" }, "🗜️ 压缩中"],
    [{ state: "crashed", phase: "executing" }, "💥 崩溃"],
    [{ state: "stopped", phase: "thinking", started: false }, "⏹️ 未启动"],
    [{ state: "stopped", started: true }, "⏹️ 已停止"],
    [{ state: "stopped" }, "⏹️ 已停止"],
    [{ phase: "thinking" }, "💭 思考中"],
    [{ phase: "tool-calling" }, "🔧 准备调用"],
    [{ phase: "executing" }, "🔧 执行工具"],
    [{ phase: "output" }, "✏️ 输出中"],
    [{ phase: "working" }, "💭 工作中"],
    [{ phase: "idle" }, "💭 工作中"],
    [{ state: "idle" }, "✅ 空闲"],
  ] as [Partial<OverviewRow>, string][])("applies state precedence %j", (patch, expected) => {
    expect(plain([row("成员", patch)])[1]).toContain(expected);
  });

  it.each([
    [{ percent: null }, "?"], [{ percent: undefined }, "?"],
    [{ percent: 41.6 }, "42%"], [{ percent: 41.6, contextStale: true }, "~42%"],
    [{ percent: null, contextStale: true }, "?"],
    [{ state: "stopped", percent: 42 }, "—"], [{ state: "crashed", percent: 42 }, "—"],
  ] as [Partial<OverviewRow>, string][])("formats context honestly %j", (patch, expected) => {
    const line = plain([row("成员", patch)])[1];
    expect(line).toContain(` ${expected} `);
    if (patch.percent == null) expect(line).not.toContain("0%");
    if (patch.state === "stopped" || patch.state === "crashed") expect(line).not.toContain("42%");
  });

  it("shows a fixed header, scrolls selection into the window and clamps offsets", () => {
    const rows = members.map(m => row(m.name));
    const lines = plain(rows);
    expect(lines[0]).toContain("最近操作（新→右）");
    expect(getOverviewWindowOffset(rows, "m20", 0, 5)).toBe(17);
    expect(getOverviewWindowOffset(rows, "m2", 17, 5)).toBe(2);
    expect(getOverviewWindowOffset(rows, undefined, 999, 5)).toBe(20);
    expect(getOverviewWindowOffset(rows, undefined, -10, 5)).toBe(0);
    const window = buildOverviewLines(rows, "m20", 0, 5, 100).map(stripAnsi);
    expect(window[0]).toContain("18–21 / 24");
    expect(window[4]).toContain("› m20");
    expect(window.slice(1).map(l => l.match(/m\d+/)?.[0])).toEqual(["m17", "m18", "m19", "m20"]);
  });

  it("handles empty members and tiny heights without inventing rows", () => {
    expect(buildOverviewLines([], undefined, 0, 0, 50)).toEqual([]);
    expect(buildOverviewLines([], undefined, 0, 1, 50)).toHaveLength(1);
    expect(buildOverviewLines([], undefined, 0, 3, 50).map(stripAnsi)[1]).toContain("暂无成员");
    expect(getOverviewWindowOffset([], undefined, 99, 0)).toBe(0);
  });

  it("distinguishes duplicate labels using member identifiers", () => {
    const lines = plain([row("backend", { label: "开发" }), row("frontend", { label: "开发" })]);
    expect(lines[1]).toContain("backend");
    expect(lines[2]).toContain("frontend");
  });

  it("prioritizes identifiers when duplicate labels are longer than the name column", () => {
    const label = "这是非常非常长的重复成员名称";
    const lines = plain([row("alpha", { label }), row("beta", { label })], 60);
    expect(lines[1]).toContain("alpha");
    expect(lines[2]).toContain("beta");
  });

  it("retains state and percent before long names and trails on narrow screens", () => {
    const r = row("a", { label: "非常非常非常长的成员名称", actions: actions("read", "modify", "tool") });
    const line = plain([r], 24)[1];
    expect(line).toContain("42%");
    expect(line).toContain("工作");
    expect(line).toContain("…");
    expect(line).not.toContain("📖");
  });

  it.each([16, 17])("visibly moves selection between rows at width %i without a theme", width => {
    const rows = [row("甲"), row("乙")];
    const first = buildOverviewLines(rows, "甲", 0, 3, width).map(stripAnsi);
    const second = buildOverviewLines(rows, "乙", 0, 3, width).map(stripAnsi);
    expect(first).not.toEqual(second);
    expect(first[1]).toMatch(/^› /);
    expect(first[2]).toMatch(/^  /);
    expect(second[1]).toMatch(/^  /);
    expect(second[2]).toMatch(/^› /);
    for (const line of [...first, ...second]) expect(visibleWidth(line)).toBe(width);
    expect(second[2]).toContain("42%");
    expect(second[2]).toContain("乙");
  });

  it("reserves a visible selection marker even below the fixed-column budget", () => {
    const rows = [row("甲"), row("乙")];
    const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m` };
    for (let width = 1; width < 18; width++) {
      const lines = buildOverviewLines(rows, "乙", 0, 3, width, theme);
      expect(stripAnsi(lines[1]).startsWith("›")).toBe(false);
      expect(stripAnsi(lines[2]).startsWith("›"), `width=${width}`).toBe(true);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("fits CJK, emoji, combining marks and ANSI at every width including zero", () => {
    const rows = [row("a", { label: "\x1b[31m程序👩‍💻研发e\u0301\x1b[0m", actions: actions("read", "output", "compacting") }), row("b", { label: "全角ＡＢＣ\r\n\t成员", percent: null })];
    const theme = { fg: (_c: string, s: string) => `\x1b[36m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[22m` };
    for (let width = 0; width <= 120; width++) {
      const lines = buildOverviewLines(rows, "a", 0, 4, width, theme);
      expect(lines).toHaveLength(4);
      for (const line of lines) {
        expect(visibleWidth(line), `width=${width} ${stripAnsi(line)}`).toBe(width);
        expect(stripAnsi(line)).not.toMatch(/[\r\n\t]|\uFFFD|\u200d(?:…|$)/u);
      }
    }
  });
});

describe("action icon suffix", () => {
  it("preserves repeated operations and newest-to-right chronology", () => {
    expect(stripAnsi(buildOverviewTrail(actions("thinking", "read", "read", "modify", "tool"), 14))).toBe("💭 📖 📖 📝 🔧");
    expect(stripAnsi(buildOverviewTrail(actions("thinking", "read", "read", "modify", "tool"), 8))).toBe("📖 📝 🔧");
    expect(buildOverviewTrail([], 10)).toBe("—");
    expect(buildOverviewTrail(actions("read"), 1)).toBe("");
  });

  it("never cuts emoji variation selectors at a suffix boundary", () => {
    const history = actions("read", "output", "compacting");
    const valid = ["", "🗜️", "✏️ 🗜️", "📖 ✏️ 🗜️"];
    for (let width = 0; width <= 12; width++) {
      const trail = stripAnsi(buildOverviewTrail(history, width));
      expect(valid).toContain(trail);
      expect(visibleWidth(trail)).toBeLessThanOrEqual(width);
    }
    expect(stripAnsi(buildOverviewTrail(actions("complete", "crashed", "stopped"), 20))).toBe("✅ 💥 ⏹️");
  });

  it("underlines active and failed actions without exposing tool names", () => {
    const theme = { fg: (c: string, s: string) => `\x1b[${c === "error" ? "31" : "36"}m${s}\x1b[0m` };
    const trail = buildOverviewTrail([
      { id: 1, kind: "read", status: "active", toolName: "secret-path" },
      { id: 2, kind: "modify", status: "error" },
      { id: 3, kind: "complete", status: "done" },
    ], 20, theme);
    expect(stripAnsi(trail)).toBe("📖 📝 ✅");
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

  it("retains a recognizable overview label before tab decorations at tiny widths", () => {
    expect(stripAnsi(buildInspectorHeader(members, { kind: "overview" }, "m20", 2))).toBe("总");
    expect(stripAnsi(buildInspectorHeader([], { kind: "overview" }, undefined, 4))).toBe("总览");
  });

  it("reflows on resize, uses whole graphemes, and handles empty/stale selections", () => {
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
