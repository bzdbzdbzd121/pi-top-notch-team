import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { ActivityPhase } from "../channel/activity-tracker";
import type { MemberOperationalState } from "../session/context";
import type { InspectorTheme } from "./member-inspector-state";
import type { OverviewAction, OverviewActionKind } from "./member-overview-store";

export interface OverviewRow {
  name: string;
  label: string;
  state: MemberOperationalState;
  phase?: ActivityPhase;
  percent: number | null | undefined;
  contextStale?: boolean;
  actions: readonly OverviewAction[];
  /** Session total, including evicted records; omitted by legacy callers. */
  actionCount?: number;
  started?: boolean;
}

type Member = { name: string; label: string };
type View = { kind: "overview" } | { kind: "member"; name: string };
const identity: InspectorTheme = { fg: (_color, text) => text };
const MAX_TRAIL_ICONS = 20;
const ICONS: Record<OverviewActionKind, string> = {
  thinking: "💭", output: "✏️", read: "📖", modify: "📝", tool: "🔧",
  complete: "✅", compacting: "🗜️", crashed: "💥", stopped: "⏹️",
};

const size = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
function actionTotal(actions: readonly OverviewAction[], count?: number): number {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= actions.length ? count : actions.length;
}
// Names are untrusted display text; do not allow terminal commands or newlines.
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function shorten(text: string, width: number): string {
  return width > 0 ? truncateToWidth(text, width, "…") : "";
}
function duplicateLabels(members: readonly Member[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const member of members) {
    const label = clean(member.label);
    if (seen.has(label)) duplicates.add(label);
    seen.add(label);
  }
  return duplicates;
}
function memberLabel(member: Member, duplicates: Set<string>): string {
  const label = clean(member.label) || clean(member.name);
  return duplicates.has(clean(member.label)) ? `${clean(member.name)}(${label})` : label;
}

/** Every body line holds a member; there is no table header to subtract. */
export function getOverviewWindowOffset(
  rows: readonly Member[], selectedName: string | undefined, offset: number, height: number,
): number {
  const capacity = size(height);
  if (!capacity || !rows.length) return 0;
  let start = Math.min(size(offset), Math.max(0, rows.length - capacity));
  const selected = selectedName === undefined ? -1 : rows.findIndex(row => row.name === selectedName);
  if (selected >= 0 && selected < start) start = selected;
  if (selected >= start + capacity) start = selected - capacity + 1;
  return start;
}

interface CurrentAction {
  kind: OverviewActionKind;
  status: OverviewAction["status"];
  color?: string;
  reuseLatest: boolean;
}
function currentAction(row: OverviewRow): CurrentAction {
  let kind: OverviewActionKind = "thinking";
  let status: OverviewAction["status"] = "active";
  let color: string | undefined;
  const latest = row.actions.at(-1);
  if (row.state === "compacting") { kind = "compacting"; color = "warning"; }
  else if (row.state === "crashed") { kind = "crashed"; status = "error"; color = "error"; }
  else if (row.state === "stopped") { kind = "stopped"; status = "done"; color = "muted"; }
  else if (row.state === "idle") { kind = "complete"; status = "done"; color = "muted"; }
  else if (row.phase === "executing") {
    // Keep an active read/write icon specific rather than showing a second 🔧.
    kind = latest?.status === "active" && ["read", "modify", "tool"].includes(latest.kind) ? latest.kind : "tool";
    color = "warning";
  } else if (row.phase === "tool-calling") { kind = "tool"; color = "warning"; }
  else if (row.phase === "output") { kind = "output"; color = "success"; }
  else if (row.phase === "thinking") color = "accent";
  const reuseLatest = latest?.kind === kind &&
    (latest.status === "active" || status !== "active" || kind === "compacting");
  return { kind, status, color, reuseLatest };
}
function contextValue(row: OverviewRow): string {
  if (row.state === "stopped" || row.state === "crashed") return "—";
  if (typeof row.percent !== "number" || !Number.isFinite(row.percent)) return "?";
  return `${row.contextStale ? "~" : ""}${Math.round(row.percent)}%`;
}
function contextBar(row: OverviewRow, cells: number, theme: InspectorTheme): string {
  const value = contextValue(row);
  if (!cells || value === "—") return value;
  if (typeof row.percent !== "number" || !Number.isFinite(row.percent))
    return theme.fg("muted", `[${"·".repeat(cells)}]`) + " ?";
  const filled = Math.round(Math.max(0, Math.min(100, row.percent)) * cells / 100);
  const color = row.contextStale ? "muted" : row.percent >= 90 ? "error" : row.percent >= 75 ? "warning" : "success";
  return "[" + theme.fg(color, "█".repeat(filled)) + theme.fg("muted", "░".repeat(cells - filled)) + "] " + value;
}

