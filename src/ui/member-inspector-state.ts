import { visibleWidth } from "@earendil-works/pi-tui";

// ── Member Inspector State (pure logic, no TUI dependencies) ──
//
// This module holds the Member Inspector's display state and pure
// line-building functions. It is intentionally free of ExtensionAPI /
// TUI handles so it can be unit-tested in isolation. The TUI glue lives
// in member-inspector.ts.

// ── P1-② single-pass width tracking ──────────────────────────
//
// The original wrapText/truncateLine measured `visibleWidth(prefix)` for
// every character prefix — O(n²) character scans, dominated by the
// Intl.Segmenter slow path for CJK content (~2900ms for a 450-message
// rebuild). Both are now single-pass: one grapheme walk per line with
// incremental width accumulation, each grapheme measured exactly once.
// Width rules stay aligned with pi-tui `visibleWidth` (CJK=2, combining
// marks, emoji ZWJ per-grapheme) because each grapheme's width IS
// visibleWidth(grapheme) — a short, cache-friendly string.
//
// Intentional behaviour change (asserted in the integrity tests): the
// legacy codepoint loop could split a grapheme (VS16/ZWJ) or an ANSI
// escape sequence mid-way at narrow widths. The single-pass walk keeps
// whole graphemes and whole ANSI sequences together.

/** Shared grapheme segmenter (same config as pi-tui). */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * ANSI/OSC/APC escape sequence at `pos`, or null. Local copy of pi-tui's
 * extractAnsiCode (utils.js) so we can skip sequences without measuring
 * their inner characters — kept in sync with the width logic above.
 */
