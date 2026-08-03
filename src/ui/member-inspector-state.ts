import { visibleWidth } from "@earendil-works/pi-tui";

// ── Member Inspector State (pure logic, no TUI dependencies) ──
//
// This module holds the Member Inspector's display state and pure
// line-building functions. It is intentionally free of ExtensionAPI /
// TUI handles so it can be unit-tested in isolation. The TUI glue lives
// in member-inspector.ts.

// ── Theme shape (identity-compatible for tests) ────────────

export interface InspectorTheme {
  fg: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export const IDENTITY_THEME: InspectorTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

// ── Types ──────────────────────────────────────────────────

export interface MemberContextInfo {
  percent: number;
  tokens: number;
  contextWindow: number;
}

export interface InspectorTab {
  name: string;
  label: string;
  /** Pre-built body display lines (built from fetched messages). */
  lines: string[];
  /** Top visible line index into `lines`. */
  scrollOffset: number;
  /** True when the view is pinned to the latest content. */
  followTail: boolean;
  /** Tool call / result detail expansion toggle. */
  expanded: boolean;
  /** Thinking block visibility toggle. */
  showThinking: boolean;
  /** New content arrived while not following tail. */
  newBelow: boolean;
  /** Dirty flag set by member activity events; cleared after refetch. */
  dirty: boolean;
  contextInfo: MemberContextInfo | null;
}

export type MemberOpState = "idle" | "working" | "compacting" | "crashed" | "stopped";

// ── Constants ──────────────────────────────────────────────

/** Max lines shown for an expanded tool call's arguments. */
export const EXPANDED_ARGS_MAX_LINES = 40;
/** Max lines shown for an expanded tool result's content. */
export const EXPANDED_RESULT_MAX_LINES = 60;
/**
 * Navigation key hints for the footer. The expand/collapse hint reflects
 * the active tab's current expansion state (press `e` to toggle).
 * Note: ctrl+m is indistinguishable from Enter in terminals, so compact
 * uses ctrl+o.
 */
export function buildNavHints(expanded: boolean, showThinking: boolean): string {
  const expandHint = expanded ? "e 折叠详情" : "e 展开详情";
  const thinkingHint = showThinking ? "t 隐藏思考" : "t 显示思考";
  return `←→ 切换成员  ↑↓ 三行滚动  End 跳至底部  i 输入消息  ${expandHint}  ${thinkingHint}`;
}
export const KEY_HINTS_ACTION =
  "ctrl+a 中断  ctrl+b/ctrl+shift+a 全中断  ctrl+o 压缩  Esc 关闭";
/** Hints shown while the input box is open. */
export const INPUT_HINTS =
  "Enter 发送（忙碌时排队）  ctrl+Enter 立即转向  Esc 取消";

// ── Text helpers ───────────────────────────────────────────

/** Truncate a single line to a visible width, appending an ellipsis. */
export function truncateLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (visibleWidth(out + ch) > Math.max(0, width - 1)) break;
    out += ch;
  }
  return out + "…";
}

/**
 * P1-① build-time fixed-width contract: pad/truncate every line to exactly
 * `width` visible columns.
 *
 * The inspector's render() emits body lines VERBATIM (zero width tax on the
 * scroll hot path); this function is the single place where lines are sized
 * to the frame's inner width when they are built (flushDirty), so the
 * right border stays aligned when pi-tui composites the overlay. Over-wide
 * lines (e.g. expandArgs JSON dumps that bypass wrapText) are truncated here
 * too — that is the A2 fix.
 */
export function fitLinesToWidth(lines: string[], width: number): string[] {
  if (width <= 0) return lines;
  return lines.map((l) => {
    const vw = visibleWidth(l);
    if (vw > width) return truncateLine(l, width);
    return vw === width ? l : l + " ".repeat(width - vw);
  });
}

/** Word/char wrap text to the given visible width. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const ch of rawLine) {
      if (visibleWidth(cur + ch) > width) {
        out.push(cur);
        cur = ch === " " ? "" : ch;
      } else {
        cur += ch;
      }
    }
    out.push(cur);
  }
  return out;
}

/** Extract plain text from user/custom message content blocks. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c !== "object" || c === null) return String(c);
        if (c.type === "text") return c.text ?? "";
        if (c.type === "image") return "[图片]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** One-line summary of a tool call's arguments. */
export function summarizeArgs(name: string, args: Record<string, any> | undefined): string {
  if (!args || typeof args !== "object") return "";
  // Prefer a path/command-like argument for a meaningful one-liner
  const preferred =
    args.path ?? args.command ?? args.file ?? args.query ?? args.content;
  let raw: string;
  if (typeof preferred === "string") {
    raw = preferred;
  } else {
    const keys = Object.keys(args);
    raw = keys.length > 0 ? keys.join(", ") : "";
  }
  raw = raw.replace(/\s+/g, " ").trim();
  const max = 60;
  return raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
}

// ── Body line building ─────────────────────────────────────

export interface BuildBodyOptions {
  width: number;
  expanded: boolean;
  /** Render thinking blocks (default: hidden). */
  showThinking?: boolean;
  theme?: InspectorTheme;
}

