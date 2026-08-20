import { describe, it, expect } from "vitest";

// ── P1 阶段 1：Inspector 性能基准脚本（不入产品代码）────────
//
// 目标（见 /tmp/final-summary-rev-1787229361.md 阶段 1）：
//   ② 基准脚本：模拟 200/1500/3000 条历史 + 30KB CJK thinking
//      （80–120 列真实宽度），测 单次 flush / refetch 载荷 / 冷重建耗时；
//   ③ R3-A 附加 micro-benchmark（30KB CJK 增量拼接 + 每次 slice/startsWith
//      计时）→ 判定 V8 是否已 flatten ConsString（rope），据此决定 rope 项
//      永久关闭或追加专项。
//
// P2 阶段 2 复测（fit 增量 + 主题化行缓存 + 数组物化）：
//   同语料同宽度下对比「旧路径（全量 fit）」与「新路径（fitLinesIncremental
//   + 结构共享）」，验收目标：3000 条历史 + 思考开，单次 flush < 1ms。
//
// 运行方式（默认 npm test 整文件跳过，不污染常规测试）：
//   BENCH=1 npx vitest run src/test/bench/inspector-perf.bench.test.ts
//
// 基准数据落档：src/test/bench/inspector-perf-results.md（与 alpha 实测
// 12.3ms@3000 条等基线对照，见该文件）。

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildBodyLines,
  buildBodyLinesIncremental,
  createBodyBuildCache,
  fitLinesIncremental,
  fitLinesToWidth,
  IDENTITY_THEME,
  type BuildBodyOptions,
} from "../../ui/member-inspector-state";

const BENCH = process.env.BENCH === "1";

// ── Fixture generation ────────────────────────────────────

/** CJK sentence pool — realistic long-thinking content. */
const CJK_POOL = [
  "我们需要仔细分析这个函数的实现逻辑，考虑边界条件与异常处理路径，确保重构后的代码行为与原始版本完全一致。",
  "在性能优化过程中，必须同时关注时间复杂度与空间复杂度的平衡，避免为了微小的速度提升而牺牲代码的可读性与可维护性。",
  "团队成员应当遵循既定的编码规范，保持命名清晰、职责单一，并在关键决策处添加注释说明设计意图与权衡取舍。",
  "当处理大规模数据时，分批处理与惰性求值往往是更优的选择，能够有效控制内存峰值并提升整体响应速度。",
];

function cjkSentence(i: number): string {
  return CJK_POOL[i % CJK_POOL.length];
}

/**
 * Build a synthetic member history of `n` messages with a realistic mix:
 * user prompts (CJK), assistant text (CJK), thinking blocks (CJK), tool
 * calls and tool results. Thinking content totals roughly `thinkingChars`
 * (≈30KB of CJK when set to 10_000 — 3 bytes/char UTF-8).
 */
function buildHistory(n: number, thinkingChars: number): any[] {
  const msgs: any[] = [];
  const thinkingPerAssistant = Math.max(4, Math.floor(thinkingChars / Math.max(1, Math.floor(n / 3))));
  for (let i = 0; i < n; i++) {
    const role = i % 4;
    if (role === 0) {
      msgs.push({ role: "user", content: `请分析并优化模块 ${i}：${cjkSentence(i)}`, timestamp: i });
    } else if (role === 1) {
      const t = cjkSentence(i).repeat(Math.ceil(thinkingPerAssistant / cjkSentence(i).length));
      msgs.push({
        role: "assistant",
        content: [
          { type: "thinking", thinking: t.slice(0, thinkingPerAssistant) },
          { type: "text", text: `分析完成：${cjkSentence(i + 1)}` },
        ],
        timestamp: i,
      });
    } else if (role === 2) {
      msgs.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `tc-${i}`,
            name: "bash",
            arguments: { command: `grep -n "func${i}" src/index.ts` },
          },
        ],
        timestamp: i,
      });
    } else {
      msgs.push({
        role: "toolResult",
        toolCallId: `tc-${i - 1}`,
        toolName: "bash",
        content: [{ type: "text", text: `${i} 处匹配：${cjkSentence(i + 2).slice(0, 40)}` }],
        isError: false,
        timestamp: i,
      });
    }
  }
  return msgs;
}