/** Newest first; at most 20 complete icons, reserving space for the hidden count. */
export function buildOverviewTrail(
  actions: readonly OverviewAction[], width: number, theme: InspectorTheme = identity,
  current?: CurrentAction, totalActionCount?: number,
): string {
  width = size(width);
  if (!width) return "";
  const total = actionTotal(actions, totalActionCount);
  if (!actions.length && !current && !total) return "—";
  const historyEnd = actions.length - (current?.reuseLatest ? 1 : 0);
  const entries: { action: Pick<OverviewAction, "kind" | "status">; record: boolean; current: boolean }[] = [];
  if (current) entries.push({ action: current, record: current.reuseLatest, current: true });
  for (let index = historyEnd - 1; index >= 0; index--)
    entries.push({ action: actions[index], record: true, current: false });
  const renderIcon = (entry: typeof entries[number]) => {
    let icon = ICONS[entry.action.kind];
    const color = entry.current ? current?.color : entry.action.status === "error" ? "error" : entry.action.status === "active" ? "accent" : undefined;
    if (color) icon = theme.fg(color, icon);
    if (entry.action.status !== "done") icon = `\x1b[4m${icon}\x1b[24m`;
    return icon;
  };
  const minimum = current ? 1 : 0;
  for (let count = Math.min(MAX_TRAIL_ICONS, entries.length); count >= minimum; count--) {
    const shown = entries.slice(0, count);
    const hidden = total - shown.filter(entry => entry.record).length;
    const suffix = hidden > 0 ? `(${hidden})` : "";
    const iconColumns = shown.reduce((sum, entry) => sum + visibleWidth(ICONS[entry.action.kind]), 0) + Math.max(0, count - 1);
    if (iconColumns + (suffix && count ? 1 : 0) + suffix.length > width) continue;
    const trail = shown.map(renderIcon).join(" ");
    return trail + (trail && suffix ? " " : "") + suffix;
  }
  // At impossibly narrow widths retain the live/current icon before a counter.
  const first = entries[0];
  return first && visibleWidth(ICONS[first.action.kind]) <= width ? renderIcon(first) : "";
}

