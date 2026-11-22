import { visibleWidth } from "@earendil-works/pi-tui";
import {
  BADGE_WIDTH, badgeText, pickTier, statusWord, type BadgeTier,
} from "./member-overview-badge";
import { IDENTITY_THEME, type InspectorTheme } from "./member-inspector-state";
import {
  contextBar, duplicateLabels, fit, getOverviewWindowOffset, memberLabel, shorten,
  type OverviewRow,
} from "./member-overview-state";
import { resolveAnsi, type OpClass, type PaletteSource } from "./member-overview-palette";
import type { OverviewAction, TimelineInfo } from "./member-overview-store";

/**
 * Pure timeline grid for the overview page: window/anchor math, cell painting,
 * glyphs, clock axis and the degraded narrow fallback. No IO, no timers, no RPC —
 * the component decides when to call it.
 */
export const TARGET_WINDOW_MS = 180_000;
export const STEP_LADDER_MS = Object.freeze([1000, 2000, 3000, 5000] as const);
/** Below this the timeline is not worth drawing (the tier rule keeps A/B above it). */
export const MIN_TIMELINE_CELLS = 12;
/** `[██░░] 42%` at the timeline's four-cell bar (§C). */
export const TIMELINE_CONTEXT_WIDTH = 12;
export const CONTEXT_BAR_CELLS = 4;
/** Columns between two clock labels on the axis. */
export const AXIS_TICK_EVERY = 10;
/** Visible width of `HH:MM:SS`. */
export const AXIS_TIME_WIDTH = 8;
export const AXIS_NOW_LABEL = "现在";

/** One column = one interval; the rightmost cell is the in-progress one. */
export interface TimelineWindow {
  readonly step: number;
  readonly cells: number;
  /** Start of the rightmost (current) cell, quantised to `step`. */
  readonly anchor: number;
  /** Set when the window is frozen at the last activity instead of at `now`. */
  readonly frozenAt?: number;
}

export interface ResolveWindowInput {
  now: number;
  laneWidth: number;
  lastActivityAt?: number;
  /** Any member is working/compacting or has an active record. */
  live: boolean;
}

const size = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/** Closest total span to three minutes; ties keep the smaller (finer) step. */
export function pickStep(cells: number): number {
  const count = size(cells);
  let best: number = STEP_LADDER_MS[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const step of STEP_LADDER_MS) {
    const delta = Math.abs(count * step - TARGET_WINDOW_MS);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = step;
    }
  }
  return best;
}

/**
 * Right edge = the current cell. While anything is live (or the last activity is
 * still inside the window) the window slides with `now`; once the whole team has
 * been idle for longer than the window it freezes so the last activity stays
 * visible instead of showing an empty screen.
 */
export function resolveWindow(input: ResolveWindowInput): TimelineWindow {
  const cells = size(input.laneWidth);
  const step = pickStep(cells);
  const now = Number.isFinite(input.now) ? input.now : 0;
  const slide = Math.floor(now / step) * step;
  const last = input.lastActivityAt;
  const leftEdge = slide - Math.max(0, cells - 1) * step;
  const frozen = cells > 0 && !input.live &&
    last !== undefined && Number.isFinite(last) && last < leftEdge;
  const anchor = frozen ? Math.floor(last! / step) * step : slide;
  return frozen ? { step, cells, anchor, frozenAt: last! } : { step, cells, anchor };
}

/** Start instant of cell `index`; the rightmost cell starts at `anchor`. */
export function cellStart(window: TimelineWindow, index: number): number {
  return window.anchor - (window.cells - 1 - index) * window.step;
}

/**
 * Cell index covering `at`. Values left of the window yield negative indices
 * (callers skip them); values at or after the right edge clamp to the last cell.
 */
export function cellIndexAt(window: TimelineWindow, at: number): number {
  const cells = size(window.cells);
  if (!cells || !Number.isFinite(at) || !Number.isFinite(window.anchor) || !(window.step > 0)) return -1;
  const back = Math.max(0, Math.ceil((window.anchor - at) / window.step));
  return cells - 1 - back;
}

export interface LaneCell {
  readonly cls: OpClass;
  /** First visible cell of a record's run → drawn as a solid block. */
  readonly start: boolean;
}

/** One symbol per cell; a record only wins a cell when nothing stronger is there. */
type RecordClass = Exclude<OpClass, "idle" | "unknown">;
const PRIORITY: Record<RecordClass, number> = {
  crash: 100, stop: 95, compact: 80, failed: 70,
  modify: 60, read: 55, tool: 50,
  output: 40, thinking: 30, complete: 20, busySilent: 10,
};