/** Measure ms per call, warm-up runs excluded. */
function benchMs(fn: () => void, warmup = 2, runs = 5): number {
  for (let i = 0; i < warmup; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  return (performance.now() - t0) / runs;
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(1)}µs` : `${ms.toFixed(2)}ms`;
}

function fmtKB(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)}MB` : `${(bytes / 1024).toFixed(1)}KB`;
}

const THINKING_CHARS = 10_000; // ≈30KB CJK UTF-8

// ── ② 主基准：flush / refetch 载荷 / 冷重建 ────────────────

describe.runIf(BENCH)("P1 inspector perf bench (BENCH=1)", () => {
  it(
    "单次 flush / refetch 载荷 / 冷重建（200/1500/3000 条历史 + 30KB CJK thinking）",
    { timeout: 120_000 },
    () => {
      const widths = [80, 100, 120];
    const optsFor = (width: number): BuildBodyOptions => ({
      width: Math.max(20, width - 2),
      expanded: false,
      showThinking: true,
      theme: IDENTITY_THEME,
    });

    // ── alpha 基线对照（实测，见最终方案）──
    // per-flush 1.3/12.3/21.1ms @1500/3000/5000（fit 占 10.6/20.8ms）
    // refetch 0.63/1.26/2.09MB/次 @1500/3000/5000
    // 冷重建 136/191/386ms @1500/3000/5000
    console.log("\n=== P1 基准（本机实测，对照 alpha 基线）===");
    console.log("alpha 基线 @3000 条: flush 12.3ms / fit 10.6ms / refetch 1.26MB / 冷重建 191ms");
    console.log(
      "注: alpha 语料为通用混合；本脚本语料为 CJK 高密度（30KB thinking 全 CJK），" +
        "行数与 fit 成本更高，绝对值不可直接对齐——趋势与阶段 2 复测用同一语料对比。"
    );

    for (const width of widths) {
      console.log(`\n--- width ${width} ---`);
      for (const n of [200, 1500, 3000]) {
        const msgs = buildHistory(n, THINKING_CHARS);
        const opts = optsFor(width);

        // 行数（fit 扫描的对象）——语料密度锚点
        const lines = buildBodyLines(msgs, opts);

        // refetch 载荷（get_messages 响应 = JSON 序列化的消息数组）
        const payloadBytes = JSON.stringify({ data: { messages: msgs } }).length;

        // 冷重建：全量 build + fit（无增量缓存）
        const cold = benchMs(() => {
          const lines = buildBodyLines(msgs, opts);
          fitLinesToWidth(lines, width);
        });

        // 单次 flush（稳态）：增量 build（缓存已热，仅尾段新消息）+ fit
        const cache = createBodyBuildCache();
        const baseMsgs = msgs.slice(0, n - 3); // 已拉取历史（真实路径中已持有引用）
        buildBodyLinesIncremental(cache, baseMsgs, opts); // 预热缓存
        const liveTail = msgs.slice(n - 3); // 模拟 3 条新消息
        const flush = benchMs(() => {
          // 与真实 flushDirty 相同：历史 + 尾部一次 spread
          const lines = buildBodyLinesIncremental(cache, [...baseMsgs, ...liveTail], opts).lines;
          fitLinesToWidth(lines, width);
        });

        // fit 单独耗时（主导热点，阶段 2 将使其 O(Δ)）
        const fit = benchMs(() => fitLinesToWidth(lines, width));

        console.log(
          `n=${n} (${lines.length} 行): flush ${fmt(flush)} (fit ${fmt(fit)}) | refetch ${fmtKB(payloadBytes)} | 冷重建 ${fmt(cold)}`
        );
      }
    }

    // ── P2 复测：同语料下 fit 增量路径（阶段 2 主修复）──
    // 验收目标：3000 条历史 + 思考开，单次 flush < 1ms（P1 基线 ≈52–72ms）。
    console.log("\n=== P2 复测：fitLinesIncremental 增量 flush（同语料）===");
    for (const width of widths) {
      const opts = optsFor(width);
      const fitWidth = width;
      for (const n of [200, 1500, 3000]) {
        const msgs = buildHistory(n, THINKING_CHARS);
        const cache = createBodyBuildCache();
        const baseMsgs = msgs.slice(0, n - 3);
        const liveTail = msgs.slice(n - 3);
        // 预热：一次完整构建（冷路径，chunked 不在此测）
        buildBodyLinesIncremental(cache, baseMsgs, opts);
        fitLinesIncremental(cache, buildBodyLinesIncremental(cache, baseMsgs, opts), fitWidth);
        // 稳态增量 flush（新路径：只 fit 尾段 + 结构共享局部追加）
        const flushP2 = benchMs(() => {
          const raw = buildBodyLinesIncremental(cache, [...baseMsgs, ...liveTail], opts);
          fitLinesIncremental(cache, raw, fitWidth);
        });
        console.log(`n=${n}: P2 flush ${fmt(flushP2)}（P1 基线 flush 见上，目标 <1ms）`);
      }
    }
    expect(true).toBe(true); // 基准仅记录数据，不断言阈值（阶段 2 才设硬阈值）
  }
);
});