function extractAnsiCode(text: string, pos: number): { code: string; length: number } | null {
  if (pos >= text.length || text[pos] !== "\x1b") return null;
  const next = text[pos + 1];
  // CSI: ESC [ ... m/G/K/H/J
  if (next === "[") {
    let j = pos + 2;
    while (j < text.length && !/[mGKHJ]/.test(text[j])) j++;
    if (j < text.length) return { code: text.substring(pos, j + 1), length: j + 1 - pos };
    return null;
  }
  // OSC: ESC ] ... BEL or ESC ] ... ST (ESC \\)
  if (next === "]") {
    let j = pos + 2;
    while (j < text.length) {
      if (text[j] === "\x07") return { code: text.substring(pos, j + 1), length: j + 1 - pos };
      if (text[j] === "\x1b" && text[j + 1] === "\\") return { code: text.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }
  // APC: ESC _ ... BEL or ESC _ ... ST
  if (next === "_") {
    let j = pos + 2;
    while (j < text.length) {
      if (text[j] === "\x07") return { code: text.substring(pos, j + 1), length: j + 1 - pos };
      if (text[j] === "\x1b" && text[j + 1] === "\\") return { code: text.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }
  return null;
}

/**
 * Yield graphemes of `text` with their visible widths, skipping ANSI
 * sequences (kept whole, width 0). Single pass over the text; each
 * grapheme is measured once via visibleWidth (short string → cheap).
 */
function* graphemeTokens(text: string): Generator<{ seg: string; width: number }> {
  const iter = graphemeSegmenter.segment(text)[Symbol.iterator]();
  let next = iter.next();
  while (!next.done) {
    const seg = next.value.segment;
    const at = next.value.index;
    if (seg.startsWith("\x1b")) {
      const ansi = extractAnsiCode(text, at);
      if (ansi) {
        yield { seg: ansi.code, width: 0 };
        const target = at + ansi.length;
        while (!next.done && next.value.index < target) next = iter.next();
        continue;
      }
    }
    yield { seg, width: visibleWidth(seg) };
    next = iter.next();
  }
}

// ── P2 append-only wrap cache (streaming thinking/text) ────
//
// The streaming tail is rebuilt every flush (~100ms). A live thinking/text
// block grows by APPENDS only (thinking_delta / text_delta concat), yet the
// legacy path re-wrapped the WHOLE accumulated text on every rebuild —
// O(T) per flush, O(T²) over a stream; with CJK thinking (Intl.Segmenter
// slow path) a 30KB block cost ~14ms/flush → a full core at long lengths.
//
// wrapAppendOnly caches the wrap state per BLOCK OBJECT (WeakMap — entries
// die with the block; thinking_end/text_end replace the object, so the
// final authoritative text always re-wraps exactly once) and consumes only
// the new delta per call: O(Δ) per flush, O(T) over the whole stream.
// Output is byte-identical to wrapText(fullText, width) at every step —
// enforced by the append-only invariant plus one rollback rule: the last
// grapheme of the in-progress line is uncommitted before each feed so a
// grapheme cluster split across the delta boundary (ZWJ emoji, combining
// marks) re-segments in the joined context.

/** Resumable wrap state for one append-only block at one width. */
interface AppendWrapEntry {
  /** Wrap width this state was built with (mismatch → rebuild). */
  width: number;
  /** The full consumed text (append-guard: next text must startWith it). */
  text: string;
  /** Completed wrapped lines (raw, unthemed). */
  lines: string[];
  /** In-progress final wrapped line (raw, unthemed). */
  cur: string;
  /** Visible width of `cur`. */
  curW: number;
}

const appendWrapCache = new WeakMap<object, AppendWrapEntry>();

/** Feed one raw line (no "\n") into the entry — mirrors wrapText's per-line fast/grapheme paths. */
function feedAppendRawLine(e: AppendWrapEntry, rawLine: string): void {
  if (rawLine.length === 0) return;
  // Fast path: pure ASCII — each char is one column, no segmenter needed.
  // (Path choice is free: both paths implement identical width rules, so
  // the output matches wrapText regardless of which runs.)
  if (isPrintableAscii(rawLine)) {
    for (let i = 0; i < rawLine.length; i++) {
      if (e.curW + 1 > e.width) {
        e.lines.push(e.cur);
        const ch = rawLine[i];
        e.cur = ch === " " ? "" : ch;
        e.curW = ch === " " ? 0 : 1;
      } else {
        e.cur += rawLine[i];
        e.curW += 1;
      }
    }
    return;
  }
  for (const { seg, width: w } of graphemeTokens(rawLine)) {
    if (e.curW + w > e.width) {
      e.lines.push(e.cur);
      e.cur = seg === " " ? "" : seg;
      e.curW = seg === " " ? 0 : w;
    } else {
      e.cur += seg;
      e.curW += w;
    }
  }
}

/** Feed `delta` into the entry, applying the exact wrapText line rules. */
function feedAppendWrap(e: AppendWrapEntry, delta: string): void {
  // Roll back the last grapheme of the in-progress line: a grapheme cluster
  // may span the delta boundary (e.g. "👩" | "‍💻"), and re-feeding the
  // partial tail in the joined context keeps segmentation identical to a
  // full wrap. cur is bounded by the wrap width, so this is O(width).
  let text = delta;
  if (e.cur.length > 0) {
    let lastIdx = 0;
    let lastSeg = "";
    for (const s of graphemeSegmenter.segment(e.cur)) {
      lastIdx = s.index;
      lastSeg = s.segment;
    }
    e.cur = e.cur.slice(0, lastIdx);
    e.curW -= visibleWidth(lastSeg);
    if (e.curW < 0) e.curW = 0; // ANSI-piece rollback can transiently over-subtract; wrapping is monotonic anyway
    text = lastSeg + delta;
  }
  // Split on "\n" exactly like wrapText: a "\r\n" sequence leaves the "\r"
  // (zero-width control) at the end of the completed raw line.
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    feedAppendRawLine(e, nl < 0 ? text.slice(start) : text.slice(start, nl));
    if (nl < 0) break;
    e.lines.push(e.cur); // raw line complete — wrapText pushes cur here
    e.cur = "";
    e.curW = 0;
    start = nl + 1;
  }
}

/**
 * wrapText for append-only-growing block text, cached per block object.
 * Falls back to a full wrap on first use / width change / non-append
 * mutation (shrink or prefix mismatch). Byte-identical to
 * wrapText(text, width) under every caller-visible path.
 */
export function wrapAppendOnly(block: object, text: string, width: number): string[] {
  if (width <= 0) return [""];
  let e = appendWrapCache.get(block);
  if (e && (e.width !== width || text.length < e.text.length || !text.startsWith(e.text))) {
    e = undefined; // width change / rewrite — rebuild from scratch
  }
  if (!e) {
    e = { width, text: "", lines: [], cur: "", curW: 0 };
    appendWrapCache.set(block, e);
  }
  if (text.length > e.text.length) {
    feedAppendWrap(e, text.slice(e.text.length));
    e.text = text;
  }
  // wrapText contract: the in-progress final raw line is always emitted.
  return [...e.lines, e.cur];
}

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
  /** New content arrived while not following tail. */
  newBelow: boolean;
  /** Dirty flag set by member activity events; cleared after refetch. */
  dirty: boolean;
  contextInfo: MemberContextInfo | null;
  /**
   * Assembled in-progress assistant message (built from the member's
   * message_start / message_update deltas). Rendered as the streaming tail;
   * cleared by completeLiveMessage (message_end) / clearStreaming (agent_end).
   */
  live: LiveAssistantMessage | null;
  /**
   * Completed assistant messages (authoritative, from message_end) that are
   * NOT yet confirmed in the RPC-fetched history. Rendered after the fetched
   * messages so a message never vanishes between message_end and the next
   * get_messages refetch; reconcilePending drops them once confirmed.
   */
  pendingCompletions: any[];
}

export type MemberOpState = "idle" | "working" | "compacting" | "crashed" | "stopped";

// ── Constants ──────────────────────────────────────────────

/**
 * Display-line budget for an expanded tool call's arguments.
 * Counts WRAPPED lines (not raw JSON lines): a single very long JSON line
 * (e.g. a long `content` value) wraps to multiple display lines, so the
 * budget caps total screen lines instead of raw JSON lines. When the
 * budget runs out, the remainder is collapsed into a "…" marker.
 */
export const EXPANDED_ARGS_MAX_LINES = 40;
/** Max lines shown for an expanded tool result's content. */
export const EXPANDED_RESULT_MAX_LINES = 60;
/**
 * Navigation key hints for the footer. The expand/collapse hint reflects the
 * current GLOBAL expansion state (press `e` to toggle ALL member tabs).
 * Note: ctrl+m is indistinguishable from Enter in terminals, so compact
 * uses ctrl+o.
 */
export function buildNavHints(expanded: boolean, showThinking: boolean): string {
  const expandHint = expanded ? "e 隐藏工具详情" : "e 展开工具详情";
  const thinkingHint = showThinking ? "t 隐藏思考" : "t 显示思考";
  return `←→ 切换成员 ↑↓ 三行滚动 End 跳至底部 i 输入消息 ${expandHint} ${thinkingHint}`;
}
export const KEY_HINTS_ACTION =
  "ctrl+a 中断  ctrl+b/ctrl+shift+a 全中断  ctrl+o 压缩  Esc 关闭";
/** Hints shown while the input box is open. */
export const INPUT_HINTS =
  "Enter 发送（忙碌时排队）  ctrl+Enter/alt+Enter 立即转向  Esc 取消";

// ── Text helpers ───────────────────────────────────────────

/**
 * True if every char is printable ASCII (0x20-0x7e). Used by the single-pass
 * fast paths: such lines have width == length and need no segmenter.
 * Tab/ANSI/control chars (incl. \x1b) fail the check automatically.
 */
function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** Truncate a single line to a visible width, appending an ellipsis. */
export function truncateLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  // P1-② fast path: pure ASCII — width == length, no segmenter needed.
  const target = Math.max(0, width - 1);
  if (isPrintableAscii(text)) {
    return text.length > target ? text.slice(0, target) + "…" : text + "…";
  }
  // P1-② single-pass: accumulate grapheme widths until the ellipsis column
  // (width - 1) is crossed. No per-prefix re-measurement.
  let out = "";
  let outW = 0;
  for (const { seg, width: w } of graphemeTokens(text)) {
    if (outW + w > target) break;
    out += seg;
    outW += w;
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
    // P1-② fast path: pure ASCII — each char is one column, no segmenter.
    if (isPrintableAscii(rawLine)) {
      let cur = "";
      let curW = 0;
      for (let i = 0; i < rawLine.length; i++) {
        if (curW + 1 > width) {
          out.push(cur);
          const ch = rawLine[i];
          cur = ch === " " ? "" : ch;
          curW = ch === " " ? 0 : 1;
        } else {
          cur += rawLine[i];
          curW += 1;
        }
      }
      out.push(cur);
      continue;
    }
    // P1-② single-pass: one grapheme walk, incremental width; a leading
    // space at a wrap point is dropped (legacy semantics), everything else
    // (incl. over-wide graphemes) starts the next line.
    let cur = "";
    let curW = 0;
    for (const { seg, width: w } of graphemeTokens(rawLine)) {
      if (curW + w > width) {
        out.push(cur);
        cur = seg === " " ? "" : seg;
        curW = seg === " " ? 0 : w;
      } else {
        cur += seg;
        curW += w;
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

/**
 * One-line summary of a tool call's arguments.
 * `maxWidth` (default 60) caps the summary at the given visible width so
 * completed tool calls use the actual frame width instead of a fixed cap
 * (truncation is visible-width aware via truncateLine, CJK-safe).
 */
export function summarizeArgs(
  name: string,
  args: Record<string, any> | undefined,
  maxWidth = 60
): string {
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
  return truncateLine(raw, Math.max(10, maxWidth));
}

// ── Live streaming assembly (streaming thinking/text/toolcall) ──
//
// RPC-mode message_update events carry DELTAS only (the cumulative `partial`
// is stripped on the wire), and get_messages does NOT include the in-progress
// assistant message — it lands in history only at message_end. So while a
// member streams its thinking, the inspector would show nothing until the
// whole message completes. These functions assemble a live partial message
// from message_start + message_update deltas, which the component renders as
// the streaming tail (the incremental cache's INCREMENTAL_TAIL rule rebuilds
// it every flush — exactly the designed fast path).

/** Live in-progress assistant message assembled from stream deltas. */
export interface LiveAssistantMessage {
  role: "assistant";
  content: any[];
}

/** Shallow-clone a content block (arguments included) so live mutation never touches the event object. */
function cloneBlock(b: any): any {
  if (!b || typeof b !== "object") return b;
  const copy: any = { ...b };
  if (b.arguments && typeof b.arguments === "object") copy.arguments = { ...b.arguments };
  return copy;
}

/**
 * Start a live message from message_start's initial assistant message
 * (content blocks cloned; providers that seed blocks upfront keep them).
 */
export function createLiveAssistantMessage(message: any): LiveAssistantMessage {
  const content = Array.isArray(message?.content) ? message.content : [];
  return { role: "assistant", content: content.map(cloneBlock) };
}

/**
 * Apply one RPC wire delta (`assistantMessageEvent`) to the live message.
 * Content blocks are keyed by `contentIndex`; missing blocks are created on
 * demand (defensive: deltas may arrive without a prior *_start, or the
 * inspector opened mid-stream). toolcall blocks accumulate the raw partial
 * JSON in `partialArgs` (marker: typeof === "string") and parse it on the
 * fly; toolcall_end replaces the block with the authoritative toolCall.
 * Unknown delta types are ignored without touching the blocks.
 */
export function applyAssistantDelta(live: LiveAssistantMessage, delta: any): void {
  if (!delta || typeof delta !== "object" || typeof delta.type !== "string") return;
  const { type, contentIndex } = delta;
  if (typeof contentIndex !== "number" || contentIndex < 0) return;
  const blocks = live.content;

  /** Ensure a block of `kind` exists at `index` (fill gaps with text placeholders). */
  function ensureBlock(index: number, kind: "text" | "thinking" | "toolCall"): any {
    while (blocks.length <= index) blocks.push({ type: "text", text: "" });
    const cur = blocks[index];
    if (cur.type === kind) return cur;
    const fresh =
      kind === "text"
        ? { type: "text", text: "" }
        : kind === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "toolCall", arguments: {}, partialArgs: "" };
    blocks[index] = fresh;
    return fresh;
  }

  switch (type) {
    case "text_start":
      blocks[contentIndex] = { type: "text", text: "" };
      break;
    case "text_delta": {
      const b = ensureBlock(contentIndex, "text");
      b.text = (b.text ?? "") + (delta.delta ?? "");
      break;
    }
    case "text_end":
      blocks[contentIndex] = { type: "text", text: delta.content ?? "" };
      break;
    case "thinking_start":
      blocks[contentIndex] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta": {
      const b = ensureBlock(contentIndex, "thinking");
      b.thinking = (b.thinking ?? "") + (delta.delta ?? "");
      break;
    }
    case "thinking_end":
      blocks[contentIndex] = { type: "thinking", thinking: delta.content ?? "" };
      break;
    case "toolcall_start":
      blocks[contentIndex] = { type: "toolCall", arguments: {}, partialArgs: "" };
      break;
    case "toolcall_delta": {
      const b = ensureBlock(contentIndex, "toolCall");
      b.partialArgs = (b.partialArgs ?? "") + (delta.delta ?? "");
      try {
        b.arguments = JSON.parse(b.partialArgs);
      } catch {
        // raw JSON still incomplete — keep the last successful parse
      }
      break;
    }
    case "toolcall_end":
      if (delta.toolCall && typeof delta.toolCall === "object") {
        blocks[contentIndex] = delta.toolCall;
      }
      break;
  }
}

/**
 * True when two messages render identically (role + content equality). Used
 * to confirm that a pending completion has landed in the fetched history —
 * the member process serializes everything, so reference equality is
 * impossible; message_end.message IS the object that get_messages returns,
 * so content equality is the precise signal.
 */
function sameMessageContent(a: any, b: any): boolean {
  if (!a || !b || a.role !== b.role) return false;
  return JSON.stringify(a.content ?? null) === JSON.stringify(b.content ?? null);
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
  // P1-②: trim leading blanks via slice instead of shift() (shift is O(n)
  // per call → O(n²) on long all-blank runs). Trailing pop stays O(1).
  let start = 0;
  while (start < out.length && out[start] === "") start++;
  let end = out.length;
  while (end > start && out[end - 1] === "") end--;
  return out.slice(start, end);
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
  return collapseBlankLines(buildBodyRaw(messages, opts, false).lines);
}

/**
 * Raw body line builder shared by the full path (buildBodyLines) and the
 * P1-③ incremental path. Appends block lines for every message, tracking
 * the needSeparator state across messages. No collapsing — the caller
 * decides how to merge with an existing collapsed prefix.
 *
 * `snapshotBeforeIndex` (optional): when > 0, records lines.length and
 * needSeparator just before processing messages[snapshotBeforeIndex] —
 * i.e. the state after messages[0..snapshotBeforeIndex). Used by the full
 * path to seed the incremental cache without a second build pass.
 */
function buildBodyRaw(
  messages: any[],
  opts: BuildBodyOptions,
  initialNeedSeparator: boolean,
  snapshotBeforeIndex = -1
): { lines: string[]; needSeparator: boolean; snapshotLen?: number; snapshotSep?: boolean } {
  const { width, expanded, showThinking = false } = opts;
  const theme = opts.theme ?? IDENTITY_THEME;
  const lines: string[] = [];
  const textWidth = Math.max(10, width - 2);
  let needSeparator = initialNeedSeparator; // blank before next user/assistant block
  let snapshotLen: number | undefined;
  let snapshotSep: boolean | undefined;

  for (let i = 0; i < messages.length; i++) {
    if (i === snapshotBeforeIndex) {
      snapshotLen = lines.length;
      snapshotSep = needSeparator;
    }
    const m = messages[i];
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
          // P2: append-only cached wrap — the streaming tail rebuilds every
          // flush; only the new delta is wrapped, not the whole block.
          for (const l of wrapAppendOnly(block, thinking, textWidth - 4)) {
            blockLines.push(theme.fg("dim", `    ${l}`));
          }
          continue;
        }
        if (block.type === "text") {
          if (!wroteHeader) {
            blockLines.push(theme.fg("success", "● assistant"));
            wroteHeader = true;
          }
          for (const l of wrapAppendOnly(block, block.text ?? "", textWidth)) blockLines.push(l);
          continue;
        }
        if (block.type === "toolCall") {
          // Live-streamed tool call (assembled from deltas): name arrives only
          // at toolcall_end, so show the growing raw JSON instead of a summary.
          const streaming = typeof block.partialArgs === "string";
          const name = streaming ? "…" : block.name;
          const summary = streaming
            ? truncateLine(
                (block.partialArgs ?? "").replace(/\s+/g, " ").trim(),
                Math.max(10, textWidth - 14)
              )
            : summarizeArgs(block.name, block.arguments, Math.max(10, textWidth - 14));
          const label = streaming ? `  🔧 ${name} 调用中` : `  🔧 ${name}`;
          const line = summary ? `${label} ${summary}` : label;
          // Summary line wraps like any other text — a wide summary must
          // not get hard-truncated by fitLinesToWidth (which drops content).
          for (const l of wrapText(line, textWidth)) {
            blockLines.push(theme.fg("toolTitle", l));
          }
          if (expanded) {
            if (streaming) {
              const raw = block.partialArgs ?? "";
              const wrapped = wrapText(`    ${raw}`, textWidth);
              for (const l of wrapped.slice(0, EXPANDED_ARGS_MAX_LINES)) {
                blockLines.push(theme.fg("dim", l));
              }
              if (wrapped.length > EXPANDED_ARGS_MAX_LINES) {
                blockLines.push(theme.fg("dim", "    …"));
              }
            } else {
              // Each JSON line is wrapped to textWidth before being emitted:
              // long values (path/content/command strings) wrap instead of
              // being truncated, so the full arguments stay readable. The
              // budget counts wrapped display lines, preventing a single
              // huge value from exploding the body; overflow collapses to "…".
              const json = JSON.stringify(block.arguments ?? {}, null, 2);
              let budget = EXPANDED_ARGS_MAX_LINES;
              let truncated = false;
              for (const jl of json.split("\n")) {
                const wrapped = wrapText(`    ${jl}`, textWidth);
                if (wrapped.length > budget) {
                  truncated = true;
                  blockLines.push(...wrapped.slice(0, budget).map((l) => theme.fg("dim", l)));
                  budget = 0;
                  break;
                }
                for (const l of wrapped) blockLines.push(theme.fg("dim", l));
                budget -= wrapped.length;
              }
              if (truncated) {
                blockLines.push(theme.fg("dim", "    …"));
              }
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

  return { lines, needSeparator, snapshotLen, snapshotSep };
}

// ── P1-③ incremental body building ─────────────────────────
//
// Per-tab cache + boundary fingerprint guard. A refresh is O(history) for
// a full rebuild; when messages are append-only this becomes O(new tail)
// by reusing the previously built prefix lines.
//
// Design (final summary P1-③):
//   - cache: seenCount + last-message fingerprint + built lines + tail
//     block state (needSeparator + trailing-blank state)
//   - boundary compare: message count grew AND the fingerprint of the
//     message at the cache boundary is continuous → build only the new
//     tail and append. Count shrank / fingerprint mismatch (compress,
//     rewrite) / opts signature change → full rebuild.
//   - streaming-tail rule: the LAST message (TAIL=1) is always excluded
//     from the cache and rebuilt every refresh — while streaming, the
//     final message grows in-place, so caching it would miss updates.
//   - comparison cost is O(1): one fingerprint of one message + count.

/** Streaming-tail rule: the last N messages are never cached. */
export const INCREMENTAL_TAIL = 1;

/** Keys whose value never affects rendering (excluded from fingerprints). */
const FINGERPRINT_IGNORED_KEYS = new Set(["id", "timestamp", "corrId", "sessionId"]);

/**
 * P2 adaptive stream-flush cadence. Hysteresis band between 1/8 and 1/2 of
 * the current interval: a rebuild eating over half the interval doubles the
 * delay (bounded by maxMs); a rebuild cheaper than an eighth of it recovers
 * toward minMs. Keeps the rebuild CPU fraction bounded under pathological
 * loads (huge single deltas, cold caches) without sacrificing the 100ms
 * snappiness of the common case.
 */
export function nextStreamFlushDelay(
  currentMs: number,
  buildMs: number,
  minMs: number,
  maxMs: number
): number {
  if (buildMs > currentMs / 2 && currentMs < maxMs) {
    return Math.min(maxMs, currentMs * 2);
  }
  if (buildMs < currentMs / 8 && currentMs > minMs) {
    return Math.max(minMs, Math.floor(currentMs / 2));
  }
  return currentMs;
}

/** FNV-1a 64-bit (two interleaved 32-bit lanes), hex string. */
function fnv1a64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Recursively strip non-render keys from a message for fingerprinting. */
function renderKey(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(renderKey);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (FINGERPRINT_IGNORED_KEYS.has(k)) continue;
    out[k] = renderKey(val);
  }
  return out;
}

/**
 * O(content) stable fingerprint of the render-relevant fields of one
 * message. Same content ⇒ same fingerprint; any render-affecting change
 * (incl. same-length rewrites) ⇒ different fingerprint. Non-render fields
 * (id/timestamp/corrId/sessionId) are excluded so refetches that only
 * bump metadata do not trigger needless full rebuilds.
 *
 * Defensive: `undefined` entries (malformed get_messages payloads) yield a
 * stable "empty" fingerprint instead of throwing — buildBodyRaw skips null
 * messages, so a fingerprint crash here would only surface as a silent
 * tab-update loss via the caller's .catch.
 */
export function messageFingerprint(m: unknown): string {
  const s = JSON.stringify(renderKey(m));
  return fnv1a64(s ?? "");
}

/** Per-tab incremental build cache (see P1-③ design above). */
export interface BodyBuildCache {
  /** Messages covered by `lines` (stable prefix; streaming tail excluded). */
  seenCount: number;
  /** Fingerprint of messages[seenCount - 1] (boundary guard). */
  fingerprint: string;
  /** Collapsed prefix lines (rendered, ready to display). */
  lines: string[];
  /** Separator state after the last cached message. */
  needSeparator: boolean;
  /** Whether the RAW prefix ends with a blank line (collapsed away). */
  prefixEndsWithBlank: boolean;
  /** Build options the cache was built with (opts signature). */
  opts: { width: number; expanded: boolean; showThinking: boolean };
}

/** Create an empty cache (first build is always full). */
export function createBodyBuildCache(): BodyBuildCache {
  return {
    seenCount: 0,
    fingerprint: "",
    lines: [],
    needSeparator: false,
    prefixEndsWithBlank: false,
    opts: { width: 0, expanded: false, showThinking: false },
  };
}

function optsSignatureOf(opts: BuildBodyOptions): BodyBuildCache["opts"] {
  return {
    width: opts.width,
    expanded: opts.expanded,
    showThinking: opts.showThinking ?? false,
  };
}

function sameOpts(a: BodyBuildCache["opts"], b: BodyBuildCache["opts"]): boolean {
  return (
    a.width === b.width &&
    a.expanded === b.expanded &&
    a.showThinking === b.showThinking
  );
}

/**
 * Append raw tail lines to a collapsed prefix, preserving the exact
 * collapsing semantics of collapseBlankLines(prefix ++ tail):
 *   - a leading blank in the tail is a real separator (prefix non-empty),
 *     except when the prefix itself ends blank (raw) — then the two merge
 *   - consecutive blanks collapse to one; trailing blanks are trimmed
 * Returns the new full lines and the raw trailing-blank state (needed by
 * the cache for the next append).
 *
 * Branch map (i = position in tail; prefix = already-collapsed prefix):
 *   A. i===0 && prefix非空 && prefixEndsWithBlank — the raw prefix ended
 *      with a blank that collapseBlankLines trimmed; in the FULL build it
 *      separates prefix content from the tail, so restore exactly one at
 *      the seam (then fall through to the normal blank handling).
 *   B. i===0 && l==="" && (prefix空 || prefixEndsWithBlank) — a leading
 *      blank adjacent to the prefix end: with an empty prefix it is the
 *      very first line (no separator semantics yet → drop); with a
 *      prefixEndsWithBlank it would only duplicate the seam blank in A →
 *      drop. In both cases mark lastBlank so a following blank also drops.
 *   C. l==="" && lastBlank — consecutive blanks after a kept one merge
 *      into the single previous blank → drop.
 *   D. l==="" otherwise — genuine interior/leading separator → keep.
 *   E. l!=="" — content line → keep, clear lastBlank.
 *   F. after the loop: trim trailing blanks (collapseBlankLines contract).
 */
function appendCollapsed(
  prefix: string[],
  tail: string[],
  prefixEndsWithBlank: boolean
): { lines: string[]; endsWithBlank: boolean } {
  const out: string[] = [];
  let lastBlank = false;
  const endsWithBlank = tail.length > 0 && tail[tail.length - 1] === "";
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    if (i === 0 && prefix.length > 0 && prefixEndsWithBlank) {
      // Branch A — restore the seam blank the prefix-collapse trimmed.
      out.push("");
      lastBlank = true;
    }
    if (l === "") {
      if (i === 0 && (prefix.length === 0 || prefixEndsWithBlank)) {
        // Branch B — leading blank absorbed by the prefix edge.
        lastBlank = true;
        continue;
      }
      if (lastBlank) {
        // Branch C — merge consecutive blanks.
        continue;
      }
      // Branch D — genuine separator.
      out.push("");
      lastBlank = true;
    } else {
      // Branch E — content line.
      out.push(l);
      lastBlank = false;
    }
  }
  // Branch F — trailing-blank trim.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return { lines: prefix.concat(out), endsWithBlank };
}

/**
 * O(1) decision: can the incremental cache be reused for this refresh?
 * Boundary fingerprint guard (see buildBodyLinesIncremental docstring for
 * the exact detection scope). Exported so the component can route large
 * full rebuilds through the chunked path without building first.
 */
export function canIncrementCache(
  cache: BodyBuildCache,
  messages: unknown[],
  opts: BuildBodyOptions
): boolean {
  const m = messages.length;
  return (
    cache.seenCount > 0 &&
    sameOpts(cache.opts, optsSignatureOf(opts)) &&
    m > cache.seenCount &&
    messages[cache.seenCount - 1] != null &&
    messageFingerprint(messages[cache.seenCount - 1]) === cache.fingerprint
  );
}

/**
 * Incremental body builder. Returns lines byte-identical to
 * buildBodyLines(messages, opts) in every case; `mode` reports whether the
 * cache was reused ("incremental" — only the new tail was built) or a full
 * rebuild happened (first build / count shrink / fingerprint mismatch /
 * opts change). The cache is mutated in place (per-tab ownership).
 *
 * Guard scope (precise): the O(1) boundary check verifies ONLY
 * messages[seenCount-1]. An in-place rewrite of an EARLIER message
 * (index < seenCount-1) with unchanged count and unchanged boundary
 * message is NOT detected — the stale prefix would render until some
 * other guard fires. This is an accepted trade-off: the data source
 * (member session logs) is append-only, and history compaction shrinks
 * the count, which the count guard catches.
 */
export function buildBodyLinesIncremental(
  cache: BodyBuildCache,
  messages: any[],
  opts: BuildBodyOptions,
  limit?: number
): { lines: string[]; mode: "full" | "incremental" } {
  const optsSig = optsSignatureOf(opts);
  // P1-④/S4: an optional index bound lets the chunked path grow the cache
  // over prefixes [0, limit) without slicing the array per slice. Callers
  // must pass a monotonically non-decreasing limit (chunked builds do).
  const m = Math.min(limit ?? messages.length, messages.length);
  // Boundary fingerprint guard (O(1)): only messages[seenCount-1] is
  // checked. See the function docstring for the exact detection scope.
  const canIncrement =
    canIncrementCache(cache, messages, opts) && m > cache.seenCount;

  if (!canIncrement) {
    // Full rebuild — also reseed the cache prefix so later refreshes can
    // go incremental. snapshotBeforeIndex captures the raw state at the
    // new prefix boundary in the SAME pass (no second build).
    const newSeen = Math.max(0, m - INCREMENTAL_TAIL);
    const raw = buildBodyRaw(
      limit === undefined ? messages : messages.slice(0, m),
      opts,
      false,
      newSeen
    );
    const lines = collapseBlankLines(raw.lines);
    cache.seenCount = newSeen;
    cache.fingerprint = newSeen > 0 ? messageFingerprint(messages[newSeen - 1]) : "";
    cache.lines = newSeen > 0 ? collapseBlankLines(raw.lines.slice(0, raw.snapshotLen ?? 0)) : [];
    cache.needSeparator = newSeen > 0 ? (raw.snapshotSep ?? false) : false;
    cache.prefixEndsWithBlank =
      newSeen > 0 ? (raw.lines[raw.snapshotLen! - 1] ?? "") === "" : false;
    cache.opts = optsSig;
    return { lines, mode: "full" };
  }

  // Incremental: grow the cached prefix to the new boundary, then rebuild
  // the streaming tail. Both use the shared raw builder, so the output is
  // byte-identical to a full build by construction.
  const newSeen = Math.max(0, m - INCREMENTAL_TAIL);
  if (newSeen > cache.seenCount) {
    const grown = buildBodyRaw(messages.slice(cache.seenCount, newSeen), opts, cache.needSeparator);
    const merged = appendCollapsed(cache.lines, grown.lines, cache.prefixEndsWithBlank);
    cache.lines = merged.lines;
    cache.prefixEndsWithBlank = merged.endsWithBlank;
    cache.needSeparator = grown.needSeparator;
    cache.seenCount = newSeen;
    cache.fingerprint = messageFingerprint(messages[newSeen - 1]);
  }
  const tail = buildBodyRaw(messages.slice(newSeen, m), opts, cache.needSeparator);
  const merged = appendCollapsed(cache.lines, tail.lines, cache.prefixEndsWithBlank);
  return { lines: merged.lines, mode: "incremental" };
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
  // v2.2 图标微调（用户三次确认）：working → 💭（默认色，与 thinking 同图标靠
  // 颜色区分——浮窗 footer 同理）；list_members 保持 D5 裁决的图标不改。
  return state === "working" ? "💭" : state === "compacting" ? "🗜️" : state === "idle" ? "✅" : state === "crashed" ? "💥" : "⏹️";
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
  /**
   * GLOBAL view-mode toggles (e/t 开关全局化). The e/t switches are
   * inspector-level view modes, NOT per-member states: one keypress flips
   * ALL member tabs. Single source of truth — tabs carry no per-tab fields,
   * so a divergent per-member state is structurally impossible and members
   * added later (dynamic mode) automatically inherit the current values.
   */
  expanded = false;
  showThinking = false;

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
          newBelow: false,
          dirty: true, // fetch on first open
          contextInfo: null,
          live: null,
          pendingCompletions: [],
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
    // Global view-mode toggle: flip the single source of truth and mark
    // EVERY tab dirty so flushDirty rebuilds all of them (running tabs via
    // RPC refetch, stopped/crashed tabs with a cache via local rebuild).
    this.expanded = !this.expanded;
    for (const t of this.tabs) t.dirty = true;
  }

  toggleThinking(): void {
    this.showThinking = !this.showThinking;
    for (const t of this.tabs) t.dirty = true;
  }

  // ── Live streaming state (message_start / message_update / message_end) ──

  /** Reset the tab's live message to a freshly started assistant message. */
  setLiveMessage(name: string, message: any): void {
    const tab = this.tabs.find((t) => t.name === name);
    if (!tab) return;
    tab.live = createLiveAssistantMessage(message);
  }

  /** Apply a stream delta to the tab's live message (lazily created on a missed message_start). */
  applyLiveDelta(name: string, delta: any): void {
    const tab = this.tabs.find((t) => t.name === name);
    if (!tab) return;
    if (!tab.live) tab.live = createLiveAssistantMessage({ role: "assistant", content: [] });
    applyAssistantDelta(tab.live, delta);
  }

  /**
   * Move the live message into pendingCompletions on message_end. The
   * authoritative event message is kept so the display never loses the
   * message between message_end and the refetch that confirms it.
   */
  completeLiveMessage(name: string, message: any): void {
    const tab = this.tabs.find((t) => t.name === name);
    if (!tab || !message || typeof message !== "object") return;
    tab.live = null;
    tab.pendingCompletions.push(message);
  }

  /** Drop live + pending state (agent_end / session teardown). */
  clearStreaming(name: string): void {
    const tab = this.tabs.find((t) => t.name === name);
    if (!tab) return;
    tab.live = null;
    tab.pendingCompletions = [];
  }

  /**
   * Drop pending completions already present in the freshly fetched history.
   * Each entry is confirmed independently (backward scan with a strictly
   * decreasing position bound — history is append-only, so a later completion
   * sits at a higher index; interleaved toolResult/user messages between
   * completions are tolerated). Unconfirmed entries are kept.
   */
  reconcilePending(name: string, messages: any[]): void {
    const tab = this.tabs.find((t) => t.name === name);
    const pending = tab?.pendingCompletions;
    if (!tab || !pending || pending.length === 0) return;
    const confirmed = new Set<number>();
    let scanBound = messages.length; // strictly decreasing scan ceiling
    for (let p = pending.length - 1; p >= 0; p--) {
      let found = -1;
      for (let i = scanBound - 1; i >= 0; i--) {
        if (sameMessageContent(messages[i], pending[p])) {
          found = i;
          break;
        }
      }
      if (found < 0) continue; // unconfirmed — earlier entries may still match
      confirmed.add(p);
      scanBound = found;
    }
    if (confirmed.size > 0) {
      tab.pendingCompletions = pending.filter((_, i) => !confirmed.has(i));
    }
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
