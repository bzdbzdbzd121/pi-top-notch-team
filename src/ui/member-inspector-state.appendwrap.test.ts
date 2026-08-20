import { describe, it, expect } from "vitest";
import {
  wrapAppendOnly,
  wrapAppendOnlyThemed,
  wrapText,
  nextStreamFlushDelay,
  buildBodyLines,
  clearAppendWrapCache,
  IDENTITY_THEME,
  type InspectorTheme,
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

  it("R3-A rope guard: growth feeds only the delta, no per-flush full-text scan", () => {
    // P2-⑥ (R3-A): the old guard did text.startsWith(e.text) every flush,
    // flattening the growing ConsString → O(T²) over a stream. The rope-safe
    // guard samples a bounded prefix (char-index access navigates the rope
    // without flattening). Same append-only corpus must stay byte-identical
    // AND the accumulated cost must stay far below a full rewrap.
    const block = { type: "thinking", thinking: "" };
    const delta = "我们需要仔细分析这个函数的实现逻辑，考虑边界条件与异常处理路径，确保重构后的代码行为与原始版本完全一致。";
    let text = "";
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      text += delta;
      expect(wrapAppendOnly(block, text, 100)).toEqual(wrapText(text, 100));
    }
    const inc = performance.now() - t0;
    // 200 × ~60-char CJK deltas ≈ 12K chars: the guard must not scan the
    // whole accumulated text per flush (that would flatten the ConsString
    // every call). Keep a generous ceiling — the point is byte-identity +
    // no pathological blowup, not a tight timing bound.
    expect(inc).toBeLessThan(2000);
    // Sanity: the corpus is large enough that a per-flush full scan would
    // visibly exceed the sampled guard (assert relative, not absolute).
    const fullStart = performance.now();
    wrapText(text, 100);
    const oneFull = performance.now() - fullStart;
    expect(inc / 200).toBeLessThan(oneFull * 4);
  });

  it("same-length rewrite still resets (full compare on the rare path)", () => {
    const block = { type: "thinking", thinking: "" };
    wrapAppendOnly(block, "abcdef", 40);
    // Same length, different content → must rebuild, not serve stale cache.
    expect(wrapAppendOnly(block, "abcyzz", 40)).toEqual(wrapText("abcyzz", 40));
    // …and the rebuilt state continues to grow append-only afterwards.
    expect(wrapAppendOnly(block, "abcyzz追加", 40)).toEqual(wrapText("abcyzz追加", 40));
  });

  it("growth with a rewritten prefix (beyond sample window) is documented trade-off: same-prefix growth stays cached", () => {
    const block = { type: "thinking", thinking: "" };
    wrapAppendOnly(block, "前缀内容", 40);
    // Same prefix + growth → append-only path (no rebuild).
    expect(wrapAppendOnly(block, "前缀内容追加", 40)).toEqual(wrapText("前缀内容追加", 40));
  });

  it("R3-A 失效窗口锁定：增长且 32 字符采样前缀相同、其后被重写 → 不重建（文档化权衡）", () => {
    const block = { type: "thinking", thinking: "" };
    const prefix = "A".repeat(32); // 采样窗口 = 前 32 字符
    wrapAppendOnly(block, prefix + "旧尾部内容", 100);
    // 增长 + 前 32 字符相同、32 字符之后被重写：采样守卫判定为追加，不重建。
    const t2 = prefix + "新尾部内容，完全不同";
    const out = wrapAppendOnly(block, t2, 100);
    // 失效窗口锁定：输出 ≠ 全量重排（旧尾部残留 + 新尾部追加合并）。
    expect(out).not.toEqual(wrapText(t2, 100));
    expect(out.join("")).toContain("旧尾部内容"); // 旧尾部残留在行内（未被重排）
  });

  it("R3-A 采样窗口内重写（前 32 字符被改写）→ 重建，字节一致", () => {
    const block = { type: "thinking", thinking: "" };
    wrapAppendOnly(block, "A".repeat(32) + "旧尾部", 100);
    const t2 = "B".repeat(32) + "新尾部，更长一些";
    // 增长 + 采样窗口内前缀被改写 → 采样守卫检测到 → 重建 → 字节一致。
    expect(wrapAppendOnly(block, t2, 100)).toEqual(wrapText(t2, 100));
  });
});