function classOf(action: OverviewAction): RecordClass | undefined {
  switch (action.kind) {
    case "crashed": return "crash";
    case "stopped": return "stop";
    case "complete": return "complete";
    case "compacting": return "compact";
    case "thinking": return "thinking";
    case "output": return "output";
    case "read":
    case "modify":
    case "tool":
      return action.status === "error" ? "failed" : action.kind;
    default: return undefined;
  }
}

function endOf(action: OverviewAction, window: TimelineWindow): number {
  if (action.endedAt !== undefined && Number.isFinite(action.endedAt)) return action.endedAt;
  // An open record runs into the current cell; everything else is a point event
  // when the store could not record an end.
  return action.status === "active" ? window.anchor + window.step : action.at;
}

export function paintLane(
  actions: readonly OverviewAction[], info: TimelineInfo | undefined, window: TimelineWindow,
): LaneCell[] {
  const count = size(window.cells);
  if (!count) return [];
  const classes: (OpClass | undefined)[] = new Array(count);
  const ranks: number[] = new Array(count).fill(Number.NEGATIVE_INFINITY);
  const owners: (number | undefined)[] = new Array(count);

  const cover = (from: number, to: number): [number, number] | undefined => {
    const first = cellIndexAt(window, from);
    const last = to > from ? cellIndexAt(window, to - 1) : first;
    if (last < 0) return undefined; // entirely left of the window
    const lo = Math.max(0, Math.min(first, last));
    const hi = Math.min(count - 1, Math.max(first, last));
    return lo <= hi ? [lo, hi] : undefined;
  };
  const consider = (range: [number, number], rank: number, cls: OpClass, owner: number): void => {
    for (let index = range[0]; index <= range[1]; index++) {
      if (rank > ranks[index]!) {
        ranks[index] = rank;
        classes[index] = cls;
        owners[index] = owner;
      }
    }
  };

  for (const action of actions) {
    const cls = classOf(action);
    // Invalid timestamps must never produce a NaN column (appendix D guard).
    if (!cls || !Number.isFinite(action.at) || action.at < 0) continue;
    const end = endOf(action, window);
    const range = cover(action.at, Number.isFinite(end) && end > action.at ? end : action.at);
    if (range) consider(range, PRIORITY[cls], cls, action.id);
  }
  if (info) {
    const rightEdge = window.anchor + window.step;
    for (const turn of info.turns) {
      const [start, end] = turn;
      if (!Number.isFinite(start) || start < 0) continue;
      // A closed turn spans its own interval; a degenerate one still owns one cell.
      const stop = Number.isFinite(end) ? Math.max(end, start + 1) : rightEdge;
      const range = cover(start, stop);
      if (range) consider(range, PRIORITY.busySilent, "busySilent", -1);
    }
    if (info.openTurnStart !== undefined && Number.isFinite(info.openTurnStart) && info.openTurnStart >= 0) {
      const range = cover(info.openTurnStart, rightEdge);
      if (range) consider(range, PRIORITY.busySilent, "busySilent", -1);
    }
  }

  const observedFrom = info?.knownFrom;
  const observed = observedFrom !== undefined && Number.isFinite(observedFrom);
  const cells: LaneCell[] = [];
  for (let index = 0; index < count; index++) {
    const cls = classes[index] ??
      (observed && cellStart(window, index) >= observedFrom! ? "idle" : "unknown");    const owner = owners[index];
    const previousCls = index > 0 ? cells[index - 1]!.cls : undefined;
    // Solid start for every visible run: a new record, or a run resuming after a
    // stronger record covered the previous cell.
    const start = index === 0 || cls !== previousCls ||
      (owner !== undefined && owner !== owners[index - 1]);
    cells.push({ cls, start });
  }
  return cells;
}

/** One column per glyph (§E); every glyph measures exactly one column. */
export const GLYPH = Object.freeze({
  start: "█",
  continuation: "▓",
  compactStart: "█",
  compactContinuation: "▒",
  crash: "!",
  stop: "-",
  complete: "·",
  busySilent: "▁",
  unknown: "░",
  idle: " ",
});

const FOREGROUND_RESET = "\x1b[39m";

function glyphOf(cell: LaneCell): string {
  switch (cell.cls) {
    case "crash": return GLYPH.crash;
    case "stop": return GLYPH.stop;
    case "complete": return GLYPH.complete;
    case "compact": return cell.start ? GLYPH.compactStart : GLYPH.compactContinuation;
    case "busySilent": return GLYPH.busySilent;
    case "unknown": return GLYPH.unknown;
    case "idle": return GLYPH.idle;
    default: return cell.start ? GLYPH.start : GLYPH.continuation;
  }
}

