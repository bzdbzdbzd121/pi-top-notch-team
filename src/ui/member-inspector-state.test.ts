import { describe, it, expect, vi } from "vitest";

// ── Mock pi-tui (same pattern as other ui tests) ──────────

vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: vi.fn((text: string) => text.length),
}));

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  MemberInspectorState,
  buildBodyLines,
  buildHeaderLine,
  buildFooterStatusLine,
  wrapText,
  truncateLine,
  fitLinesToWidth,
  extractText,
  summarizeArgs,
  IDENTITY_THEME,
  createLiveAssistantMessage,
  applyAssistantDelta,
} from "./member-inspector-state";

// ── Fixtures ───────────────────────────────────────────────

function userMsg(text: string) {
  return { role: "user", content: text, timestamp: 1 };
}

function assistantMsg(...blocks: any[]) {
  return { role: "assistant", content: blocks, timestamp: 2 };
}

function textBlock(text: string) {
  return { type: "text", text };
}

function thinkingBlock(thinking: string) {
  return { type: "thinking", thinking };
}

function toolCallBlock(name: string, args: Record<string, any>) {
  return { type: "toolCall", id: "tc-1", name, arguments: args };
}

function toolResultMsg(toolName: string, text: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 3,
  };
}

// ── wrapText / truncateLine ────────────────────────────────

