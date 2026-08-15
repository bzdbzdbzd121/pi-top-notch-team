import { describe, it, expect, vi } from "vitest";

// ── Mock pi-tui (same pattern as other ui tests) ──────────

vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: (text: string) => text.length,
}));

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
    expect(line).toContain("🔧 分析员 42%");
    expect(line).toContain("💥 编码员 —");
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
