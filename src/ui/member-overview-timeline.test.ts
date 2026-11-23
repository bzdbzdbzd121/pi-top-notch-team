import { describe, expect, it } from "vitest";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { BADGE_WIDTH } from "./member-overview-badge.js";
import { IDENTITY_THEME } from "./member-inspector-state.js";
import type { PaletteSource } from "./member-overview-palette.js";
import type { OverviewAction, TimelineInfo } from "./member-overview-store.js";
import { memberNameWidth } from "./member-overview-state.js";
import {
  AXIS_NOW_LABEL, AXIS_TICK_EVERY, AXIS_TIME_WIDTH, CONTEXT_BAR_CELLS, GLYPH, LEGEND_ITEMS,
  MIN_TIMELINE_CELLS, STEP_LADDER_MS, TARGET_WINDOW_MS, TIMELINE_CONTEXT_WIDTH, buildAxisLine,
  buildColorLegend, buildFrozenNotice, buildLaneText, buildTimelineLines, cellIndexAt, cellStart, fallbackLayout,
  formatClock, paintLane, pickStep, resolveWindow, timelineAxisVisible, timelineCapacity,
  timelineLaneWidth, timelinePrefixWidth, timelineSignature, timelineTier, timelineWindow,
  type LaneCell, type TimelineRow, type TimelineWindow,
} from "./member-overview-timeline.js";

const NOW = new Date(2026, 0, 1, 10, 41, 15).getTime();
const strip = (text: string): string => stripVTControlCharacters(text);
const TRUE_COLOR: PaletteSource = { mode: "truecolor", ansi: () => "\x1b[38;2;255;255;255m" };

let nextId = 1;
const record = (patch: Partial<OverviewAction> & { at: number }): OverviewAction =>
  ({ id: nextId++, kind: "read", status: "done", ...patch });
const row = (name: string, patch: Partial<TimelineRow> = {}): TimelineRow =>
  ({ name, label: name, state: "idle", percent: 42, actions: [], ...patch });
const info = (patch: Partial<TimelineInfo> = {}): TimelineInfo => ({ truncated: false, turns: [], ...patch });
const win = (cells: number, step: number, anchor: number): TimelineWindow => ({ cells, step, anchor });

/**
 * Every status word, with a uniform lane so the lane extent can be measured from
 * the rendered content. Records sit at `at: 0` (decades before the window), and
 * the "active" ones also carry `endedAt: 0`: the badge reads the kind/status, the
 * lane only sees a zero-length point outside the window.
 */
const STATUS_FIXTURES: Partial<TimelineRow>[] = [
  { state: "working", phase: "thinking", info: info() },
  { state: "working", phase: "output", info: info() },
  { state: "working", phase: "executing", info: info(), actions: [{ id: 1, kind: "read", status: "active", at: 0, endedAt: 0 }] },
  { state: "working", phase: "executing", info: info(), actions: [{ id: 2, kind: "modify", status: "active", at: 0, endedAt: 0 }] },
  { state: "working", phase: "executing", info: info(), actions: [{ id: 3, kind: "tool", status: "active", at: 0, endedAt: 0 }] },
  { state: "compacting", info: info() },
  { state: "working", info: info({ openTurnStart: 0 }) },
  { state: "working", info: info({ openTurnStart: 0 }), actions: [{ id: 4, kind: "read", status: "done", at: 0 }] },
  { state: "idle", info: info() },
  { state: "crashed", info: info() },
  { state: "stopped", info: info() },
];