describe("wrapText", () => {
  it("wraps long lines at width", () => {
    const lines = wrapText("abcdefghij", 4);
    expect(lines).toEqual(["abcd", "efgh", "ij"]);
  });

  it("preserves empty lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});

describe("truncateLine", () => {
  it("keeps short text as-is", () => {
    expect(truncateLine("abc", 10)).toBe("abc");
  });

  it("truncates long text with ellipsis", () => {
    const out = truncateLine("abcdefghij", 5);
    expect(out.length).toBe(5);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("extractText", () => {
  it("handles string content", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("handles content blocks and marks images", () => {
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "b" },
      ])
    ).toBe("a\n[图片]\nb");
  });
});

describe("summarizeArgs", () => {
  it("prefers path-like arguments", () => {
    expect(summarizeArgs("read", { path: "src/index.ts", offset: 1 })).toBe("src/index.ts");
  });

  it("falls back to key list", () => {
    expect(summarizeArgs("web_search", { foo: 1, bar: 2 })).toBe("foo, bar");
  });

  it("truncates long values", () => {
    const out = summarizeArgs("bash", { command: "x".repeat(200) });
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it("honors the caller-provided width budget", () => {
    const wide = summarizeArgs("bash", { command: "x".repeat(200) }, 40);
    expect(wide.length).toBeLessThanOrEqual(40);
    expect(wide.endsWith("…")).toBe(true);
    // Short values are never truncated, regardless of budget
    expect(summarizeArgs("read", { path: "a.ts" }, 10)).toBe("a.ts");
  });

  it("defaults to the fixed 60-char cap when no width is given", () => {
    expect(summarizeArgs("bash", { command: "y".repeat(200) }).length).toBeLessThanOrEqual(60);
  });
});

// ── fitLinesToWidth (P1-① 构建期定宽契约) ────────────────

describe("fitLinesToWidth", () => {
  it("pads short lines to exactly the target width", () => {
    const out = fitLinesToWidth(["hello", ""], 10);
    expect(out[0]).toBe("hello     ");
    expect(out[1]).toBe("          ");
  });

  it("truncates over-wide lines with an ellipsis", () => {
    const out = fitLinesToWidth(["abcdefghij"], 5);
    expect(out[0].length).toBe(5);
    expect(out[0].endsWith("…")).toBe(true);
  });

  it("leaves exactly-fitting lines untouched", () => {
    const out = fitLinesToWidth(["12345"], 5);
    expect(out[0]).toBe("12345");
  });

  it("truncates over-wide lines to exactly the target width", () => {
    // Pure-ASCII over-wide line: single-pass fast path must hit the same
    // contract (visible width ≤ target, ellipsis appended). ANSI-colored
    // line behaviour is covered in member-inspector-state.singlepass.test.ts
    // with the real pi-tui (ANSI sequences count as width 0).
    const out = fitLinesToWidth(["1234567890"], 6);
    expect(out[0]).toBe("12345…");
    expect(out[0].length).toBe(6);
  });

  it("returns empty array for empty input", () => {
    expect(fitLinesToWidth([], 10)).toEqual([]);
  });

  it("degenerates to identity when width <= 0", () => {
    expect(fitLinesToWidth(["a", "bb"], 0)).toEqual(["a", "bb"]);
    expect(fitLinesToWidth(["a"], -3)).toEqual(["a"]);
  });

  it("纯 ASCII 行走快路径：直接取 length，不调用 visibleWidth", () => {
    const vw = vi.mocked(visibleWidth);
    vw.mockClear();
    const out = fitLinesToWidth(["hello", "world", ""], 10);
    expect(out).toEqual(["hello     ", "world     ", "          "]);
    expect(vw).not.toHaveBeenCalled();
  });

  it("CJK/ANSI/tab 行仍走 visibleWidth（宽度语义不变）", () => {
    const vw = vi.mocked(visibleWidth);
    vw.mockClear();
    fitLinesToWidth(["你好", "\x1b[36mhi\x1b[0m", "a\tb"], 6);
    // 非 ASCII 行必须仍调用 visibleWidth（fast path 只豁免纯 ASCII）
    expect(vw).toHaveBeenCalled();
  });
});

// ── buildBodyLines ─────────────────────────────────────────

describe("buildBodyLines", () => {
  const opts = { width: 80, expanded: false, theme: IDENTITY_THEME };

  it("renders user and assistant text in full", () => {
    const lines = buildBodyLines(
      [userMsg("你好"), assistantMsg(textBlock("世界"))],
      opts
    );
    expect(lines).toContain("● user");
    expect(lines).toContain("你好");
    expect(lines).toContain("● assistant");
    expect(lines).toContain("世界");
    // One blank line between the two blocks, no trailing blank
    expect(lines.indexOf("● assistant") - lines.indexOf("你好")).toBe(2);
    expect(lines[lines.length - 1]).toBe("世界");
  });

  it("hides thinking blocks by default", () => {
    const lines = buildBodyLines(
      [assistantMsg(thinkingBlock("secret reasoning"), textBlock("answer"))],
      opts
    );
    expect(lines.join("\n")).not.toContain("secret reasoning");
    expect(lines).toContain("answer");
  });

  it("shows thinking blocks when showThinking=true", () => {
    const lines = buildBodyLines(
      [assistantMsg(thinkingBlock("secret reasoning"), textBlock("answer"))],
      { ...opts, showThinking: true }
    );
    expect(lines.join("\n")).toContain("💭 思考");
    expect(lines.join("\n")).toContain("secret reasoning");
    expect(lines).toContain("answer");
  });

  it("skips empty thinking blocks even when showThinking=true", () => {
    const lines = buildBodyLines(
      [assistantMsg(thinkingBlock("   "), textBlock("answer"))],
      { ...opts, showThinking: true }
    );
    expect(lines.join("\n")).not.toContain("💭");
    expect(lines).toContain("answer");
  });

  it("wraps long thinking text within width when showThinking=true", () => {
    const lines = buildBodyLines(
      [assistantMsg(thinkingBlock("x".repeat(200)))],
      { ...opts, width: 40, showThinking: true }
    );
    expect(lines.some((l) => l.includes("💭"))).toBe(true);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(40);
    }
  });

  it("collapses tool calls to one-line summaries by default", () => {
    const lines = buildBodyLines(
      [assistantMsg(toolCallBlock("read", { path: "a.ts" }))],
      opts
    );
    const toolLines = lines.filter((l) => l.includes("🔧"));
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).toContain("read");
    expect(toolLines[0]).toContain("a.ts");
    // No JSON dump in collapsed mode
    expect(lines.join("\n")).not.toContain('"path"');
  });

  it("expands tool call arguments when expanded=true", () => {
    const lines = buildBodyLines(
      [assistantMsg(toolCallBlock("read", { path: "a.ts" }))],
      { ...opts, expanded: true }
    );
    expect(lines.join("\n")).toContain('"path"');
  });

  it("sizes completed tool call summaries to the frame width", () => {
    // Regression: summaries used a fixed 60-char cap even on wide frames;
    // they must now use the actual width budget (textWidth - 14), so a
    // wide frame shows more than 60 chars of the argument.
    const lines = buildBodyLines(
      [assistantMsg(toolCallBlock("bash", { command: "x".repeat(200) }))],
      { ...opts, width: 120 }
    );
    const toolLines = lines.filter((l) => l.includes("🔧"));
    expect(toolLines.join("\n")).toMatch(/x{61,}/);
  });

  it("truncates completed tool call summaries to the frame width on narrow frames", () => {
    const lines = buildBodyLines(
      [assistantMsg(toolCallBlock("bash", { command: "x".repeat(200) }))],
      { ...opts, width: 40 }
    );
    const toolLines = lines.filter((l) => l.includes("🔧"));
    // width 40 → textWidth 38 → budget Math.max(10, 38-14)=24 → 23 x + …
    expect(toolLines.join("\n")).toMatch(/x{23}…/);
  });

  it("renders tool result as one-line summary with status icon", () => {
    const ok = buildBodyLines([toolResultMsg("read", "file contents here")], opts);
    expect(ok.some((l) => l.includes("✓ read"))).toBe(true);
    const err = buildBodyLines([toolResultMsg("read", "boom", true)], opts);
    expect(err.some((l) => l.includes("✗ read"))).toBe(true);
  });

  it("expands tool result content when expanded=true", () => {
    const lines = buildBodyLines(
      [toolResultMsg("bash", "line1\nline2")],
      { ...opts, expanded: true }
    );
    expect(lines.join("\n")).toContain("line1");
    expect(lines.join("\n")).toContain("line2");
  });

  it("handles unknown roles defensively", () => {
    const lines = buildBodyLines([{ role: "custom", data: 1 }], opts);
    expect(lines.some((l) => l.startsWith("[custom]"))).toBe(true);
  });

  it("wraps long user text to width", () => {
    const lines = buildBodyLines([userMsg("x".repeat(200))], { ...opts, width: 40 });
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(40);
    }
  });

  it("expandArgs long JSON lines wrap to width with full content", () => {
    const long = { path: "x".repeat(300) };
    const lines = buildBodyLines([assistantMsg(toolCallBlock("read", long))], {
      ...opts,
      expanded: true,
    });
    // Wrap (not truncate): every display line fits the width…
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(opts.width);
    }
    // …and the full 300-char value survives (no hard truncation).
    expect(lines.join("")).toContain("x".repeat(300));
  });

  it("expandArgs wraps long values into multiple lines (no ellipsis loss)", () => {
    const long = { command: "a".repeat(120) };
    const lines = buildBodyLines([assistantMsg(toolCallBlock("bash", long))], {
      ...opts,
      expanded: true,
    });
    const joined = lines.join("\n");
    // Content lines are wrapped, so no line carries a truncation ellipsis
    // beyond the 4-space indent (the one-line summary's own width-budgeted
    // "…" is absent because summarizeArgs prefers `command` = 120 chars →
    // sliced — filter it out by looking at the indented JSON region).
    const jsonRegion = joined.split("\n").filter((l) => l.startsWith("    "));
    expect(jsonRegion.length).toBeGreaterThan(1);
    for (const l of jsonRegion) {
      expect(l.length).toBeLessThanOrEqual(opts.width);
      expect(l.endsWith("…")).toBe(false);
    }
    // No separator: the wrapped value stays contiguous across lines
    expect(lines.join("")).toContain("a".repeat(120));
  });

  it("expandArgs caps display lines at the budget with an overflow marker", () => {
    // 60 keys → raw JSON has 60+ lines, well over the 40-line budget.
    const args: Record<string, any> = {};
    for (let i = 0; i < 60; i++) args[`key${i}`] = `v${i}`;
    const lines = buildBodyLines([assistantMsg(toolCallBlock("write", args))], {
      ...opts,
      expanded: true,
    });
    const keyLines = lines.filter((l) => l.startsWith("    ") && l.includes("key"));
    expect(keyLines.length).toBeLessThanOrEqual(40);
    expect(lines.some((l) => l.trim() === "…")).toBe(true);
  });

  it("collapsed summary line wraps when the one-liner exceeds width", () => {
    // A long tool name pushes the one-liner past the frame width even
    // though the summary itself is already truncated to the frame budget
    // (width 40 → textWidth 38 → budget 24 = 23 p + …) → wraps, not cut.
    const long = { path: "p".repeat(90) };
    const lines = buildBodyLines(
      [assistantMsg(toolCallBlock("true_sight_diff_impact", long))],
      { ...opts, width: 40 }
    );
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(40);
    }
    // The width-budgeted summary survives in full (wrapped, not cut)
    expect(lines.join("")).toContain("p".repeat(23) + "…");
    // Wrapped into two lines: label line + continuation (label carries 🔧)
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.includes("🔧"))).toHaveLength(1);
  });
});