describe("wrapAppendOnlyThemed (P2-② block 级主题化行缓存)", () => {
  it("themed lines equal manual theme.fg per line (byte-identical)", () => {
    const block = { type: "thinking", thinking: "" };
    const text = "第一段思考内容\n第二段更长更详细的内容，包含中英文 mixed content，以及一些边界情况说明。";
    const w = wrapAppendOnlyThemed(block, text, 30, IDENTITY_THEME, "dim", "    ");
    const manual = wrapAppendOnly(block, text, 30).map((l) => IDENTITY_THEME.fg("dim", `    ${l}`));
    expect([...w.lines, w.cur]).toEqual(manual);
    expect(w.cur).toBe(manual[manual.length - 1]);
  });

  it("streaming growth themes only the delta (added), old lines cached", () => {
    const block = { type: "thinking", thinking: "" };
    let text = "第一步 ";
    const w1 = wrapAppendOnlyThemed(block, text, 30, IDENTITY_THEME, "dim", "    ");
    const added1 = w1.added.length;
    expect(added1).toBe(w1.lines.length); // first call themes everything

    text += "第二步的增量内容，足以换行并产生新的 wrapped lines。";
    const w2 = wrapAppendOnlyThemed(block, text, 30, IDENTITY_THEME, "dim", "    ");
    // Byte-identical to re-theming everything from scratch.
    const manual = wrapAppendOnly(block, text, 30).map((l) => IDENTITY_THEME.fg("dim", `    ${l}`));
    expect([...w2.lines, w2.cur]).toEqual([...manual]);
    // Only the delta was themed this call.
    expect(w2.added.length).toBeGreaterThan(0);
    expect(w2.added.length).toBeLessThanOrEqual(manual.length - added1 + 1);
    // The lines array is STABLE (same reference across calls — no full spread).
    expect(w2.lines).toBe(w1.lines);
  });

  it("theming config change (color/indent) re-themes all lines", () => {
    const block = { type: "thinking", thinking: "" };
    wrapAppendOnlyThemed(block, "内容", 40, IDENTITY_THEME, "dim", "    ");
    const w = wrapAppendOnlyThemed(block, "内容", 40, IDENTITY_THEME, "accent", "  ");
    const manual = wrapAppendOnly(block, "内容", 40).map((l) => IDENTITY_THEME.fg("accent", `  ${l}`));
    expect([...w.lines, w.cur]).toEqual([...manual]);
  });

  it("width change rebuilds both wrap state and themed cache", () => {
    const block = { type: "thinking", thinking: "" };
    const text = "中文换行测试内容，用于宽度变化后的重新换行与重新主题化。";
    const w1 = wrapAppendOnlyThemed(block, text, 20, IDENTITY_THEME, "dim", "    ");
    const w2 = wrapAppendOnlyThemed(block, text, 30, IDENTITY_THEME, "dim", "    ");
    expect([...w2.lines, w2.cur]).toEqual(
      wrapText(text, 30).map((l) => IDENTITY_THEME.fg("dim", `    ${l}`))
    );
    expect(w2.lines).not.toBe(w1.lines);
  });

  it("主题切换（clearAppendWrapCache）：同 block 全部行使用新主题，无旧主题残留", () => {
    // P2-② 审查必改：themeKey 只含 (color, indent)，不含主题函数身份；
    // 主题切换（同宽度）后全量重建时，存活的流式 block 若命中 warm entry
    // 会残留旧主题色。clearAppendWrapCache() 是 invalidate() 的清理路径。
    const block = { type: "thinking", thinking: "" };
    const themeA: InspectorTheme = { fg: (_c, t) => `«A»${t}«/A»` };
    const themeB: InspectorTheme = { fg: (_c, t) => `«B»${t}«/B»` };
    const text = "第一段思考内容\n第二段更长更详细的内容，包含中英文 mixed content。";
    const w1 = wrapAppendOnlyThemed(block, text, 30, themeA, "dim", "    ");
    expect([...w1.lines, w1.cur].join("")).toContain("«A»");
    // 主题切换：invalidate() 调用 clearAppendWrapCache() 清空全部 wrap 缓存
    clearAppendWrapCache();
    const w2 = wrapAppendOnlyThemed(block, text, 30, themeB, "dim", "    ");
    const all = [...w2.lines, w2.cur].join("");
    expect(all).toContain("«B»");
    expect(all).not.toContain("«A»"); // 无旧主题残留（混合主题 bug 锁定）
    // 且与全新 block 手动全量主题化字节一致
    const manual = wrapAppendOnly(
      { type: "thinking", thinking: "" },
      text,
      30
    ).map((l) => themeB.fg("dim", `    ${l}`));
    expect([...w2.lines, w2.cur]).toEqual(manual);
  });

  it("buildBodyLines over a mutating live thinking block stays byte-identical with theming", () => {
    const live: any = { role: "assistant", content: [{ type: "thinking", thinking: "" }] };
    const opts = { width: 60, expanded: false, showThinking: true, theme: IDENTITY_THEME };
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