describe("member overview timeline window", () => {
  it("locks the appendix C main table", () => {
    expect(TARGET_WINDOW_MS).toBe(180_000);
    expect(STEP_LADDER_MS).toEqual([1000, 2000, 3000, 5000]);
    expect(TIMELINE_CONTEXT_WIDTH).toBe(12);
    expect(CONTEXT_BAR_CELLS).toBe(4);
    expect(MIN_TIMELINE_CELLS).toBe(12);
    const table = [
      [70, 11, 36, 5000, 180_000],
      [88, 14, 51, 3000, 153_000],
      [106, 17, 66, 3000, 198_000],
      [124, 18, 83, 2000, 166_000],
      [142, 18, 101, 2000, 202_000],
      [178, 18, 137, 1000, 137_000],
    ] as const;
    for (const [inner, name, lane, step, span] of table) {
      expect(memberNameWidth(inner)).toBe(name);
      expect(timelineTier(inner)).toBe(3);
      expect(timelineLaneWidth(inner, BADGE_WIDTH[3])).toBe(lane);
      expect(lane).toBeGreaterThanOrEqual(MIN_TIMELINE_CELLS);
      expect(pickStep(lane)).toBe(step);
      expect(lane * step).toBe(span);
    }
  });

  it("locks the degraded tier thresholds", () => {
    const table = [
      // inner, name, lane(3-char badge), lane(2-char badge), tier, step
      [62, 10, 29, 31, 3, 5000],
      [52, 8, 21, 23, 3, 5000],
      [43, 7, 13, 15, 2, 5000],
      [41, 6, 12, 14, 2, 5000],
      [40, 6, 11, 13, "fallback", 0],
      [37, 6, 8, 10, "fallback", 0],
      [34, 5, 6, 8, "fallback", 0],
    ] as const;
    for (const [inner, name, wideLane, narrowLane, tier, step] of table) {
      expect(memberNameWidth(inner)).toBe(name);
      expect(timelineLaneWidth(inner, BADGE_WIDTH[3])).toBe(wideLane);
      expect(timelineLaneWidth(inner, BADGE_WIDTH[2])).toBe(narrowLane);
      expect(timelineTier(inner)).toBe(tier);
      if (tier !== "fallback") expect(pickStep(narrowLane)).toBe(step);
    }
  });

  it("breaks step ties towards the finer step", () => {
    expect(pickStep(45)).toBe(3000); // 135s vs 225s — both 45s away
    expect(pickStep(72)).toBe(2000); // 144s vs 216s — both 36s away
    expect(pickStep(60)).toBe(3000); // exactly three minutes
    expect(pickStep(0)).toBe(1000);
    expect(pickStep(Number.NaN)).toBe(1000);
  });

  it("slides with now while anything is live or the activity is still visible", () => {
    const slide = Math.floor(NOW / 3000) * 3000;
    expect(resolveWindow({ now: NOW, laneWidth: 66, live: true }))
      .toEqual({ step: 3000, cells: 66, anchor: slide });
    expect(resolveWindow({ now: NOW, laneWidth: 66, live: true, lastActivityAt: NOW - 600_000 }).frozenAt)
      .toBeUndefined();
    expect(resolveWindow({ now: NOW, laneWidth: 66, live: false, lastActivityAt: NOW - 60_000 }))
      .toEqual({ step: 3000, cells: 66, anchor: slide });
    expect(resolveWindow({ now: NOW, laneWidth: 66, live: false }).frozenAt).toBeUndefined();
  });

  it("freezes on the last activity once the team has been idle past the window", () => {
    const last = NOW - 600_000;
    const frozen = resolveWindow({ now: NOW, laneWidth: 66, live: false, lastActivityAt: last });
    expect(frozen.frozenAt).toBe(last);
    expect(frozen.anchor).toBe(Math.floor(last / 3000) * 3000);
    // The frozen activity sits in the rightmost cell.
    expect(cellStart(frozen, frozen.cells - 1)).toBe(frozen.anchor);
    expect(last).toBeGreaterThanOrEqual(frozen.anchor);
    expect(last).toBeLessThan(frozen.anchor + frozen.step);
    // An empty lane has nothing to freeze on.
    expect(resolveWindow({ now: NOW, laneWidth: 0, live: false, lastActivityAt: last }).frozenAt).toBeUndefined();
  });

  it("maps cells to instants and back", () => {
    const w = win(5, 3000, 30_000);
    expect(cellStart(w, 0)).toBe(18_000);
    expect(cellStart(w, 4)).toBe(30_000);
    expect(cellIndexAt(w, 30_000)).toBe(4);
    expect(cellIndexAt(w, 30_001)).toBe(4);
    expect(cellIndexAt(w, 29_999)).toBe(3);
    expect(cellIndexAt(w, 18_000)).toBe(0);
    expect(cellIndexAt(w, 17_999)).toBe(-1);
    expect(cellIndexAt(w, 60_000)).toBe(4);
    expect(cellIndexAt(w, Number.NaN)).toBe(-1);
    // One cell = one step (half-open: [start, start+step)); the rightmost cell
    // starts at the anchor and ends at anchor+step.
    for (let k = 0; k < 4; k++) expect(cellStart(w, k + 1) - cellStart(w, k)).toBe(w.step);
    expect(cellStart(w, 4) + w.step).toBe(33_000);
    const advanced = win(5, 3000, 33_000);
    for (let k = 0; k < 4; k++) expect(cellStart(advanced, k)).toBe(cellStart(w, k + 1));
  });
});