// ── buildHeaderLine / buildFooterStatusLine ────────────────

describe("buildHeaderLine", () => {
  it("marks the active tab with ❰❱", () => {
    const state = new MemberInspectorState([
      { name: "a", label: "分析员" },
      { name: "b", label: "编码员" },
    ]);
    const line = buildHeaderLine(state.tabs, 0, 80);
    expect(line).toContain("❰分析员❱");
    expect(line).toContain("编码员");
  });

  it("truncates to width", () => {
    const state = new MemberInspectorState(
      Array.from({ length: 20 }, (_, i) => ({ name: `m${i}`, label: `member-${i}` }))
    );
    const line = buildHeaderLine(state.tabs, 0, 40);
    expect(line.length).toBeLessThanOrEqual(40);
  });
});

describe("buildFooterStatusLine", () => {
  it("shows status icons and context percent", () => {
    const state = new MemberInspectorState([
      { name: "a", label: "分析员" },
      { name: "b", label: "编码员" },
    ]);
    state.tabs[0].contextInfo = { percent: 42, tokens: 42000, contextWindow: 100000 };
    const ops = new Map([
      ["a", "working" as const],
      ["b", "crashed" as const],
    ]);
    const line = buildFooterStatusLine(state.tabs, ops, 120);
    expect(line).toContain("💭 分析员 42%");
    expect(line).toContain("💥 编码员 —");
  });

  it("renders '?' for a null context percent (post-compaction unknown — no misleading 0%)", () => {
    // 压缩完成后 get_session_stats 返回 percent:null（合法「未知」）——
    // Math.round(null)===0 的 "0%" 是误导（问题二 Phase 2，gamma 发现）。
    const state = new MemberInspectorState([{ name: "a", label: "分析员" }]);
    state.tabs[0].contextInfo = { percent: null, tokens: null, contextWindow: 100000 };
    const ops = new Map([["a", "working" as const]]);
    const line = buildFooterStatusLine(state.tabs, ops, 120);
    expect(line).toContain("💭 分析员 ?");
    expect(line).not.toContain("0%");
  });
});

// ── MemberInspectorState ───────────────────────────────────