/** Exactly height physical lines, each exactly width visible terminal columns. */
export function buildOverviewLines(
  rows: readonly OverviewRow[], selectedName: string | undefined, offset: number,
  height: number, width: number, theme: InspectorTheme = identity,
): string[] {
  height = size(height);
  width = size(width);
  if (!height) return [];
  const start = getOverviewWindowOffset(rows, selectedName, offset, height);
  const lines: string[] = [];
  const duplicates = duplicateLabels(rows);
  let barCells = width >= 72 ? 10 : width >= 42 ? 8 : width >= 30 ? 5 : width >= 26 ? 3 : width >= 24 ? 2 : 0;
  const valueWidth = width < 24 ? rows.reduce((max, row) => Math.max(max, contextValue(row).length), 1) : 5;
  const recordCount = rows.reduce((max, row) => Math.max(max, actionTotal(row.actions, row.actionCount)), 0);
  // Preserve the complete growing counter plus a live icon and two name columns.
  const minimumTrail = recordCount ? 3 + `(${recordCount})`.length : 2;
  while (barCells && width < 2 + 2 + 2 + valueWidth + barCells + 3 + minimumTrail)
    barCells = barCells > 2 ? barCells - 1 : 0;
  const contextWidth = valueWidth + (barCells ? barCells + 3 : 0);
  const nameWidth = Math.max(0, Math.min(18, Math.max(4, Math.floor(width / 6)), width - 2 - contextWidth - 2 - minimumTrail));
  for (const row of rows.slice(start, start + height)) {
    const current = currentAction(row);
    const selected = row.name === selectedName;
    const marker = width > 1 ? (selected ? "› " : "  ") : (selected ? "›" : " ");
    let label = memberLabel(row, duplicates);
    let line: string;
    if (width < 14) {
      const value = contextValue(row);
      const icon = buildOverviewTrail([], 2, theme, { ...current, reuseLatest: false });
      const remaining = width - visibleWidth(marker) - visibleWidth(value) - visibleWidth(icon) - 2;
      line = marker + (remaining > 0 ? shorten(label, remaining) + " " : "") + value + " " + icon;
    } else {
      label = shorten(label, nameWidth);
      if (selected && theme.bold) label = theme.bold(label);
      line = marker + fit(label, nameWidth) + " " + fit(contextBar(row, barCells, theme), contextWidth) + " ";
      line += buildOverviewTrail(row.actions, Math.max(0, width - visibleWidth(line)), theme, current, row.actionCount);
    }
    lines.push(fit(line, width));
  }
  if (!rows.length) lines.push(fit(theme.fg("muted", "暂无成员"), width));
  while (lines.length < height) lines.push(" ".repeat(width));
  return lines;
}

/** Pinned overview plus a contiguous member window around the current page. */
export function buildInspectorHeader(
  members: readonly Member[], view: View, selectedName: string | undefined,
  width: number, theme: InspectorTheme = identity,
): string {
  width = size(width);
  if (!width) return "";
  const overviewText = width < 12 && members.length ? "总" : "总览";
  const overview = view.kind === "overview" ? `❰${overviewText}❱` : overviewText;
  const overviewWidth = visibleWidth(overview);
  if (width < overviewWidth) return fit(theme.fg("accent", width < 4 ? "总" : "总览"), width);
  if (!members.length || width <= overviewWidth + 2) return fit(theme.fg("accent", overview), width);
  const duplicates = duplicateLabels(members);
  const focus = view.kind === "member" ? view.name : selectedName;
  const target = Math.max(0, members.findIndex(member => member.name === focus));
  const active = (index: number) => view.kind === "member" && members[index].name === view.name;
  const labels = members.map(member => memberLabel(member, duplicates));
  const naturalWidth = (index: number) => Math.min(20, visibleWidth(labels[index]) + (active(index) ? 2 : 0));
  let start = target;
  let end = target + 1;
  const cost = (a: number, b: number) => {
    let result = overviewWidth + 1 + (a > 0 ? 1 : 0) + (b < members.length ? 1 : 0);
    for (let i = a; i < b; i++) result += naturalWidth(i) + (i > a ? 1 : 0);
    return result;
  };
  let changed = true;
  while (changed) {
    changed = false;
    if (end < members.length && cost(start, end + 1) <= width) { end++; changed = true; }
    if (start > 0 && cost(start - 1, end) <= width) { start--; changed = true; }
  }
  const left = start > 0 ? "‹" : "";
  const right = end < members.length ? "›" : "";
  let budget = width - overviewWidth - 1 - left.length - right.length;
  const cells: string[] = [];
  for (let i = start; i < end; i++) {
    const cellWidth = Math.min(naturalWidth(i), budget);
    let cell: string;
    if (active(i) && cellWidth >= 3) cell = `❰${shorten(labels[i], cellWidth - 2)}❱`;
    else cell = shorten(labels[i], cellWidth);
    if (active(i)) cell = theme.fg("accent", theme.bold ? theme.bold(cell) : cell);
    cells.push(cell);
    budget -= visibleWidth(cell) + 1;
  }
  const styledOverview = view.kind === "overview" ? theme.fg("accent", overview) : theme.fg("muted", overview);
  return fit(`${styledOverview} ${left}${cells.join(" ")}${right}`, width);
}
