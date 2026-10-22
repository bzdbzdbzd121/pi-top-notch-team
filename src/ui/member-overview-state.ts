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
  started?: boolean;
}

type Member = { name: string; label: string };
type View = { kind: "overview" } | { kind: "member"; name: string };
const identity: InspectorTheme = { fg: (_color, text) => text };
const ICONS: Record<OverviewActionKind, string> = {
  thinking: "💭", output: "✏️", read: "📖", modify: "📝", tool: "🔧",
  complete: "✅", compacting: "🗜️", crashed: "💥", stopped: "⏹️",
};

const size = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
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
  // Put identity first: even long identical labels must not hide the disambiguator.
  return duplicates.has(clean(member.label)) ? `${clean(member.name)}(${label})` : label;
}

/** Offset counts members, not the fixed table header. Selection is always visible. */
export function getOverviewWindowOffset(
  rows: readonly Member[], selectedName: string | undefined, offset: number, height: number,
): number {
  const capacity = Math.max(0, size(height) - 1);
  if (!capacity || !rows.length) return 0;
  let start = Math.min(size(offset), Math.max(0, rows.length - capacity));
  const selected = selectedName === undefined ? -1 : rows.findIndex(row => row.name === selectedName);
  if (selected >= 0 && selected < start) start = selected;
  if (selected >= start + capacity) start = selected - capacity + 1;
  return start;
}

function status(row: OverviewRow): { icon: string; text: string; short: string; color?: string } {
  if (row.state === "compacting") return { icon: ICONS.compacting, text: "压缩中", short: "压缩", color: "warning" };
  if (row.state === "crashed") return { icon: ICONS.crashed, text: "崩溃", short: "崩溃", color: "error" };
  if (row.state === "stopped") return { icon: ICONS.stopped, text: row.started === false ? "未启动" : "已停止", short: row.started === false ? "未启" : "停止", color: "muted" };
  switch (row.phase) {
    case "thinking": return { icon: ICONS.thinking, text: "思考中", short: "思考", color: "accent" };
    case "tool-calling": return { icon: ICONS.tool, text: "准备调用", short: "调用", color: "warning" };
    case "executing": return { icon: ICONS.tool, text: "执行工具", short: "执行", color: "warning" };
    case "output": return { icon: ICONS.output, text: "输出中", short: "输出", color: "success" };
    case "working": return { icon: ICONS.thinking, text: "工作中", short: "工作" };
  }
  return row.state === "working"
    ? { icon: ICONS.thinking, text: "工作中", short: "工作" }
    : { icon: ICONS.complete, text: "空闲", short: "空闲", color: "muted" };
}
function context(row: OverviewRow): string {
  if (row.state === "stopped" || row.state === "crashed") return "—";
  if (typeof row.percent !== "number" || !Number.isFinite(row.percent)) return "?";
  return `${row.contextStale ? "~" : ""}${Math.round(row.percent)}%`;
}

/** Longest complete suffix; repeated reads remain separate positions. No action text. */
export function buildOverviewTrail(
  actions: readonly OverviewAction[], width: number, theme: InspectorTheme = identity,
): string {
  width = size(width);
  if (!actions.length) return width ? "—" : "";
  let start = actions.length;
  let used = 0;
  while (start > 0) {
    const iconWidth = visibleWidth(ICONS[actions[start - 1].kind]);
    const nextWidth = used + iconWidth + (start < actions.length ? 1 : 0);
    if (nextWidth > width) break;
    used = nextWidth;
    start--;
  }
  return actions.slice(start).map(action => {
    let icon = ICONS[action.kind];
    if (action.status === "error") icon = theme.fg("error", icon);
    else if (action.status === "active") icon = theme.fg("accent", icon);
    if (action.status !== "done") icon = `\x1b[4m${icon}\x1b[24m`;
    return icon;
  }).join(" ");
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
  const capacity = height - 1;
  const count = Math.min(capacity, rows.length - start);
  const range = rows.length && count ? ` ${start + 1}–${start + count} / ${rows.length}` : "";
  const title = width >= 58 ? `成员${range}  当前状态  上下文  最近操作（新→右）` : `成员${range}  状态  %`;
  const lines = [fit(theme.fg("muted", title), width)];
  const duplicates = duplicateLabels(rows);
  // Fixed columns win over the trail. Narrow mode uses short, explicit states.
  const full = width >= 42;
  const stateWidth = full ? 11 : 7;
  const contextWidth = 5;
  const nameWidth = full ? Math.min(18, Math.max(8, Math.floor(width / 5))) : Math.max(0, width - 2 - stateWidth - contextWidth - 2);
  for (const row of rows.slice(start, start + capacity)) {
    const s = status(row);
    const percent = context(row);
    const selected = row.name === selectedName;
    let line: string;
    if (width < 18) {
      // Selection must survive even when fixed columns cannot fit. Reserve its
      // marker first, then retain status + usage before the member name.
      const marker = width > 1 ? (selected ? "› " : "  ") : (selected ? "›" : " ");
      const minimal = `${s.icon} ${percent}`;
      const remaining = width - visibleWidth(marker) - visibleWidth(minimal) - 1;
      line = marker + (remaining > 0 ? `${minimal} ${shorten(memberLabel(row, duplicates), remaining)}` : minimal);
      if (s.color) line = theme.fg(s.color, line);
    } else {
      let label = shorten(memberLabel(row, duplicates), nameWidth);
      if (selected && theme.bold) label = theme.bold(label);
      const stateText = `${s.icon} ${full ? s.text : s.short}`;
      const styledState = s.color ? theme.fg(s.color, stateText) : stateText;
      line = `${selected ? "› " : "  "}${fit(label, nameWidth)} ${fit(styledState, stateWidth)} ${fit(percent, contextWidth)}`;
      const trailWidth = width - visibleWidth(line) - 1;
      if (trailWidth > 0) line += ` ${buildOverviewTrail(row.actions, trailWidth, theme)}`;
    }
    lines.push(fit(line, width));
  }
  if (!rows.length && capacity) lines.push(fit(theme.fg("muted", "暂无成员"), width));
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
  // Grow a contiguous window; alternating sides keeps focus near its center.
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