describe("applyAssistantDelta (live streaming assembly)", () => {
  it("assembles a thinking block from start/delta/end deltas", () => {
    const live = createLiveAssistantMessage({ role: "assistant", content: [] });
    applyAssistantDelta(live, { type: "thinking_start", contentIndex: 0 });
    applyAssistantDelta(live, { type: "thinking_delta", contentIndex: 0, delta: "让我先分析" });
    applyAssistantDelta(live, { type: "thinking_delta", contentIndex: 0, delta: "一下需求" });
    expect(live.content).toEqual([{ type: "thinking", thinking: "让我先分析一下需求" }]);
    applyAssistantDelta(live, { type: "thinking_end", contentIndex: 0, content: "让我先分析一下需求" });
    expect(live.content[0]).toEqual({ type: "thinking", thinking: "让我先分析一下需求" });
  });

  it("assembles a text block after thinking (mixed contentIndex)", () => {
    const live = createLiveAssistantMessage({ role: "assistant", content: [] });
    applyAssistantDelta(live, { type: "thinking_start", contentIndex: 0 });
    applyAssistantDelta(live, { type: "thinking_delta", contentIndex: 0, delta: "想" });
    applyAssistantDelta(live, { type: "text_start", contentIndex: 1 });
    applyAssistantDelta(live, { type: "text_delta", contentIndex: 1, delta: "好" });
    applyAssistantDelta(live, { type: "text_delta", contentIndex: 1, delta: "的" });
    expect(live.content).toEqual([
      { type: "thinking", thinking: "想" },
      { type: "text", text: "好的" },
    ]);
  });

  it("fills missing blocks at contentIndex (defensive gap fill)", () => {
    const live = createLiveAssistantMessage({ role: "assistant", content: [] });
    // No prior *_start for index 1 — the block is created on demand
    applyAssistantDelta(live, { type: "text_delta", contentIndex: 1, delta: "hi" });
    expect(live.content).toEqual([{ type: "text", text: "" }, { type: "text", text: "hi" }]);
  });

  it("keeps initial blocks seeded by message_start", () => {
    const live = createLiveAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed" }],
    });
    applyAssistantDelta(live, { type: "text_delta", contentIndex: 0, delta: "+more" });
    expect(live.content[0].text).toBe("seed+more");
  });

  it("clones content so live mutation never touches the source message", () => {
    const source = { role: "assistant", content: [{ type: "text", text: "x" }] };
    const live = createLiveAssistantMessage(source);
    applyAssistantDelta(live, { type: "text_delta", contentIndex: 0, delta: "y" });
    expect(live.content[0].text).toBe("xy");
    expect(source.content[0].text).toBe("x");
  });

  it("streams toolcall args as raw partial JSON, finalized on toolcall_end", () => {
    const live = createLiveAssistantMessage({ role: "assistant", content: [] });
    applyAssistantDelta(live, { type: "toolcall_start", contentIndex: 0 });
    applyAssistantDelta(live, { type: "toolcall_delta", contentIndex: 0, delta: '{"path":' });
    expect(live.content[0].type).toBe("toolCall");
    expect(live.content[0].partialArgs).toBe('{"path":');
    applyAssistantDelta(live, { type: "toolcall_delta", contentIndex: 0, delta: '"a.ts"}' });
    expect(live.content[0].arguments).toEqual({ path: "a.ts" });
    const toolCall = { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } };
    applyAssistantDelta(live, { type: "toolcall_end", contentIndex: 0, toolCall });
    expect(live.content[0]).toEqual(toolCall);
  });

  it("ignores malformed deltas (no contentIndex / unknown type / null)", () => {
    const live = createLiveAssistantMessage({ role: "assistant", content: [] });
    applyAssistantDelta(live, null as any);
    applyAssistantDelta(live, { type: "text_delta" } as any);
    applyAssistantDelta(live, { type: "mystery_delta", contentIndex: 0, delta: "x" } as any);
    expect(live.content).toEqual([]);
  });

  it("buildBodyLines renders a streaming live thinking block (showThinking)", () => {
    const live = createLiveAssistantMessage({ role: "assistant", content: [] });
    applyAssistantDelta(live, { type: "thinking_start", contentIndex: 0 });
    applyAssistantDelta(live, { type: "thinking_delta", contentIndex: 0, delta: "正在思考" });
    const lines = buildBodyLines([live], { width: 60, expanded: false, showThinking: true });
    expect(lines.join("\n")).toContain("💭 思考");
    expect(lines.join("\n")).toContain("正在思考");
    // Hidden by default
    const hidden = buildBodyLines([live], { width: 60, expanded: false });
    expect(hidden.join("\n")).not.toContain("正在思考");
  });

  it("buildBodyLines renders a streaming tool call as 调用中 with raw JSON", () => {
    const live = createLiveAssistantMessage({ role: "assistant", content: [] });
    applyAssistantDelta(live, { type: "toolcall_start", contentIndex: 0 });
    applyAssistantDelta(live, { type: "toolcall_delta", contentIndex: 0, delta: '{"path": "a.ts"}' });
    const lines = buildBodyLines([live], { width: 60, expanded: false });
    const joined = lines.join("\n");
    expect(joined).toContain("调用中");
    expect(joined).toContain('{"path": "a.ts"}');
  });
});