/** Collapse consecutive empty lines into one and trim leading/trailing empties. */
export function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  let lastWasBlank = false;
  for (const l of lines) {
    if (l === "") {
      if (!lastWasBlank) out.push("");
      lastWasBlank = true;
    } else {
      out.push(l);
      lastWasBlank = false;
    }
  }
  // Trim leading/trailing blanks
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Convert member session messages (AgentMessage[]) into display lines.
 * Rendering granularity (decision #4):
 *   - user/assistant text in full (wrapped)
 *   - tool calls / results as one-line summaries, expandable
 *   - thinking blocks hidden by default (toggleable per tab)
 * Layout rule: one blank line before each user/assistant block, none after.
 */
export function buildBodyLines(messages: any[], opts: BuildBodyOptions): string[] {
  const { width, expanded, showThinking = false } = opts;
  const theme = opts.theme ?? IDENTITY_THEME;
  const lines: string[] = [];
  const textWidth = Math.max(10, width - 2);
  let needSeparator = false; // blank before next user/assistant block

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const blockLines: string[] = [];

    if (m.role === "user") {
      blockLines.push(theme.fg("accent", "● user"));
      const text = extractText(m.content);
      for (const l of wrapText(text, textWidth)) blockLines.push(l);
      if (blockLines.length > 0) {
        if (needSeparator) lines.push("");
        lines.push(...blockLines);
        needSeparator = true;
      }
      continue;
    }

    if (m.role === "assistant") {
      const content: any[] = Array.isArray(m.content) ? m.content : [];
      let wroteHeader = false;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking") {
          if (!showThinking) continue; // thinking hidden unless toggled on
          const thinking = typeof block.thinking === "string" ? block.thinking : "";
          if (thinking.trim().length === 0) continue;
          blockLines.push(theme.fg("dim", "  💭 思考"));
          for (const l of wrapText(thinking, textWidth - 4)) {
            blockLines.push(theme.fg("dim", `    ${l}`));
          }
          continue;
        }
        if (block.type === "text") {
          if (!wroteHeader) {
            blockLines.push(theme.fg("success", "● assistant"));
            wroteHeader = true;
          }
          for (const l of wrapText(block.text ?? "", textWidth)) blockLines.push(l);
          continue;
        }
        if (block.type === "toolCall") {
          const summary = summarizeArgs(block.name, block.arguments);
          blockLines.push(
            theme.fg("toolTitle", `  🔧 ${block.name}${summary ? ` ${summary}` : ""}`)
          );
          if (expanded) {
            const json = JSON.stringify(block.arguments ?? {}, null, 2);
            const jsonLines = json.split("\n").slice(0, EXPANDED_ARGS_MAX_LINES);
            for (const jl of jsonLines) blockLines.push(theme.fg("dim", `    ${jl}`));
            if (json.split("\n").length > EXPANDED_ARGS_MAX_LINES) {
              blockLines.push(theme.fg("dim", "    …"));
            }
          }
          continue;
        }
      }
      if (blockLines.length > 0) {
        if (needSeparator) lines.push("");
        lines.push(...blockLines);
        needSeparator = true;
      }
      continue;
    }

    if (m.role === "toolResult") {
      const icon = m.isError ? "✗" : "✓";
      const color = m.isError ? "error" : "muted";
      const text = extractText(m.content);
      const firstLine = text.split("\n").find((l: string) => l.trim().length > 0) ?? "";
      const suffix = firstLine ? ` ${truncateLine(firstLine.replace(/\s+/g, " "), Math.max(10, textWidth - 14))}` : "";
      lines.push(theme.fg(color, `  ${icon} ${m.toolName ?? "tool"}${suffix}`));
      if (expanded && text) {
        const contentLines = wrapText(text, textWidth - 4).slice(0, EXPANDED_RESULT_MAX_LINES);
        for (const cl of contentLines) lines.push(theme.fg("dim", `    ${cl}`));
      }
      needSeparator = true;
      continue;
    }

    // Unknown / custom AgentMessage — defensive fallback
    const role = typeof m.role === "string" ? m.role : "unknown";
    const raw = truncateLine(JSON.stringify(m).replace(/\s+/g, " "), textWidth - 12);
    lines.push(theme.fg("dim", `[${role}] ${raw}`));
    needSeparator = true;
  }

  return collapseBlankLines(lines);
}

// ── Header line building ───────────────────────────────────

export function buildHeaderLine(
  tabs: InspectorTab[],
  activeIndex: number,
  width: number,
  theme: InspectorTheme = IDENTITY_THEME
): string {
  if (tabs.length === 0) return theme.fg("muted", "（无成员）");
  const parts: string[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    const seg = i === activeIndex ? `❰${t.label}❱` : ` ${t.label} `;
    parts.push(i === activeIndex ? theme.fg("accent", theme.bold?.(seg) ?? seg) : theme.fg("muted", seg));
  }
  return truncateLine(parts.join(" "), width);
}

// ── Footer line building ───────────────────────────────────

