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

  it("handles ANSI-colored lines by visible width", () => {
    // Mock visibleWidth = text.length — the ANSI codes still count here;
    // real-width behavior is covered by inspector tests with real pi-tui.
    const colored = "\x1b[36mhi\x1b[0m";
    const out = fitLinesToWidth([colored], 6);
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

  it("expandArgs JSON lines are truncated by fitLinesToWidth (A2 contract)", () => {
    const long = { path: "x".repeat(300) };
    const lines = buildBodyLines([assistantMsg(toolCallBlock("read", long))], {
      ...opts,
      expanded: true,
    });
    const wide = lines.find((l) => l.includes('"path"'));
    expect(wide).toBeDefined();
    // Raw build output may exceed textWidth (expandArgs bypasses wrapText)…
    const fitted = fitLinesToWidth(lines, 40);
    for (const l of fitted) {
      expect(l.length).toBeLessThanOrEqual(40);
    }
    // …and the truncated line keeps its ellipsis
    expect(fitted.join("\n")).toContain("…");
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

  it("toggleExpand flips expanded and marks tab dirty for rebuild", () => {
    const s = makeState();
    s.tabs[0].dirty = false;
    s.toggleExpand();
    expect(s.tabs[0].expanded).toBe(true);
    expect(s.tabs[0].dirty).toBe(true);
  });

  it("toggleThinking flips showThinking and marks tab dirty for rebuild", () => {
    const s = makeState();
    s.tabs[0].dirty = false;
    expect(s.tabs[0].showThinking).toBe(false);
    s.toggleThinking();
    expect(s.tabs[0].showThinking).toBe(true);
    expect(s.tabs[0].dirty).toBe(true);
    s.toggleThinking();
    expect(s.tabs[0].showThinking).toBe(false);
  });

  it("syncMembers preserves showThinking across member reconciliation", () => {
    const s = makeState();
    s.toggleThinking();
    s.syncMembers([
      { name: "a", label: "A" },
      { name: "b", label: "B" },
      { name: "c", label: "C" },
      { name: "d", label: "D" },
    ]);
    expect(s.tabs[0].showThinking).toBe(true);
    expect(s.tabs[3].showThinking).toBe(false); // new tabs default off
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