describe("member overview timeline lane", () => {
  it("paints a run as a solid start followed by continuation cells", () => {
    const w = win(10, 1000, 100_000); // cells start at 91_000, 1s each
    const cells = paintLane([record({ at: 92_000, endedAt: 96_000, kind: "thinking" })], info({ knownFrom: 91_000 }), w);
    expect(cells.map(cell => cell.cls)).toEqual([
      "idle", "thinking", "thinking", "thinking", "thinking", "idle", "idle", "idle", "idle", "idle",
    ]);
    expect(cells.map(cell => cell.start ? 1 : 0)).toEqual([1, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(buildLaneText(cells)).toBe(" █▓▓▓     ");
  });

  it.each([
    ["complete", "complete", "done"],
    ["crashed", "crash", "error"],
    ["stopped", "stop", "done"],
  ] as const)("lights exactly one cell for the %s point event", (kind, cls, status) => {
    const w = win(10, 1000, 100_000);
    const cells = paintLane([record({ at: 93_000, endedAt: 93_000, kind, status })], info({ knownFrom: 91_000 }), w);
    expect(cells.map(cell => cell.cls)).toEqual([
      "idle", "idle", cls, "idle", "idle", "idle", "idle", "idle", "idle", "idle",
    ]);
    expect(cells.filter(cell => cell.cls !== "idle")).toHaveLength(1);
  });

  it("resolves each cell by the documented priority order", () => {
    const w = win(1, 1000, 100_000);
    const busy = info({ knownFrom: 100_000, turns: [[100_000, 100_500]] });
    const ladder: [string, OverviewAction][] = [
      ["complete", record({ at: 100_000, kind: "complete", endedAt: 100_000 })],
      ["thinking", record({ at: 100_000, kind: "thinking" })],
      ["output", record({ at: 100_000, kind: "output" })],
      ["tool", record({ at: 100_000, kind: "tool" })],
      ["read", record({ at: 100_000, kind: "read" })],
      ["modify", record({ at: 100_000, kind: "modify" })],
      ["failed", record({ at: 100_000, kind: "read", status: "error" })],
      ["compact", record({ at: 100_000, kind: "compacting", endedAt: 100_000 })],
      ["stop", record({ at: 100_000, kind: "stopped", endedAt: 100_000 })],
      ["crash", record({ at: 100_000, kind: "crashed", status: "error", endedAt: 100_000 })],
    ];
    const present: OverviewAction[] = [];
    for (const [expected, addition] of ladder) {
      present.push(addition);
      expect(paintLane(present, busy, w)[0]!.cls).toBe(expected);
    }
    // "回合结束" always yields to a real action, even a silent busy turn.
    expect(paintLane([], busy, w)[0]!.cls).toBe("busySilent");
    expect(paintLane([], info({ knownFrom: 100_000 }), w)[0]!.cls).toBe("idle");
    expect(paintLane([], undefined, w)[0]!.cls).toBe("unknown");
  });

  it("discards unusable timestamps and never paints the future", () => {
    const w = win(10, 1000, 100_000); // window = [91 000, 101 000)
    const base = info({ knownFrom: 91_000 });
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, -5])
      expect(paintLane([record({ at })], base, w).every(cell => cell.cls === "idle")).toBe(true);
    // Beyond the right edge (clock rollback leaves stamps ahead of now): not drawn.
    for (const at of [101_000, 101_001, 500_000])
      expect(paintLane([record({ at })], base, w).every(cell => cell.cls === "idle")).toBe(true);
    // One millisecond inside the edge still owns the last cell.
    expect(paintLane([record({ at: 100_999 })], base, w)[9]!.cls).toBe("read");
    expect(paintLane([record({ at: 1_000 })], base, w).every(cell => cell.cls === "idle")).toBe(true);
  });

  it("stripes everything left of the trusted horizon", () => {
    const w = win(10, 1000, 100_000);
    expect(paintLane([], info({ knownFrom: 94_000 }), w).map(cell => cell.cls)).toEqual([
      "unknown", "unknown", "unknown", "idle", "idle", "idle", "idle", "idle", "idle", "idle",
    ]);
    expect(paintLane([], info({ knownFrom: 91_000, truncated: true }), w).every(cell => cell.cls === "idle")).toBe(true);
    expect(paintLane([], undefined, w).every(cell => cell.cls === "unknown")).toBe(true);
  });

  it("paints busy-without-action cells from the turn intervals", () => {
    const w = win(10, 1000, 100_000);
    const closed = paintLane([], info({ knownFrom: 91_000, turns: [[92_000, 95_000]] }), w);
    expect(closed.map(cell => cell.cls)).toEqual([
      "idle", "busySilent", "busySilent", "busySilent", "idle", "idle", "idle", "idle", "idle", "idle",
    ]);
    const open = paintLane([], info({ knownFrom: 91_000, openTurnStart: 96_000 }), w);
    expect(open.slice(0, 5).every(cell => cell.cls === "idle")).toBe(true);
    expect(open.slice(5).every(cell => cell.cls === "busySilent")).toBe(true);
    // A degenerate (zero-length) turn owns exactly one cell, it does not run right.
    const instant = paintLane([], info({ knownFrom: 91_000, turns: [[96_500, 96_500]] }), w);
    expect(instant.map(cell => cell.cls)).toEqual([
      "idle", "idle", "idle", "idle", "idle", "busySilent", "idle", "idle", "idle", "idle",
    ]);
    // A real record still wins inside an open turn.
    const mixed = paintLane([record({ at: 93_000, endedAt: 93_000 })], info({ knownFrom: 91_000, openTurnStart: 92_000 }), w);
    expect(mixed[2]!.cls).toBe("read");
    // A new record restarts the solid block even inside a long run of its own class.
    const resumed = paintLane([
      record({ at: 91_000, endedAt: 93_000 }),
      record({ at: 94_000, endedAt: 96_000 }),
    ], info({ knownFrom: 91_000 }), w);
    expect(resumed.map(cell => cell.start ? 1 : 0).slice(0, 6)).toEqual([1, 0, 1, 1, 0, 1]);
  });

  it("merges same-colour runs, emits one foreground reset, and keeps bytes bounded", () => {
    const cells: LaneCell[] = [
      { cls: "read", start: true }, { cls: "read", start: false }, { cls: "idle", start: true },
      { cls: "thinking", start: true }, { cls: "failed", start: true },
    ];
    const text = buildLaneText(cells, TRUE_COLOR);
    expect(text).toBe(`${"\x1b[38;2;255;255;255m"}█▓ ${"\x1b[38;2;255;255;255m"}██\x1b[39m`);
    expect(visibleWidth(text)).toBe(5);
    expect(text).not.toContain("\x1b[0m");
    expect(text.endsWith("\x1b[39m")).toBe(true);

    const alternating: PaletteSource = {
      mode: "truecolor",
      ansi: token => token === "syntaxType" ? "\x1b[38;2;1;1;1m" : "\x1b[38;2;2;2;2m",
    };
    const many: LaneCell[] = Array.from({ length: 60 }, (_, index) =>
      ({ cls: index % 2 ? "read" : "thinking", start: true }));
    const worst = buildLaneText(many, alternating);
    const prefixBytes = Buffer.byteLength("\x1b[38;2;1;1;1m", "utf8");
    expect(prefixBytes).toBe(13);
    // Worst case: every cell is its own colour run (prefix + one 3-byte glyph).
    expect(Buffer.byteLength(worst, "utf8")).toBeLessThanOrEqual(many.length * (prefixBytes + 3) + 5);
    expect(visibleWidth(worst)).toBe(60);
    expect(worst.match(/\x1b\[0m/g)).toBeNull();
    expect(worst.match(/\x1b\[39m/g)).toHaveLength(1);

    // Without a palette the lane is plain text of the same width.
    const plain = buildLaneText(many);
    expect(visibleWidth(plain)).toBe(60);
    expect(plain).not.toContain("\x1b[");
    expect(buildLaneText([])).toBe("");
  });

  it("uses one-column glyphs for every class", () => {
    const entries = Object.values(GLYPH);
    for (const glyph of entries) expect(visibleWidth(glyph)).toBe(1);
    const cells: LaneCell[] = [
      { cls: "crash", start: true }, { cls: "stop", start: true }, { cls: "complete", start: true },
      { cls: "compact", start: true }, { cls: "compact", start: false },
      { cls: "busySilent", start: true }, { cls: "unknown", start: true }, { cls: "idle", start: true },
    ];
    expect(buildLaneText(cells)).toBe("!-·█▒▁░ ");
  });
});

describe("member overview timeline badge, legend, and layout helpers", () => {
  it("colours the status word with its class", () => {
    const palette: PaletteSource = {
      mode: "truecolor",
      ansi: token => token === "syntaxType" ? "\x1b[38;2;7;7;7m" : undefined,
    };
    const rows = [
      row("a", { state: "working", phase: "executing", actions: [{ id: 1, kind: "read", status: "active", at: 0, endedAt: 0 }] }),
      row("b", { state: "working", phase: "thinking" }),
    ];
    const lines = buildTimelineLines(rows, undefined, 0, 4, 106, NOW, IDENTITY_THEME, { palette });
    expect(lines[1]).toContain("\x1b[38;2;7;7;7m读取中\x1b[39m");
    // thinkingLow is unavailable in this palette → fixed RGB fallback, still coloured.
    expect(lines[2]).toContain("\x1b[38;2;95;135;175m思考中\x1b[39m");
    expect(visibleWidth(lines[1]!)).toBe(106);
    // Without a palette the word is plain text (tests and colourless terminals).
    const plain = buildTimelineLines(rows, undefined, 0, 4, 106, NOW);
    expect(plain[1]).not.toContain("\x1b[");
  });

  it("builds the ? legend per class and only drops whole items from the right", () => {
    const palette: PaletteSource = {
      mode: "truecolor",
      ansi: token => token === "syntaxType" ? "\x1b[38;2;7;7;7m" : undefined,
    };
    expect(LEGEND_ITEMS.map(item => item.word)).toEqual(["思考", "读取", "写入", "执行", "输出", "压缩", "崩溃", "停止", "空闲"]);
    const wide = buildColorLegend(80, palette);
    expect(visibleWidth(wide)).toBe(80);
    const text = strip(wide);
    for (const item of LEGEND_ITEMS) expect(text).toContain(item.word);
    expect(wide).toContain("\x1b[38;2;7;7;7m读取\x1b[39m");
    // 4 items = 4×4 + 3×2 = 22 columns; 5 items would need 28.
    const narrow = buildColorLegend(26, palette);
    expect(visibleWidth(narrow)).toBe(26);
    for (const word of ["思考", "读取", "写入", "执行"]) expect(strip(narrow)).toContain(word);
    for (const word of ["输出", "压缩", "崩溃", "停止", "空闲"]) expect(strip(narrow)).not.toContain(word);
    expect(buildColorLegend(0)).toBe("");
    // 10 columns fit exactly two 2-word items with one gap.
    expect(strip(buildColorLegend(10))).toBe("思考  读取");
  });

  it("knows when the axis costs a member row", () => {
    expect(timelineAxisVisible(2, 106)).toBe(false);
    expect(timelineAxisVisible(3, 106)).toBe(true);
    expect(timelineAxisVisible(5, 30)).toBe(false); // fallback tier: no axis
    expect(timelineCapacity(13, 106)).toBe(12);
    expect(timelineCapacity(13, 30)).toBe(13);
    expect(timelineCapacity(0, 106)).toBe(0);
    expect(timelineCapacity(1, 106)).toBe(1);
  });

  it("keeps the lane content at the right edge instead of letting fit eat it", () => {
    const w = resolveWindow({ now: NOW, laneWidth: timelineLaneWidth(106, BADGE_WIDTH[3]), live: true });
    const open = [row("a", {
      state: "working", phase: "thinking", info: info({ knownFrom: NOW - 200_000 }),
      actions: [record({ at: NOW - 4_000, kind: "thinking", status: "active" })],
    })];
    const line = strip(buildTimelineLines(open, undefined, 0, 4, 106, NOW)[1]!);
    expect(visibleWidth(line)).toBe(106);
    expect(line.endsWith(GLYPH.continuation)).toBe(true);
    expect(line.match(/▓+$/u)![0].length).toBeGreaterThan(1);
    // A point event at the rightmost instant lands in the rightmost column.
    const edge = w.anchor + w.step - 1;
    const point = [row("a", {
      info: info({ knownFrom: NOW - 200_000 }),
      actions: [record({ at: edge, kind: "crashed", status: "error", endedAt: edge })],
    })];
    expect(strip(buildTimelineLines(point, undefined, 0, 4, 106, NOW)[1]!).endsWith(GLYPH.crash)).toBe(true);
  });

  it("exposes the window and a signature that moves with the anchor", () => {
    const rows = [row("a", { info: info({ knownFrom: NOW - 100_000 }) })];
    const window = timelineWindow(rows, 4, 106, NOW)!;
    expect(window).toMatchObject({ step: 3000, cells: 66 });
    expect(timelineWindow(rows, 4, 30, NOW)).toBeUndefined();
    const base = timelineSignature(rows, 4, 106, NOW);
    expect(timelineSignature(rows, 4, 106, NOW)).toBe(base);
    // One step later the anchor moves, so the page must repaint.
    expect(timelineSignature(rows, 4, 106, NOW + 3000)).not.toBe(base);
    // Row changes are part of the signature as well.
    const changed = [row("a", { state: "working", info: info({ knownFrom: NOW - 100_000 }) })];
    expect(timelineSignature(changed, 4, 106, NOW)).not.toBe(base);
  });
});

describe("member overview timeline frame budget", () => {
  it("records the worst-case frame cost (24 members × 64 records, inner 178)", () => {
    const rows = Array.from({ length: 24 }, (_, index) => {
      const actions = Array.from({ length: 64 }, (_, slot) => {
        const kind = (["thinking", "read", "modify", "tool", "output"] as const)[slot % 5];
        const at = NOW - 200_000 + slot * 3_000;
        return record({ at, endedAt: at + 2_500, kind });
      });
      return row(`m${index}`, {
        label: `成员${index}`, state: "working" as const, phase: "executing" as const, percent: 42,
        actions,
        info: info({ knownFrom: NOW - 200_000, turns: [[NOW - 200_000, NOW - 5_000]], truncated: index % 3 === 0 }),
      });
    });
    // Warm up first: the recorded number must be steady state, not JIT warm-up.
    buildTimelineLines(rows, "m0", 0, 25, 178, NOW, IDENTITY_THEME, { palette: TRUE_COLOR });
    const frames = 20;
    const started = performance.now();
    for (let frame = 0; frame < frames; frame++)
      buildTimelineLines(rows, "m0", 0, 25, 178, NOW + frame * 1_000, IDENTITY_THEME, { palette: TRUE_COLOR });
    const perFrame = (performance.now() - started) / frames;
    const bytes = buildTimelineLines(rows, "m0", 0, 25, 178, NOW, IDENTITY_THEME, { palette: TRUE_COLOR })
      .reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
    // eslint-disable-next-line no-console -- 留档：宽屏 + 满员 + 真彩的实测值
    console.log(`[perf] 24×64 inner=178: ${perFrame.toFixed(3)} ms/frame, ${bytes} B/frame`);
    expect(perFrame).toBeLessThan(50);
    expect(bytes).toBeLessThan(200_000);
  });
});

describe("member overview timeline clock guards (P4)", () => {
  it("keeps a backward clock jump honest: the future stamp is invisible, the present one paints", () => {
    const now = 10_000_000;
    const ahead = now + 3_600_000; // an hour ahead, as a rollback leaves the store's stamps
    const window = resolveWindow({ now, laneWidth: 40, live: false, lastActivityAt: ahead });
    expect(window.frozenAt).toBeUndefined(); // a future watermark is not "idle in the past"
    const cells = paintLane([
      record({ at: ahead, endedAt: ahead + 2_000, kind: "thinking" }),
      record({ at: now - 1_000, kind: "read" }),
    ], info({ knownFrom: now - 60_000 }), window);
    const painted = cells.map((cell, index) => cell.cls === "read" ? index : -1).filter(index => index >= 0);
    // now-1 s falls in the cell before the in-progress one (5 s cells, anchor = now).
    const expectedCell = window.cells - 1 - Math.ceil(1_000 / window.step);
    expect(painted).toEqual([expectedCell]);
    expect(cells.filter(cell => cell.cls === "thinking")).toHaveLength(0);
    expect(buildLaneText(cells)).not.toMatch(/NaN/);
  });

  it("filters non-finite timestamps without producing a NaN column", () => {
    const window = win(12, 1_000, 100_000);
    const cells = paintLane([
      record({ at: Number.NaN }),
      record({ at: Number.POSITIVE_INFINITY }),
      record({ at: Number.NEGATIVE_INFINITY }),
      record({ at: -1 }),
      { id: 99, kind: "read", status: "done", at: Number.NaN, endedAt: 500 },
    ], info({ knownFrom: 89_000 }), window);
    expect(cells).toHaveLength(12);
    expect(cells.every(cell => cell.cls === "idle")).toBe(true);
    const text = buildLaneText(cells);
    expect(text).not.toContain("NaN");
    expect(visibleWidth(text)).toBe(12);
  });

  it("explains a frozen window and says nothing while it slides", () => {
    const now = 100_000_000;
    const last = now - 12 * 60_000;
    const frozen = resolveWindow({ now, laneWidth: 40, live: false, lastActivityAt: last });
    expect(buildFrozenNotice(frozen, now)).toBe("停在 12 分钟前");
    expect(buildFrozenNotice(resolveWindow({ now, laneWidth: 40, live: true }), now)).toBe("");
    // A frozen window always reads as at least one minute.
    const shortest = resolveWindow({ now, laneWidth: 1, live: false, lastActivityAt: now - 1_000 });
    expect(shortest.frozenAt).toBe(now - 1_000);
    expect(buildFrozenNotice(shortest, now)).toBe("停在 1 分钟前");
    // Long idle stretches stay in minutes (no fake precision).
    expect(buildFrozenNotice(resolveWindow({ now, laneWidth: 40, live: false, lastActivityAt: now - 3_600_000 }), now))
      .toBe("停在 60 分钟前");
  });
});

describe("member overview timeline axis", () => {
  it("labels cell boundaries and puts 'now' on the right edge", () => {
    const w = resolveWindow({ now: NOW, laneWidth: 66, live: true });
    expect(w).toEqual({ step: 3000, cells: 66, anchor: NOW });
    const line = buildAxisLine(w, 106);
    expect(visibleWidth(line)).toBe(106);
    const text = strip(line);
    expect(text.indexOf(AXIS_NOW_LABEL)).toBe(102);
    expect(text.trimEnd().endsWith(AXIS_NOW_LABEL)).toBe(true);
    expect(text.indexOf("10:40:45")).toBe(88); // boundary 30 s back, label ends on column 95
    expect(text.indexOf("10:40:15")).toBe(78);
    expect(AXIS_TICK_EVERY).toBe(10);
    expect(AXIS_TIME_WIDTH).toBe(8);
    expect(text).not.toMatch(/[\r\n\t]/);
  });

  it("replaces 'now' with the frozen instant when the window is frozen", () => {
    const last = NOW - 600_000;
    const frozen = resolveWindow({ now: NOW, laneWidth: 66, live: false, lastActivityAt: last });
    const text = strip(buildAxisLine(frozen, 106));
    expect(text).not.toContain(AXIS_NOW_LABEL);
    expect(text.trimEnd().endsWith(formatClock(last))).toBe(true);
  });

  it("stays exactly wide on degenerate lanes", () => {
    for (const cells of [0, 1, 2, 4, 5, 8, 12, 40]) {
      for (const width of [0, 1, 2, 5, 8, cells, 120]) {
        const line = buildAxisLine(win(cells, 1000, NOW), width);
        expect(visibleWidth(line)).toBe(width);
      }
    }
    expect(buildAxisLine(win(10, 1000, NOW), 0)).toBe("");
    expect(formatClock(Number.NaN)).toBe("??:??:??");
  });
});

describe("member overview timeline lines", () => {
  it("puts the axis on the first line and one member per remaining line", () => {
    const rows = [row("a", { label: "甲" }), row("b", { label: "乙" }), row("c", { label: "丙" })];
    const lines = buildTimelineLines(rows, "a", 0, 6, 106, NOW);
    expect(lines).toHaveLength(6);
    for (const line of lines) expect(visibleWidth(line)).toBe(106);
    const texts = lines.map(strip);
    expect(texts[0]).toContain(AXIS_NOW_LABEL);
    expect(texts[1]).toContain("› ");
    expect(texts[1]).toContain("甲");
    expect(texts[2]).toContain("乙");
    expect(texts[3]).toContain("丙");
    expect(texts[4]!.trim()).toBe("");
    expect(texts[5]!.trim()).toBe("");
    // Below three lines there is no room for a clock axis.
    expect(strip(buildTimelineLines(rows, "a", 0, 2, 106, NOW).join(""))).not.toContain(AXIS_NOW_LABEL);
    expect(strip(buildTimelineLines(rows, "a", 0, 1, 106, NOW).join(""))).not.toContain(AXIS_NOW_LABEL);
  });

  it("shows the empty state without an axis", () => {
    const lines = buildTimelineLines([], undefined, 0, 4, 80, NOW);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
    expect(strip(lines[0]!)).toContain("暂无成员");
    expect(strip(lines.join(""))).not.toContain(AXIS_NOW_LABEL);
  });

  it("renders the three-character badge on wide rows and the two-character one in the fallback", () => {
    const subject = [row("a", { state: "working", phase: "thinking" })];
    expect(strip(buildTimelineLines(subject, undefined, 0, 4, 106, NOW)[1]!)).toContain("思考中");
    const narrow = strip(buildTimelineLines(subject, undefined, 0, 4, 30, NOW)[0]!);
    expect(narrow).toContain("思考");
    expect(narrow).not.toContain("思考中");
  });

  it("reaches every one of the eleven status words", () => {
    const rows = STATUS_FIXTURES.map((patch, index) => row(`m${index}`, { label: `成员${index}`, ...patch }));
    const text = strip(buildTimelineLines(rows, "m0", 0, 13, 106, NOW).join("\n"));
    for (const word of ["思考中", "输出中", "读取中", "写入中", "执行中", "压缩中", "等待中", "工作中", "空闲", "已崩溃", "已停止"])
      expect(text).toContain(word);
  });

  /** Visible length of the trailing run of the line's last character. */
  const trailingRun = (line: string): number => {
    const text = strip(line);
    let run = 0;
    for (let index = text.length - 1; index >= 0; index--) {
      if (text[index] !== text[text.length - 1]) break;
      run += visibleWidth(text[index]!);
    }
    return run;
  };

  it("starts every lane at the same column for every width, tier, and status", () => {
    // Both the badge and the lane are coloured now, so the lane start cannot be
    // found by "first ANSI". The fixtures paint uniform lanes (all ░ or all ▁),
    // so the trailing run measures the lane extent from the content itself.
    const rows = Array.from({ length: 24 }, (_, index) =>
      row(`m${index}`, { label: `成员${index}`, ...STATUS_FIXTURES[index % STATUS_FIXTURES.length]! }));
    for (let width = 0; width <= 160; width++) {
      const tier = timelineTier(width);
      const lines = buildTimelineLines(rows, "m0", 0, 25, width, NOW, IDENTITY_THEME, { palette: TRUE_COLOR });
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      if (tier === "fallback") continue;
      const members = lines.slice(1);
      expect(members).toHaveLength(24);
      const prefix = timelinePrefixWidth(memberNameWidth(width), BADGE_WIDTH[tier]);
      const lane = timelineLaneWidth(width, BADGE_WIDTH[tier]);
      expect(prefix + lane).toBe(width);
      const runs = members.map(trailingRun);
      expect(new Set(runs).size).toBe(1);
      expect(runs[0]).toBe(lane);
      expect(width - runs[0]!).toBe(prefix);
    }
  });

  it("keeps the fallback block sequence aligned too", () => {
    for (const width of [14, 20, 24, 30, 34, 37, 40]) {
      expect(timelineTier(width)).toBe("fallback");
      const rows = Array.from({ length: 4 }, (_, index) => row(`m${index}`, {
        label: `成员${index}`,
        actions: [record({ at: 1_000 + index, kind: "read" }), record({ at: 2_000 + index, kind: "thinking" })],
      }));
      const lines = buildTimelineLines(rows, "m0", 0, 4, width, NOW);
      const starts = lines.map(line => {
        const text = strip(line);
        const at = text.indexOf(GLYPH.start);
        expect(at).toBeGreaterThanOrEqual(0);
        // Columns, not UTF-16 indices: names and badges are wide characters.
        return visibleWidth(text.slice(0, at));
      });
      expect(new Set(starts).size).toBe(1);
      const { nameWidth } = fallbackLayout(width);
      expect(starts[0]).toBe(2 + nameWidth + 1 + BADGE_WIDTH[2] + 1);
    }
  });

  it("holds the width contract across widths, heights, and member counts", () => {
    const build = (count: number, width: number, height: number) => {
      const rows = Array.from({ length: count }, (_, index) => row(`m${index}`, {
        label: index % 3 === 0 ? `成员${index}` : `member-${index}`,
        state: index % 5 === 0 ? "working" : index % 7 === 0 ? "crashed" : "idle",
        phase: index % 4 === 0 ? "thinking" : "executing",
        percent: index % 2 ? 42 : null,
        actions: [record({ at: 1_000, kind: "read" }), record({ at: 2_000, endedAt: 3_000, kind: "thinking" })],
        info: info({ knownFrom: 1_500 }),
      }));
      const lines = buildTimelineLines(rows, rows[0]?.name, 0, height, width, NOW, IDENTITY_THEME, {
        palette: TRUE_COLOR,
      });
      return lines;
    };
    // Full cross product, coloured lanes included.
    for (let width = 0; width <= 160; width += 1) {
      for (let height = 0; height <= 6; height += 1) {
        for (const count of [0, 1, 4, 24]) {
          const lines = build(count, width, height);
          expect(lines).toHaveLength(height);
          for (const line of lines) {
            expect(visibleWidth(line)).toBe(width);
            expect(line).not.toMatch(/[\r\n\t]/);
            expect(line).not.toContain("\uFFFD");
          }
        }
      }
    }
    for (const width of [0, 1, 2, 5, 13, 14, 20, 34, 37, 40, 41, 43, 51, 62, 70, 80, 106, 120, 160])
      for (const height of [13, 27]) {
        const lines = build(24, width, height);
        expect(lines).toHaveLength(height);
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
  });

  it("is deterministic and never clips a wide character in half", () => {
    const rows = [row("a", { label: "审查员张三李四王五" }), row("b", { label: "reviewer" })];
    const once = buildTimelineLines(rows, "a", 0, 6, 60, NOW, IDENTITY_THEME, { palette: TRUE_COLOR });
    const twice = buildTimelineLines(rows, "a", 0, 6, 60, NOW, IDENTITY_THEME, { palette: TRUE_COLOR });
    expect(twice).toEqual(once);
    for (let width = 0; width <= 160; width += 1) {
      const lines = buildTimelineLines(rows, "a", 0, 4, width, NOW);
      for (const line of lines) {
        const text = strip(line);
        expect(visibleWidth(text)).toBe(width);
        // Re-truncating is a no-op only when no wide char straddles the boundary.
        expect(truncateToWidth(text, width, "")).toBe(text);
      }
    }
  });

  it("derives the anchor from the visible rows when the caller does not supply it", () => {
    const idle = [row("a", { actions: [record({ at: NOW - 700_000 })] })];
    const frozen = strip(buildTimelineLines(idle, undefined, 0, 4, 106, NOW)[0]!);
    expect(frozen).not.toContain(AXIS_NOW_LABEL);
    const live = [row("a", { state: "working", actions: [record({ at: NOW - 700_000, status: "active" })] })];
    expect(strip(buildTimelineLines(live, undefined, 0, 4, 106, NOW)[0]!)).toContain(AXIS_NOW_LABEL);
  });

  it("uses the caller-provided team-wide last activity and live flag", () => {
    const idle = [row("a")];
    const supplied = strip(buildTimelineLines(idle, undefined, 0, 4, 106, NOW, IDENTITY_THEME, {
      lastActivityAt: NOW - 700_000,
      live: false,
    })[0]!);
    expect(supplied).not.toContain(AXIS_NOW_LABEL);
    const liveOverride = strip(buildTimelineLines(idle, undefined, 0, 4, 106, NOW, IDENTITY_THEME, {
      lastActivityAt: NOW - 700_000,
      live: true,
    })[0]!);
    expect(liveOverride).toContain(AXIS_NOW_LABEL);
  });
});