describe("MemberInspectorState live streaming", () => {
  function makeState() {
    return new MemberInspectorState([{ name: "a", label: "A" }]);
  }

  it("setLiveMessage resets the live buffer; applyLiveDelta appends", () => {
    const s = makeState();
    s.setLiveMessage("a", { role: "assistant", content: [{ type: "text", text: "hi" }] });
    expect(s.tabs[0].live?.content).toEqual([{ type: "text", text: "hi" }]);
    s.applyLiveDelta("a", { type: "text_delta", contentIndex: 0, delta: "!" });
    expect(s.tabs[0].live?.content[0].text).toBe("hi!");
  });

  it("applyLiveDelta lazily creates a live message when message_start was missed", () => {
    const s = makeState();
    s.applyLiveDelta("a", { type: "thinking_delta", contentIndex: 0, delta: "想" });
    expect(s.tabs[0].live?.content[0]).toEqual({ type: "thinking", thinking: "想" });
  });

  it("completeLiveMessage moves live → pendingCompletions; clearStreaming drops both", () => {
    const s = makeState();
    s.setLiveMessage("a", { role: "assistant", content: [{ type: "text", text: "done" }] });
    const authoritative = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 9 };
    s.completeLiveMessage("a", authoritative);
    expect(s.tabs[0].live).toBeNull();
    expect(s.tabs[0].pendingCompletions).toEqual([authoritative]);
    s.clearStreaming("a");
    expect(s.tabs[0].live).toBeNull();
    expect(s.tabs[0].pendingCompletions).toEqual([]);
  });

  it("reconcilePending drops confirmed tail entries, keeps unconfirmed", () => {
    const s = makeState();
    const m1 = { role: "assistant", content: [{ type: "text", text: "one" }] };
    const m2 = { role: "assistant", content: [{ type: "text", text: "two" }] };
    s.tabs[0].pendingCompletions = [m1, m2];
    // History tail contains m1 (identical content) but not m2
    s.reconcilePending("a", [
      { role: "user", content: "prompt" },
      { role: "assistant", content: [{ type: "text", text: "one" }], timestamp: 42 },
    ]);
    expect(s.tabs[0].pendingCompletions).toEqual([m2]);
    // Now m2 lands too
    s.reconcilePending("a", [
      { role: "user", content: "prompt" },
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ]);
    expect(s.tabs[0].pendingCompletions).toEqual([]);
  });

  it("reconcilePending keeps everything when nothing is confirmed", () => {
    const s = makeState();
    const m1 = { role: "assistant", content: [{ type: "text", text: "one" }] };
    s.tabs[0].pendingCompletions = [m1];
    s.reconcilePending("a", [{ role: "user", content: "prompt" }]);
    expect(s.tabs[0].pendingCompletions).toEqual([m1]);
  });

  it("reconcilePending tolerates interleaved toolResult messages between completions", () => {
    const s = makeState();
    const m1 = { role: "assistant", content: [{ type: "text", text: "one" }] };
    const m2 = { role: "assistant", content: [{ type: "text", text: "two" }] };
    s.tabs[0].pendingCompletions = [m1, m2];
    // History tail: m1, then a toolResult, then m2 — both completions are in
    // history but not contiguously; both must be confirmed.
    s.reconcilePending("a", [
      { role: "user", content: "prompt" },
      m1,
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "out" }] },
      m2,
    ]);
    expect(s.tabs[0].pendingCompletions).toEqual([]);
    // Only m1 in history → only m1 confirmed (m2 kept)
    s.tabs[0].pendingCompletions = [m1, m2];
    s.reconcilePending("a", [{ role: "user", content: "prompt" }, m1]);
    expect(s.tabs[0].pendingCompletions).toEqual([m2]);
  });

  it("reconcilePending keeps one of two identical completions when only one landed", () => {
    const s = makeState();
    const same = { role: "assistant", content: [{ type: "text", text: "好的" }] };
    const clone = { role: "assistant", content: [{ type: "text", text: "好的" }] };
    s.tabs[0].pendingCompletions = [same, clone];
    s.reconcilePending("a", [{ role: "user", content: "prompt" }, same]);
    expect(s.tabs[0].pendingCompletions).toEqual([clone]);
  });

  it("syncMembers gives new tabs null live + empty pendingCompletions", () => {
    const s = makeState();
    s.syncMembers([{ name: "a", label: "A" }, { name: "z", label: "Z" }]);
    const z = s.tabs.find((t) => t.name === "z")!;
    expect(z.live).toBeNull();
    expect(z.pendingCompletions).toEqual([]);
  });
});