/** Merge adjacent same-colour glyphs; the only reset is the trailing foreground one. */
function emitRuns(entries: readonly { prefix: string; glyph: string }[]): string {
  let out = "";
  let run = "";
  let current: string | undefined;
  let colored = false;
  const flush = () => {
    if (!run) return;
    out += (current ?? "") + run;
    run = "";
  };
  for (const entry of entries) {
    if (entry.glyph === GLYPH.idle) {
      flush();
      out += GLYPH.idle;
      continue;
    }
    if (entry.prefix !== current) {
      flush();
      current = entry.prefix;
    }
    run += entry.glyph;
    if (entry.prefix) colored = true;
  }
  flush();
  return colored ? out + FOREGROUND_RESET : out;
}

export function buildLaneText(cells: readonly LaneCell[], source?: PaletteSource): string {
  if (!cells.length) return "";
  return emitRuns(cells.map(cell => ({
    prefix: !source || cell.cls === "idle" ? "" : resolveAnsi(cell.cls, source),
    glyph: glyphOf(cell),
  })));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local wall-clock label; invalid instants keep the fixed width of the field. */
export function formatClock(at: number): string {
  if (!Number.isFinite(at)) return "??:??:??";
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * Clock axis for the shared window: labels sit on cell boundaries, the right edge
 * carries "现在" (or the frozen instant). Exactly `width` columns.
 */
export function buildAxisLine(
  window: TimelineWindow, width: number, theme: InspectorTheme = IDENTITY_THEME,
): string {
  const total = size(width);
  if (!total) return "";
  const lane = Math.min(total, size(window.cells));
  const prefix = " ".repeat(Math.max(0, total - lane));
  const buffer: string[] = new Array(lane).fill(" ");
  const put = (start: number, text: string): void => {
    let column = start;
    for (const char of Array.from(text)) {
      const charWidth = visibleWidth(char);
      if (!charWidth) continue;
      if (column < 0 || column + charWidth > lane) return;
      buffer[column] = char;
      for (let offset = 1; offset < charWidth; offset++) buffer[column + offset] = "";
      column += charWidth;
    }
  };
  const right = window.frozenAt !== undefined ? formatClock(window.frozenAt) : AXIS_NOW_LABEL;
  const rightWidth = visibleWidth(right);
  if (rightWidth <= lane) {
    // Labels end on their boundary column, so every label reads as "up to here".
    let limit = lane - rightWidth;
    put(limit, right);
    for (let back = AXIS_TICK_EVERY; ; back += AXIS_TICK_EVERY) {
      const boundary = lane - 1 - back;
      const start = boundary - AXIS_TIME_WIDTH + 1;
      if (start < 0) break;
      if (start + AXIS_TIME_WIDTH > limit - 1) continue; // keep one blank column
      put(start, formatClock(cellStart(window, boundary)));
      limit = start;
    }
  }
  return fit(theme.fg("dim", prefix + buffer.join("")), total);
}

export interface TimelineRow extends OverviewRow {
  /** P1 evidence; absent means "never observed", so the whole lane is striped. */
  info?: TimelineInfo;
}

export interface TimelineView {
  /** Team-wide last activity (store query); derived from the rows when absent. */
  lastActivityAt?: number;
  /** Team-wide live flag (control plane); derived from the rows when absent. */
  live?: boolean;
  palette?: PaletteSource;
}

/** Name column width (§C): the same formula as the icon trail, without the counter reserve. */
export function timelineNameWidth(width: number): number {
  return Math.min(18, Math.max(4, Math.floor(size(width) / 6)));
}

/** Columns before the lane: marker + name + gaps + badge + context. */
export function timelinePrefixWidth(nameWidth: number, badgeWidth: number): number {
  return 2 + nameWidth + 1 + badgeWidth + 1 + TIMELINE_CONTEXT_WIDTH + 1;
}

export function timelineLaneWidth(width: number, badgeWidth: number): number {
  return size(width) - timelinePrefixWidth(timelineNameWidth(width), badgeWidth);
}

export function timelineTier(width: number): BadgeTier | "fallback" {
  return pickTier(badgeWidth => timelineLaneWidth(width, badgeWidth));
}

function isLiveRow(row: TimelineRow): boolean {
  return row.state === "working" || row.state === "compacting" ||
    row.actions.some(action => action.status === "active");
}

function latestActivityOf(rows: readonly TimelineRow[]): number | undefined {
  let latest: number | undefined;
  for (const row of rows)
    for (const action of row.actions) {
      const at = action.endedAt ?? action.at;
      if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
    }
  return latest;
}

function turnStartOf(info: TimelineInfo | undefined): number | undefined {
  if (!info) return undefined;
  if (info.openTurnStart !== undefined) return info.openTurnStart;
  const last = info.turns.at(-1);
  return last?.[0];
}

function hasActionThisTurn(row: TimelineRow): boolean {
  const start = turnStartOf(row.info);
  if (start === undefined) return false;
  return row.actions.some(action => Number.isFinite(action.at) && action.at >= start);
}

function wordOf(row: TimelineRow) {
  const latest = row.actions.at(-1);
  return statusWord({
    state: row.state,
    ...(row.phase !== undefined ? { phase: row.phase } : {}),
    ...(latest !== undefined ? { latest } : {}),
    turnOpen: row.info?.openTurnStart !== undefined,
    hasActionThisTurn: hasActionThisTurn(row),
  });
}

function markerFor(selected: boolean, width: number): string {
  if (width > 1) return selected ? "› " : "  ";
  return width === 1 ? (selected ? "›" : " ") : "";
}

/** Newest record on the left, one block per record (degraded narrow mode, §3.8). */
function buildBlockText(
  actions: readonly OverviewAction[], limit: number, source?: PaletteSource,
): string {
  const classes: OpClass[] = [];
  for (let index = actions.length - 1; index >= 0 && classes.length < limit; index--) {
    const cls = classOf(actions[index]!);
    if (cls) classes.push(cls);
  }
  if (!classes.length) return "";
  return emitRuns(classes.map(cls => ({
    prefix: source ? resolveAnsi(cls, source) : "",
    glyph: GLYPH.start,
  })));
}

function buildFallbackLines(
  rows: readonly TimelineRow[], selectedName: string | undefined, offset: number,
  height: number, width: number, theme: InspectorTheme, view: TimelineView,
): string[] {
  const badgeWidth = BADGE_WIDTH[2];
  // marker + gap + badge + gap; the rest is name + blocks, split by the shared name formula.
  const fixed = 2 + 1 + badgeWidth + 1;
  const nameWidth = Math.min(timelineNameWidth(width), Math.max(0, width - fixed));
  const blocks = Math.max(0, width - fixed - nameWidth);
  const start = getOverviewWindowOffset(rows, selectedName, offset, height);
  const duplicates = duplicateLabels(rows);
  const lines: string[] = [];
  for (const row of rows.slice(start, start + height)) {
    const selected = row.name === selectedName;
    let label = shorten(memberLabel(row, duplicates), nameWidth);
    if (selected && theme.bold) label = theme.bold(label);
    const line = markerFor(selected, width) + fit(label, nameWidth) + (nameWidth ? " " : "") +
      badgeText(wordOf(row), 2) +
      (blocks ? " " + buildBlockText(row.actions, blocks, view.palette) : "");
    lines.push(fit(line, width));
  }
  while (lines.length < height) lines.push(" ".repeat(width));
  return lines;
}

/**
 * Exactly `height` physical lines of exactly `width` columns:
 * optional axis line first (height ≥ 3), then member rows in roster order.
 */
export function buildTimelineLines(
  rows: readonly TimelineRow[], selectedName: string | undefined, offset: number,
  height: number, width: number, now: number,
  theme: InspectorTheme = IDENTITY_THEME, view: TimelineView = {},
): string[] {
  const total = size(width);
  const lines = size(height);
  if (!lines) return [];
  if (!rows.length) {
    const empty = [fit(theme.fg("muted", "暂无成员"), total)];
    while (empty.length < lines) empty.push(" ".repeat(total));
    return empty;
  }
  const tier = timelineTier(total);
  if (tier === "fallback") return buildFallbackLines(rows, selectedName, offset, lines, total, theme, view);

  const badgeWidth = BADGE_WIDTH[tier];
  const nameWidth = timelineNameWidth(total);
  const laneWidth = Math.max(0, timelineLaneWidth(total, badgeWidth));
  const lastActivityAt = view.lastActivityAt ?? latestActivityOf(rows);
  const window = resolveWindow({
    now,
    laneWidth,
    live: view.live ?? rows.some(isLiveRow),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
  });
  const showAxis = lines >= 3 && laneWidth >= MIN_TIMELINE_CELLS;
  const capacity = Math.max(1, lines - (showAxis ? 1 : 0));
  const start = getOverviewWindowOffset(rows, selectedName, offset, capacity);
  const duplicates = duplicateLabels(rows);
  const output: string[] = [];
  if (showAxis) output.push(buildAxisLine(window, total, theme));
  for (const row of rows.slice(start, start + capacity)) {
    const selected = row.name === selectedName;
    let label = shorten(memberLabel(row, duplicates), nameWidth);
    if (selected && theme.bold) label = theme.bold(label);
    const context = fit(contextBar(row, CONTEXT_BAR_CELLS, theme), TIMELINE_CONTEXT_WIDTH);
    const lane = buildLaneText(paintLane(row.actions, row.info, window), view.palette);
    output.push(fit(
      markerFor(selected, total) + fit(label, nameWidth) + " " + badgeText(wordOf(row), tier) +
      " " + context + " " + lane,
      total,
    ));
  }
  while (output.length < lines) output.push(" ".repeat(total));
  return output;
}