export function stateIcon(state: MemberOpState): string {
  return state === "working" ? "🔧" : state === "compacting" ? "🗜️" : state === "idle" ? "✅" : state === "crashed" ? "💥" : "⏹️";
}

export function buildFooterStatusLine(
  tabs: InspectorTab[],
  opsStates: ReadonlyMap<string, MemberOpState>,
  width: number,
  theme: InspectorTheme = IDENTITY_THEME
): string {
  const segs: string[] = [];
  for (const t of tabs) {
    const state = opsStates.get(t.name) ?? "stopped";
    const icon = stateIcon(state);
    let seg = `${icon} ${t.label}`;
    if (state === "compacting") {
      seg += "（压缩中）";
    }
    if (t.contextInfo != null && state !== "stopped" && state !== "crashed") {
      seg += ` ${Math.round(t.contextInfo.percent)}%`;
    } else if (state === "stopped" || state === "crashed") {
      seg += " —";
    }
    segs.push(seg);
  }
  return truncateLine(" " + segs.join("  │  "), width);
}

// ── Inspector State ────────────────────────────────────────

/**
 * Pure display state for the Member Inspector overlay.
 * All methods are synchronous and side-effect free (they only mutate
 * this object's fields), so the TUI layer can call requestRender after.
 */
export class MemberInspectorState {
  tabs: InspectorTab[] = [];
  activeIndex = 0;
  inputOpen = false;
  inputBuffer = "";
  /** Transient notice shown in the footer (e.g. send result). */
  notice: string | null = null;

  constructor(members: { name: string; label: string }[]) {
    this.syncMembers(members);
  }

  /** Reconcile tabs with the current member list (adds new, keeps state). */
  syncMembers(members: { name: string; label: string }[]): void {
    const existing = new Map(this.tabs.map((t) => [t.name, t]));
    const next: InspectorTab[] = [];
    for (const m of members) {
      const prev = existing.get(m.name);
      if (prev) {
        prev.label = m.label;
        next.push(prev);
      } else {
        next.push({
          name: m.name,
          label: m.label,
          lines: [],
          scrollOffset: 0,
          followTail: true,
          expanded: false,
          showThinking: false,
          newBelow: false,
          dirty: true, // fetch on first open
          contextInfo: null,
        });
      }
    }
    this.tabs = next;
    if (this.activeIndex >= this.tabs.length) {
      this.activeIndex = Math.max(0, this.tabs.length - 1);
    }
  }

  get activeTab(): InspectorTab | undefined {
    return this.tabs[this.activeIndex];
  }

  switchTab(delta: number): void {
    if (this.tabs.length === 0) return;
    const n = this.tabs.length;
    this.activeIndex = ((this.activeIndex + delta) % n + n) % n;
  }

  /** Replace a tab's display lines, preserving scroll semantics. */
  setTabLines(name: string, lines: string[], bodyHeight: number): void {
    const tab = this.tabs.find((t) => t.name === name);
    if (!tab) return;
    const prevLen = tab.lines.length;
    tab.lines = lines;
    tab.dirty = false;
    if (tab.followTail) {
      tab.scrollOffset = this.maxOffset(tab, bodyHeight);
    } else {
      if (lines.length > prevLen) tab.newBelow = true;
      tab.scrollOffset = Math.min(tab.scrollOffset, this.maxOffset(tab, bodyHeight));
    }
  }

  maxOffset(tab: InspectorTab, bodyHeight: number): number {
    return Math.max(0, tab.lines.length - Math.max(1, bodyHeight));
  }

  scrollBy(delta: number, bodyHeight: number): void {
    const tab = this.activeTab;
    if (!tab) return;
    const max = this.maxOffset(tab, bodyHeight);
    tab.scrollOffset = Math.min(Math.max(0, tab.scrollOffset + delta), max);
    tab.followTail = tab.scrollOffset >= max;
    if (tab.followTail) tab.newBelow = false;
  }

  scrollToEnd(bodyHeight: number): void {
    const tab = this.activeTab;
    if (!tab) return;
    tab.scrollOffset = this.maxOffset(tab, bodyHeight);
    tab.followTail = true;
    tab.newBelow = false;
  }

  toggleExpand(): void {
    const tab = this.activeTab;
    if (!tab) return;
    tab.expanded = !tab.expanded;
    tab.dirty = true; // rebuild lines with new expansion state
  }

  toggleThinking(): void {
    const tab = this.activeTab;
    if (!tab) return;
    tab.showThinking = !tab.showThinking;
    tab.dirty = true; // rebuild lines with new thinking visibility
  }

  openInput(): void {
    this.inputOpen = true;
    this.inputBuffer = "";
  }

  closeInput(): void {
    this.inputOpen = false;
    this.inputBuffer = "";
  }

  insertInput(text: string): void {
    this.inputBuffer += text;
  }

  backspaceInput(): void {
    const chars = Array.from(this.inputBuffer);
    chars.pop();
    this.inputBuffer = chars.join("");
  }

  clearInput(): void {
    this.inputBuffer = "";
  }
}