// ── ③ R3-A micro-benchmark：V8 ConsString（rope）flatten 判定 ──

describe.runIf(BENCH)("P1 R3-A rope micro-bench (BENCH=1)", () => {
  it("30KB CJK 增量拼接 + 每次 slice/startsWith 计时 → V8 flatten 结论", () => {
    const chunkCount = 100;
    const chunkChars = 100; // 100 × 100 CJK chars = 10K chars ≈ 30KB UTF-8（与方案口径一致）
    const chunk = cjkSentence(0).repeat(3).slice(0, chunkChars);

    // 模式 A：模拟 wrapAppendOnly 的访问形态——`acc += delta` 每次后
    // 立刻 startsWith(prev) + slice(prevLen)（每帧 flush 的守卫 + 增量提取）。
    // 若 V8 每次访问都重新 flatten 整个 ConsString，则总耗时为 O(T²)
    // （后半段每步显著变慢）；若 V8 已缓存 flatten 结果，则近似线性。
    const timeA = (() => {
      const phases: number[] = [];
      let acc = "";
      let prev = "";
      const t0 = performance.now();
      for (let i = 0; i < chunkCount; i++) {
        if (i === Math.floor(chunkCount / 3) || i === Math.floor((2 * chunkCount) / 3)) phases.push(performance.now() - t0);
        acc += chunk;
        if (!acc.startsWith(prev)) throw new Error("rope bench invariant");
        acc.slice(prev.length);
        prev = acc;
      }
      phases.push(performance.now() - t0);
      return { total: phases[2], third1: phases[0], third2: phases[1] - phases[0], third3: phases[2] - phases[1] };
    })();

    // 模式 B（对照组）：同样的拼接，但访问推迟到最后一次（flat 单次）。
    const timeB = (() => {
      let acc = "";
      const t0 = performance.now();
      for (let i = 0; i < chunkCount; i++) acc += chunk;
      acc.startsWith(chunk);
      return performance.now() - t0;
    })();

    // 模式 C（对照组）：数组 push + join，无 rope。
    const timeC = (() => {
      const parts: string[] = [];
      const t0 = performance.now();
      for (let i = 0; i < chunkCount; i++) parts.push(chunk);
      const s = parts.join("");
      if (!s.startsWith(chunk)) throw new Error("rope bench invariant");
      return performance.now() - t0;
    })();

    console.log("\n=== R3-A rope micro-bench（100 × 100 CJK chars ≈ 30KB）===");
    console.log(`A 每次访问(模拟 wrapAppendOnly): 总 ${fmt(timeA.total)} | 三段 ${fmt(timeA.third1)}/${fmt(timeA.third2)}/${fmt(timeA.third3)}`);
    console.log(`B 仅末尾访问(对照组):           ${fmt(timeB)}`);
    console.log(`C 数组 push+join(对照组):       ${fmt(timeC)}`);
    const thirdScale = timeA.third3 / Math.max(0.001, timeA.third1);
    console.log(`\n第三段/第一段耗时比: ${thirdScale.toFixed(2)}x`);
    if (thirdScale < 3 && timeA.total < timeB.total * 4) {
      console.log("结论: 每步访问未随长度显著变慢 → V8 对 ConsString flatten 已有效处理 → rope 项【永久关闭】");
    } else {
      console.log("结论: 每步访问随长度显著变慢（O(T²) 特征）→ rope 项【追加专项】（阶段 2 后基准驱动）");
    }
    expect(true).toBe(true);
  });
});