describe("MemberInspectorState", () => {
  function makeState() {
    return new MemberInspectorState([
      { name: "a", label: "A" },
      { name: "b", label: "B" },
      { name: "c", label: "C" },
    ]);
  }

  it("switchTab wraps around both directions", () => {
    const s = makeState();
    expect(s.activeIndex).toBe(0);
    s.switchTab(-1);
    expect(s.activeIndex).toBe(2);
    s.switchTab(1);
    expect(s.activeIndex).toBe(0);
    s.switchTab(1);
    expect(s.activeIndex).toBe(1);
  });

  it("syncMembers preserves existing tab state and adds new members", () => {
    const s = makeState();
    s.tabs[0].scrollOffset = 7;
    s.tabs[0].followTail = false;
    s.syncMembers([
      { name: "a", label: "A" },
      { name: "b", label: "B" },
      { name: "c", label: "C" },
      { name: "d", label: "D" },
    ]);
    expect(s.tabs).toHaveLength(4);
    expect(s.tabs[0].scrollOffset).toBe(7);
    expect(s.tabs[0].followTail).toBe(false);
    expect(s.tabs[3].name).toBe("d");
    expect(s.tabs[3].dirty).toBe(true); // fetch on first appearance
  });

  it("setTabLines pins to bottom when followTail", () => {
    const s = makeState();
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    s.setTabLines("a", lines, 10);
    expect(s.tabs[0].scrollOffset).toBe(90);
    expect(s.tabs[0].newBelow).toBe(false);
  });

  it("setTabLines keeps scroll and marks newBelow when scrolled up", () => {
    const s = makeState();
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    s.setTabLines("a", lines, 10);
    // Scroll up → stop following
    s.scrollBy(-20, 10);
    expect(s.tabs[0].followTail).toBe(false);
    const offsetBefore = s.tabs[0].scrollOffset;
    // New content arrives
    s.setTabLines("a", [...lines, "line 100", "line 101"], 10);
    expect(s.tabs[0].scrollOffset).toBe(offsetBefore);
    expect(s.tabs[0].newBelow).toBe(true);
    // End clears the indicator
    s.scrollToEnd(10);
    expect(s.tabs[0].newBelow).toBe(false);
    expect(s.tabs[0].followTail).toBe(true);
  });

  it("scrollBy clamps to [0, maxOffset] and restores followTail at bottom", () => {
    const s = makeState();
    const lines = Array.from({ length: 50 }, (_, i) => `l${i}`);
    s.setTabLines("a", lines, 10);
    s.scrollBy(-100, 10);
    expect(s.tabs[0].scrollOffset).toBe(0);
    expect(s.tabs[0].followTail).toBe(false);
    s.scrollBy(100, 10);
    expect(s.tabs[0].scrollOffset).toBe(40);
    expect(s.tabs[0].followTail).toBe(true);
  });

  it("T1: toggleExpand flips the GLOBAL expanded and marks ALL tabs dirty", () => {
    const s = makeState();
    for (const t of s.tabs) t.dirty = false;
    s.toggleExpand();
    expect(s.expanded).toBe(true);
    // Every tab is dirty — not just the active one (global view-mode toggle)
    for (const t of s.tabs) expect(t.dirty).toBe(true);
    s.toggleExpand();
    expect(s.expanded).toBe(false);
  });

  it("toggleThinking flips the GLOBAL showThinking and marks ALL tabs dirty", () => {
    const s = makeState();
    for (const t of s.tabs) t.dirty = false;
    expect(s.showThinking).toBe(false);
    s.toggleThinking();
    expect(s.showThinking).toBe(true);
    for (const t of s.tabs) expect(t.dirty).toBe(true);
    s.toggleThinking();
    expect(s.showThinking).toBe(false);
  });

  it("syncMembers preserves the global toggles across member reconciliation", () => {
    const s = makeState();
    s.toggleThinking();
    s.syncMembers([
      { name: "a", label: "A" },
      { name: "b", label: "B" },
      { name: "c", label: "C" },
      { name: "d", label: "D" },
    ]);
    expect(s.showThinking).toBe(true);
  });

  it("T4: empty tabs — toggles flip the global value without throwing", () => {
    const s = new MemberInspectorState([]);
    expect(s.tabs).toHaveLength(0);
    s.toggleExpand();
    expect(s.expanded).toBe(true);
    s.toggleThinking();
    expect(s.showThinking).toBe(true);
  });

  it("input buffer supports insert/backspace/clear with unicode safety", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("你好a");
    expect(s.inputBuffer).toBe("你好a");
    s.backspaceInput();
    expect(s.inputBuffer).toBe("你好");
    s.clearInput();
    expect(s.inputBuffer).toBe("");
    s.closeInput();
    expect(s.inputOpen).toBe(false);
  });
});

// ── 阶段 1：输入编辑内核（光标与按位编辑）─────────────────────
//
// 交付物（方案 §5 阶段 1）：光标记录与移动方法；插入改为在光标处拼接；
// 退格改为删除光标前一个「可见字符」（grapheme）；打开/关闭/清空归零。
// 本阶段不接线按键、不修改渲染——渲染窗口测试属阶段 2。

/** UTF-16 下标集合：`text` 中所有可见字符（grapheme）边界。 */
function graphemeBoundaries(text: string): Set<number> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const bounds = new Set<number>();
  for (const part of segmenter.segment(text)) {
    bounds.add(part.index);
    bounds.add(part.index + part.segment.length);
  }
  bounds.add(0);
  bounds.add(text.length);
  return bounds;
}

