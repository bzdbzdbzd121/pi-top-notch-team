import { describe, it, expect } from "vitest";

import {
  buildBodyLines,
  buildBodyLinesIncremental,
  createBodyBuildCache,
  fitLinesIncremental,
  fitLinesToWidth,
  IDENTITY_THEME,
  type BodyBuildCache,
  type BuildBodyOptions,
} from "./member-inspector-state";

// ── P2: fit 增量（BodyBuildCache.fitLines）+ 结构共享 ──────
//
// Contract (final summary Phase 2 ①):
//   - BodyBuildCache 缓存「已定宽前缀」（fitLines）；增量刷新只 fit 新尾段，
//     拼接缓存前缀 → 每帧 fit 成本 O(total)→O(tail)。
//   - 字节一致性守卫：任意时刻 fitLinesIncremental 结果 ==
//     fitLinesToWidth(buildBodyLines(messages, opts))（同一 fitWidth）。
//   - 结构共享（③）：增量路径下 cache.fitLines 数组引用恒常（原地 push /
//     truncate，无 concat 全量拷贝）；setTabLines 语义改局部追加。
//   - 缓存失效：fitWidth 变化 / full 模式 → 全量 refit；opts 签名变化由
//     buildBodyLinesIncremental 的 full 回退承载。

const W = 80;
const FIT_W = 78; // fit width 与 body width 可不同（lastWidth-2 vs lastWidth-4）

const mkOpts = (over: Partial<BuildBodyOptions> = {}): BuildBodyOptions => ({
  width: W,
  expanded: false,
  theme: IDENTITY_THEME,
  ...over,
});

function userMsg(text: string) {
  return { role: "user", content: text };
}
function textBlock(text: string) {
  return { type: "text", text };
}
function thinkingBlock(text: string) {
  return { type: "thinking", thinking: text };
}
function assistantMsg(blocks: any[]) {
  return { role: "assistant", content: blocks };
}

const CORPUS: any[] = [
  userMsg("你好，请分析这个项目的结构"),
  assistantMsg([textBlock("我来分析一下。这是一个多成员协作系统，核心模块包括消息通道与进程管理。")]),
  assistantMsg([thinkingBlock("让我先梳理一下依赖关系"), textBlock("结论：架构分层清晰。" + "详细说明".repeat(30))]),
  userMsg("emoji 混合文本 👍👨👩👧👦 和中文，还有超长文本" + "x".repeat(300) + "结尾"),
];

/** 断言 fit 增量结果与全量 fit 字节一致，且模式正确。 */
function expectFitSameAsFull(
  cache: BodyBuildCache,
  messages: any[],
  opts: BuildBodyOptions,
  mode: "full" | "incremental"
): ReturnType<typeof fitLinesIncremental> {
  const raw = buildBodyLinesIncremental(cache, messages, opts);
  expect(raw.mode).toBe(mode);
  const fitted = fitLinesIncremental(cache, raw, FIT_W);
  expect(fitted.mode).toBe(mode);
  expect(fitted.lines).toEqual(fitLinesToWidth(buildBodyLines(messages, opts), FIT_W));
  return fitted;
}

