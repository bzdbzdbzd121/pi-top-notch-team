import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { ActivityPhase } from "../channel/activity-tracker";
import type { MemberOperationalState } from "../session/context";
import { IDENTITY_THEME, type InspectorTheme } from "./member-inspector-state";
import type { OverviewAction } from "./member-overview-store";

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
/** Marker field width: `› ` (selected) or two spaces — shared with the timeline. */
export const MARKER_WIDTH = 2;
/** `› ` / `  ` / single-column degenerate form. */
export function markerFor(selected: boolean, width: number): string {
  if (width > 1) return selected ? "› " : "  ";
  return width === 1 ? (selected ? "›" : " ") : "";
}
/** Name column width before any layout-specific reserve (§C). */
export function memberNameWidth(width: number): number {
  const total = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  return Math.min(18, Math.max(4, Math.floor(total / 6)));
}
const size = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
// Names are untrusted display text; do not allow terminal commands or newlines.
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
export function shorten(text: string, width: number): string {
  return width > 0 ? truncateToWidth(text, width, "…") : "";
}
export function duplicateLabels(members: readonly Member[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const member of members) {
    const label = clean(member.label);
    if (seen.has(label)) duplicates.add(label);
    seen.add(label);
  }
  return duplicates;
}
export function memberLabel(member: Member, duplicates: Set<string>): string {
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

function contextValue(row: OverviewRow): string {
  if (row.state === "stopped" || row.state === "crashed") return "—";
  if (typeof row.percent !== "number" || !Number.isFinite(row.percent)) return "?";
  return `${row.contextStale ? "~" : ""}${Math.round(row.percent)}%`;
}
export function contextBar(row: OverviewRow, cells: number, theme: InspectorTheme): string {
  const value = contextValue(row);
  if (!cells || value === "—") return value;
  if (typeof row.percent !== "number" || !Number.isFinite(row.percent))
    return theme.fg("muted", `[${"·".repeat(cells)}]`) + " ?";
  const filled = Math.round(Math.max(0, Math.min(100, row.percent)) * cells / 100);
  const color = row.contextStale ? "muted" : row.percent >= 90 ? "error" : row.percent >= 75 ? "warning" : "success";
  return "[" + theme.fg(color, "█".repeat(filled)) + theme.fg("muted", "░".repeat(cells - filled)) + "] " + value;
}

/** Pinned overview plus a contiguous member window around the current page. */
export function buildInspectorHeader(
  members: readonly Member[], view: View, selectedName: string | undefined,
  width: number, theme: InspectorTheme = IDENTITY_THEME,
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