describe("MemberInspectorState — 阶段 1：输入编辑内核（光标与按位编辑）", () => {
  function makeState() {
    return new MemberInspectorState([
      { name: "a", label: "A" },
      { name: "b", label: "B" },
    ]);
  }

  it("inputCursor 默认 0，打开/关闭/清空时归零", () => {
    const s = makeState();
    expect(s.inputCursor).toBe(0);

    s.openInput();
    s.insertInput("abc");
    expect(s.inputCursor).toBe(3);
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(2);
    s.closeInput();
    expect(s.inputCursor).toBe(0);
    expect(s.inputBuffer).toBe("");

    s.openInput();
    s.insertInput("xy");
    s.moveInputCursor(-1);
    s.clearInput();
    expect(s.inputCursor).toBe(0);
    expect(s.inputBuffer).toBe("");
  });

  it("openInput 丢弃上一轮草稿并把光标归零", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("draft");
    s.moveInputCursor(-1);
    s.openInput(); // 再次打开（不应保留旧内容/旧光标）
    expect(s.inputBuffer).toBe("");
    expect(s.inputCursor).toBe(0);
  });

  it("移动边界：开头左移、末尾右移、空串移动均为无操作", () => {
    const s = makeState();
    s.openInput();
    expect(s.inputCursor).toBe(0);
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(0);
    s.moveInputCursor(1);
    expect(s.inputCursor).toBe(0); // 空串：两个方向都停住

    s.insertInput("ab");
    expect(s.inputCursor).toBe(2);
    s.moveInputCursor(1);
    expect(s.inputCursor).toBe(2); // 末尾：不越界

    s.moveInputCursor(-1);
    s.moveInputCursor(-1);
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(0); // 开头：不越界、不环绕
  });

  it("中段插入：字符插入到光标处并推进光标", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("abcd");
    s.moveInputCursor(-1);
    s.moveInputCursor(-1); // 光标移到 ab|cd
    s.insertInput("X");
    expect(s.inputBuffer).toBe("abXcd");
    expect(s.inputCursor).toBe(3);
  });

  it("中段退格：删除光标前一个字符并回退光标", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("abXcd");
    s.moveInputCursor(-1);
    s.moveInputCursor(-1); // 光标在 X 之后：abX|cd
    s.backspaceInput();
    expect(s.inputBuffer).toBe("abcd");
    expect(s.inputCursor).toBe(2);
  });

  it("退格在光标为 0 时为无操作", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("a");
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(0);
    s.backspaceInput();
    expect(s.inputBuffer).toBe("a");
    expect(s.inputCursor).toBe(0);
  });

  it("中文：左右键与退格按一个汉字步进", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("你好a");
    expect(s.inputCursor).toBe(3);
    s.backspaceInput(); // 删 'a'
    expect(s.inputBuffer).toBe("你好");
    expect(s.inputCursor).toBe(2);
    s.moveInputCursor(-1); // 你|好
    expect(s.inputCursor).toBe(1);
    s.insertInput("X");
    expect(s.inputBuffer).toBe("你X好");
    expect(s.inputCursor).toBe(2);
    s.backspaceInput(); // 删 'X'
    expect(s.inputBuffer).toBe("你好");
    expect(s.inputCursor).toBe(1);
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(0); // 再左移正好停在开头
  });

  it("emoji ZWJ 家族（👨‍👩‍👧）：整体步进、整体删除", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("a👨‍👩‍👧b"); // a(1) + 家族(8) + b(1) = 10
    expect(s.inputCursor).toBe(10);
    s.backspaceInput(); // 直接删 'b'（光标在末尾）
    expect(s.inputBuffer).toBe("a👨‍👩‍👧");
    expect(s.inputCursor).toBe(9);
    s.moveInputCursor(-1); // 跨过整个家族（不是半个）
    expect(s.inputCursor).toBe(1);
    s.backspaceInput(); // 删 'a'
    expect(s.inputBuffer).toBe("👨‍👩‍👧");
    expect(s.inputCursor).toBe(0);
    s.moveInputCursor(1); // 再右移跨过整个家族
    expect(s.inputCursor).toBe(8);
    s.backspaceInput(); // 整只删除，不留半个乱码
    expect(s.inputBuffer).toBe("");
    expect(s.inputCursor).toBe(0);
  });

  it("组合字符（e + U+0301）：整体步进、整体删除", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("ce\u0301d"); // c(1) + é(2) + d(1) = 4
    expect(s.inputCursor).toBe(4);
    s.backspaceInput(); // 删 'd'
    expect(s.inputBuffer).toBe("ce\u0301");
    expect(s.inputCursor).toBe(3);
    s.moveInputCursor(-1); // 跨过整个 é（不是只剩重音）
    expect(s.inputCursor).toBe(1);
    s.backspaceInput(); // 删 'c'
    expect(s.inputBuffer).toBe("e\u0301");
    expect(s.inputCursor).toBe(0);
    s.moveInputCursor(1);
    expect(s.inputCursor).toBe(2);
  });

  it("旗帜符号（🇨🇳）：整体步进、整体删除", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("🇨🇳x"); // 旗帜(4) + x(1) = 5
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(4);
    s.backspaceInput(); // 删除整面旗帜
    expect(s.inputBuffer).toBe("x");
    expect(s.inputCursor).toBe(0);
    s.insertInput("🇨🇳");
    expect(s.inputBuffer).toBe("🇨🇳x");
    expect(s.inputCursor).toBe(4);
    s.moveInputCursor(1);
    expect(s.inputCursor).toBe(5);
  });

  it("回归（重要 1）：插入字符与既有后缀合并成新簇时光标吸附到簇边界", () => {
    const s = makeState();
    s.openInput();
    // 孤立组合符之前插入 'e' → 合并为单簇 "é"（e + U+0301）
    s.insertInput("\u0301");
    expect(s.inputCursor).toBe(1);
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(0);
    s.insertInput("e");
    expect(s.inputBuffer).toBe("e\u0301");
    expect(graphemeBoundaries(s.inputBuffer).has(s.inputCursor)).toBe(true);
    expect(s.inputCursor).toBe(2); // 吸附到合并簇末尾，不是名义位置 1
    s.backspaceInput(); // 整簇删除，不留孤立组合符
    expect(s.inputBuffer).toBe("");
    expect(s.inputCursor).toBe(0);
  });

  it("回归（重要 1）：两张区域指示符合并成一面旗时不产生半簇光标", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("🇨"); // 单区域指示符（2）
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(0);
    s.insertInput("🇳"); // 插到前面 → 与后缀合并为一个区域指示符对 "🇳🇨"（4）
    expect(s.inputBuffer).toBe("🇳🇨");
    expect(graphemeBoundaries(s.inputBuffer).has(s.inputCursor)).toBe(true);
    expect(s.inputCursor).toBe(4);
    s.backspaceInput(); // 必须整对删除（旧缺陷：只删半个）
    expect(s.inputBuffer).toBe("");
    expect(s.inputCursor).toBe(0);
  });

  it("回归（重要 1 同类）：退格删除分隔符后左右碎片合并成新簇时光标吸附到边界", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("🇨Z🇳"); // 三个独立簇（2+1+2）
    s.moveInputCursor(-1); // 光标移到 Z 与 🇳 之间（cursor 3）
    expect(s.inputCursor).toBe(3);
    s.backspaceInput(); // 删 Z → "🇨🇳" 合并为一面旗（4）
    expect(s.inputBuffer).toBe("🇨🇳");
    expect(graphemeBoundaries(s.inputBuffer).has(s.inputCursor)).toBe(true);
    expect(s.inputCursor).toBe(4); // 吸附到合并簇末尾，不是名义位置 2
    s.backspaceInput(); // 整面删除，不留半簇
    expect(s.inputBuffer).toBe("");
    expect(s.inputCursor).toBe(0);
  });

  it("回归（重要 1 同类）：退格删除 ZWJ 链中间字符后合并成单簇时光标吸附到边界", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("👨\u200dX👩"); // "👨‍"(3) + X(1) + "👩"(2)
    s.moveInputCursor(-1); // 光标在 X 与 👩 之间（cursor 4）
    expect(s.inputCursor).toBe(4);
    s.backspaceInput(); // 删 X → "👨‍👩" 合并为单簇（5）
    expect(s.inputBuffer).toBe("👨‍👩");
    expect(graphemeBoundaries(s.inputBuffer).has(s.inputCursor)).toBe(true);
    expect(s.inputCursor).toBe(5);
    s.backspaceInput(); // 整簇删除
    expect(s.inputBuffer).toBe("");
    expect(s.inputCursor).toBe(0);
  });

  it("回归（重要 1）：ZWJ 链式合并（👨 + ZWJ + 👩）后光标仍在簇边界", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("👨");
    s.insertInput("\u200d");
    s.insertInput("👩"); // 合并为单簇 "👨‍👩"（5）
    expect(s.inputBuffer).toBe("👨‍👩");
    expect(graphemeBoundaries(s.inputBuffer).has(s.inputCursor)).toBe(true);
    expect(s.inputCursor).toBe(5);
  });

  it("moveInputCursor(0) 运行时为无操作，不得右移（建议 3）", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("ab");
    s.moveInputCursor(-1);
    expect(s.inputCursor).toBe(1);
    // 类型上不允许 0，但运行时（JS 调用方 / 外部数据）可能传入
    (s.moveInputCursor as (delta: number) => void)(0);
    expect(s.inputCursor).toBe(1);
  });

  it("不变量：任意移动/插入/退格后光标始终落在可见字符边界且不越界", () => {
    const s = makeState();
    s.openInput();
    s.insertInput("a你👨‍👩‍👧e\u0301🇨🇳z");
    const text = s.inputBuffer;
    const bounds = graphemeBoundaries(text);
    expect(bounds.has(s.inputCursor)).toBe(true);

    // 从末尾一路左移回开头，每一步都必须落在边界上
    while (s.inputCursor > 0) {
      s.moveInputCursor(-1);
      expect(s.inputCursor).toBeGreaterThanOrEqual(0);
      expect(s.inputCursor).toBeLessThanOrEqual(text.length);
      expect(bounds.has(s.inputCursor)).toBe(true);
    }
    // 再一路右移到末尾
    while (s.inputCursor < text.length) {
      s.moveInputCursor(1);
      expect(s.inputCursor).toBeLessThanOrEqual(text.length);
      expect(bounds.has(s.inputCursor)).toBe(true);
    }

    // 中段插入 + 退格后仍保持不变量
    s.moveInputCursor(-1);
    s.insertInput("中");
    const afterInsert = graphemeBoundaries(s.inputBuffer);
    expect(afterInsert.has(s.inputCursor)).toBe(true);
    s.backspaceInput();
    const afterBackspace = graphemeBoundaries(s.inputBuffer);
    expect(afterBackspace.has(s.inputCursor)).toBe(true);
    expect(s.inputBuffer).toBe(text);
  });

  it("不变量（建议 2）：随机操作序列（insert+move+backspace）每步均在簇边界内", () => {
    // 含跨簇合并诱饵：孤立组合符 / ZWJ / 单个区域指示符 / 肤色修饰符
    const inserts = ["a", "你", "👨", "\u200d", "👩", "e", "\u0301", "🇨", "🇳", "👍🏽", "Z"];
    for (const seed0 of [0x2f6e2b1, 0x1234567, 0xdeadbeef, 0x5eed, 0xabcdef]) {
      const s = makeState();
      s.openInput();
      // 固定种子的 LCG：可复现，不依赖运行器随机性
      let seed = seed0;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0xffffffff;
      };
      for (let i = 0; i < 800; i++) {
        const roll = rand();
        if (roll < 0.35) s.insertInput(inserts[Math.floor(rand() * inserts.length)]);
        else if (roll < 0.6) s.moveInputCursor(-1);
        else if (roll < 0.85) s.moveInputCursor(1);
        else s.backspaceInput();

        const bounds = graphemeBoundaries(s.inputBuffer);
        const label = `seed=${seed0.toString(16)} step ${i}: type=${roll}`;
        expect(s.inputCursor, label).toBeGreaterThanOrEqual(0);
        expect(s.inputCursor, label).toBeLessThanOrEqual(s.inputBuffer.length);
        expect(
          bounds.has(s.inputCursor),
          `${label} buffer=${JSON.stringify(s.inputBuffer)}`
        ).toBe(true);
      }
    }
  });
});