describe("P2 fit 增量（fitLinesIncremental）", () => {
  it("首次构建 full：fitLines 与全量 fit 字节一致", () => {
    const cache = createBodyBuildCache();
    expectFitSameAsFull(cache, CORPUS, mkOpts(), "full");
  });

  it("追加消息 → incremental，字节一致，且只 fit 新尾段", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs: any[] = [];
    for (let i = 0; i < CORPUS.length; i++) {
      msgs.push(CORPUS[i]);
      expectFitSameAsFull(cache, msgs, opts, i < 2 ? "full" : "incremental");
    }
  });

  it("流式尾部增长（同一 block 文本追加）→ incremental，字节一致", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts({ showThinking: true });
    const live: any = { role: "assistant", content: [thinkingBlock("")] };
    const msgs: any[] = [userMsg("开始"), live];
    expectFitSameAsFull(cache, msgs, opts, "full");
    for (const d of ["第一步思考 ", "第二步更深入的分析，包含一些细节 ", "第三步\n换行后的结论"]) {
      live.content[0].thinking += d;
      expectFitSameAsFull(cache, msgs, opts, "incremental");
    }
  });

  it("count 收缩 / 边界指纹不连续 → full 回退，字节一致", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectFitSameAsFull(cache, CORPUS.slice(0, 3), opts, "full");
    expectFitSameAsFull(cache, CORPUS.slice(0, 2), opts, "full");
    // 收缩后边界前移（seenCount=1 → 边界为 messages[0]），重写边界消息 → full
    const rewritten = CORPUS.map((m, i) =>
      i === 0 ? { ...m, content: [{ ...m.content[0], text: "被压缩改写的内容" }] } : m
    );
    expectFitSameAsFull(cache, rewritten.slice(0, 2), opts, "full");
  });

  it("fitWidth 变化 → 全量 refit（即使 raw 可增量），随后以新宽度增量", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectFitSameAsFull(cache, CORPUS.slice(0, 3), opts, "full");
    // 同 raw 增量，但 fitWidth 变了 → fit 必须 full refit
    const raw = buildBodyLinesIncremental(cache, [...CORPUS.slice(0, 3), userMsg("第四条")], opts);
    expect(raw.mode).toBe("incremental");
    const fitted = fitLinesIncremental(cache, raw, 120);
    expect(fitted.mode).toBe("full");
    expect(fitted.lines).toEqual(
      fitLinesToWidth(buildBodyLines([...CORPUS.slice(0, 3), userMsg("第四条")], opts), 120)
    );
    // 之后以新 fitWidth（120）增量
    const more = [...CORPUS.slice(0, 3), userMsg("第四条"), userMsg("第五条")];
    const raw2 = buildBodyLinesIncremental(cache, more, opts);
    expect(raw2.mode).toBe("incremental");
    const fitted2 = fitLinesIncremental(cache, raw2, 120);
    expect(fitted2.mode).toBe("incremental");
    expect(fitted2.lines).toEqual(fitLinesToWidth(buildBodyLines(more, opts), 120));
  });

  it("结构共享：incremental 期间 cache.fitLines 数组引用恒常（无全量 concat）", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts({ showThinking: true });
    const live: any = { role: "assistant", content: [thinkingBlock("")] };
    const msgs: any[] = [userMsg("开始"), live];
    expectFitSameAsFull(cache, msgs, opts, "full");
    const refBefore = cache.fitLines;
    for (const d of ["增量一 ", "增量二，继续增长 ", "增量三，收尾"]) {
      live.content[0].thinking += d;
      expectFitSameAsFull(cache, msgs, opts, "incremental");
      expect(cache.fitLines).toBe(refBefore); // 同一数组对象，原地更新
    }
  });

  it("结构共享：新增行 = 本次尾段行（added 长度与内容正确）", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectFitSameAsFull(cache, CORPUS.slice(0, 3), opts, "full");
    const prevLen = cache.fitLines.length;
    const prevTailLen = cache.fitTailLen;
    const more = [...CORPUS.slice(0, 3), userMsg("新消息"), assistantMsg([textBlock("新回答")])];
    const raw = buildBodyLinesIncremental(cache, more, opts);
    const fitted = fitLinesIncremental(cache, raw, FIT_W);
    expect(raw.mode).toBe("incremental");
    // added = 本次新增的已 fit 行（grown + tail）；fitLines 净增长 =
    // added - 被替换的旧 tail 段
    expect(fitted.added).toEqual(fitLinesToWidth(raw.added, FIT_W));
    expect(fitted.lines.length - prevLen).toBe(fitted.added.length - prevTailLen);
    // 结构共享：同一数组对象，仅尾部区段更新
    expect(cache.fitLines).toBe(fitted.lines);
  });

  it("空追加（同内容重复）→ incremental，added 为空，字节一致", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectFitSameAsFull(cache, CORPUS.slice(0, 3), opts, "full");
    const before = cache.fitLines.length;
    const fitted = expectFitSameAsFull(cache, CORPUS.slice(0, 3), opts, "incremental");
    // 同一内容重复构建：增量路径重放尾段，但字节一致且无净增长
    expect(cache.fitLines.length).toBe(before);
    expect(fitted.changed).toBe(false);
  });

  it("④ tail 收缩（尾部内容变短）→ changed=false，不触发「↓ 有更新」闪现", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const long: any[] = [userMsg("开始"), assistantMsg([textBlock("第一行\n第二行\n第三行\n第四行\n第五行")])];
    expectFitSameAsFull(cache, long, opts, "full");
    const grown = expectFitSameAsFull(cache, long, opts, "incremental");
    expect(grown.changed).toBe(false); // 同内容重复
    // 尾部消息被更短的版本替换（如消息最终落定后只保留摘要）
    long[1].content[0].text = "短";
    const shrunk = expectFitSameAsFull(cache, long, opts, "incremental");
    expect(shrunk.changed).toBe(false); // 收缩不是新增内容，不得闪现
  });

  it("fitWidth <= 0 退化：fitLines 原样返回（与 fitLinesToWidth 一致）", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const raw = buildBodyLinesIncremental(cache, CORPUS, opts);
    const fitted = fitLinesIncremental(cache, raw, 0);
    expect(fitted.lines).toEqual(buildBodyLines(CORPUS, opts));
  });
});
