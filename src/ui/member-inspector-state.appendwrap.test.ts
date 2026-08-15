import { describe, it, expect } from "vitest";
import {
  wrapAppendOnly,
  wrapText,
  nextStreamFlushDelay,
  buildBodyLines,
} from "./member-inspector-state";

// ── wrapAppendOnly (P2 streaming-tail wrap cache) ──────────
//
// The streaming tail is rebuilt every flush; thinking/text blocks grow by
// APPENDS only. wrapAppendOnly caches the wrapped state per block object
// (WeakMap) so each flush wraps only the new delta instead of re-wrapping
// the whole accumulated text — O(Δ) per flush instead of O(T), killing the
// O(T²) total cost of the thinking stream. Output MUST stay byte-identical
// to wrapText(fullText) at every step.

describe("wrapAppendOnly", () => {
  it("append-only growth is byte-identical to wrapText at every step (CJK + ASCII + newlines)", () => {
    const block = { type: "thinking", thinking: "" };
    const pieces = [
      "我们需要先分析",
      "一下这个函数的实现逻辑，然后再决定如何重构它。",
      "注意边界条件和异常处理。\n",
      "Next step: handle the edge cases carefully ",
      "and refactor 代码片段 with extra care.",
      "\n最后总结一下整体方案。",
    ];
    let text = "";
    for (const p of pieces) {
      text += p;
      expect(wrapAppendOnly(block, text, 30)).toEqual(wrapText(text, 30));
    }
  });

  it("grapheme cluster split across the delta boundary (ZWJ emoji) stays byte-identical", () => {
    const block = { type: "thinking", thinking: "" };
    let text = "前置文字 ";
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
    text += "👩";
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
    // ZWJ + 💻 complete the 👩‍💻 cluster across the boundary
    text += "‍💻 组合完成";
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
  });

  it("combining mark split across the delta boundary stays byte-identical", () => {
    const block = { type: "thinking", thinking: "" };
    let text = "cafe";
    wrapAppendOnly(block, text, 40);
    text += "́ 后缀"; // combining acute accent arrives in the next delta
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
  });

  it("handles \\r\\n split across deltas exactly like wrapText", () => {
    const block = { type: "thinking", thinking: "" };
    let text = "第一行\r";
    wrapAppendOnly(block, text, 40);
    text += "\n第二行";
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
  });

  it("drops a leading space at wrap points identically (char-by-char feed)", () => {
    const block = { type: "thinking", thinking: "" };
    const words = "word ".repeat(30).trim();
    let text = "";
    for (const chunk of words.match(/.{1,7}/g)!) {
      text += chunk;
      expect(wrapAppendOnly(block, text, 11)).toEqual(wrapText(text, 11));
    }
  });

  it("empty text and trailing newline edge cases match wrapText", () => {
    const block = { type: "thinking", thinking: "" };
    expect(wrapAppendOnly(block, "", 40)).toEqual(wrapText("", 40));
    let text = "a\n";
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
    text += "\n";
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
    text += "b";
    expect(wrapAppendOnly(block, text, 40)).toEqual(wrapText(text, 40));
  });

  it("resets on non-append mutation (shrink / same-length rewrite)", () => {
    const block = { type: "thinking", thinking: "" };
    wrapAppendOnly(block, "abcdef", 40);
    expect(wrapAppendOnly(block, "abc", 40)).toEqual(wrapText("abc", 40));
    expect(wrapAppendOnly(block, "abcXYZ", 40)).toEqual(wrapText("abcXYZ", 40));
    // same-length rewrite must not hit the stale cache
    expect(wrapAppendOnly(block, "abcXYQ", 40)).toEqual(wrapText("abcXYQ", 40));
  });

  it("rebuilds on width change and continues correctly at the new width", () => {
    const block = { type: "thinking", thinking: "" };
    const text = "中文换行测试".repeat(10);
    wrapAppendOnly(block, text, 20);
    expect(wrapAppendOnly(block, text, 30)).toEqual(wrapText(text, 30));
    expect(wrapAppendOnly(block, text + "追加内容", 30)).toEqual(wrapText(text + "追加内容", 30));
  });

  it("block identity isolates caches (two live blocks never share state)", () => {
    const b1 = { type: "thinking", thinking: "" };
    const b2 = { type: "thinking", thinking: "" };
    wrapAppendOnly(b1, "甲说", 40);
    wrapAppendOnly(b2, "乙说", 40);
    expect(wrapAppendOnly(b1, "甲说道", 40)).toEqual(wrapText("甲说道", 40));
    expect(wrapAppendOnly(b2, "乙说道", 40)).toEqual(wrapText("乙说道", 40));
  });

  it("buildBodyLines over a mutating live thinking block matches a fresh full build", () => {
    const live: any = { role: "assistant", content: [{ type: "thinking", thinking: "" }] };
    const opts = { width: 60, expanded: false, showThinking: true };
    let acc = "";
    for (const d of ["第一步思考 ", "第二步更深入的分析，包含一些细节 ", "第三步\n换行后的结论"]) {
      acc += d;
      live.content[0].thinking = acc;
      const viaCache = buildBodyLines([live], opts).join("\n");
      const fresh = buildBodyLines(
        [{ role: "assistant", content: [{ type: "thinking", thinking: acc }] }],
        opts
      ).join("\n");
      expect(viaCache).toBe(fresh);
    }
  });

  it("buildBodyLines over a mutating live TEXT block matches a fresh full build", () => {
    const live: any = { role: "assistant", content: [{ type: "text", text: "" }] };
    const opts = { width: 60, expanded: false };
    let acc = "";
    for (const d of ["回答的第一部分 ", "第二部分补充细节 ", "第三部分\n结论"] ) {
      acc += d;
      live.content[0].text = acc;
      const viaCache = buildBodyLines([live], opts).join("\n");
      const fresh = buildBodyLines(
        [{ role: "assistant", content: [{ type: "text", text: acc }] }],
        opts
      ).join("\n");
      expect(viaCache).toBe(fresh);
    }
  });

  it("long-stream amortized cost is far below full rewrap (perf guard)", () => {
    const block = { type: "thinking", thinking: "" };
    const delta = "增量思考内容，包含中英文 mixed content。";
    let text = "";
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      text += delta;
      wrapAppendOnly(block, text, 80);
    }
    const inc = performance.now() - t0;

    text = "";
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) {
      text += delta;
      wrapText(text, 80);
    }
    const full = performance.now() - t1;
    // O(T) vs O(T²): the margin is algorithmic, not constant-factor.
    expect(inc).toBeLessThan(full / 3);
  });
});

// ── nextStreamFlushDelay (adaptive stream cadence) ─────────

describe("nextStreamFlushDelay", () => {
  it("backs off when the build eats over half the interval", () => {
    expect(nextStreamFlushDelay(100, 60, 100, 1000)).toBe(200);
    expect(nextStreamFlushDelay(200, 150, 100, 1000)).toBe(400);
  });

  it("caps at maxMs", () => {
    expect(nextStreamFlushDelay(1000, 900, 100, 1000)).toBe(1000);
    expect(nextStreamFlushDelay(800, 900, 100, 1000)).toBe(1000);
  });

  it("recovers toward minMs when builds are cheap", () => {
    expect(nextStreamFlushDelay(1000, 10, 100, 1000)).toBe(500);
    expect(nextStreamFlushDelay(200, 5, 100, 1000)).toBe(100);
  });

  it("holds steady inside the hysteresis band", () => {
    expect(nextStreamFlushDelay(100, 30, 100, 1000)).toBe(100);
    expect(nextStreamFlushDelay(400, 100, 100, 1000)).toBe(400);
  });

  it("never goes below minMs", () => {
    expect(nextStreamFlushDelay(100, 0, 100, 1000)).toBe(100);
  });
});
