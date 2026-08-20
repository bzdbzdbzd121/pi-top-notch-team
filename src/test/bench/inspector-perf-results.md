# Inspector 性能基准落档（P1 阶段 1，rev-1787229361 方案）

- 日期：2026-08-20（修订版方案实施时）
- 脚本：`src/test/bench/inspector-perf.bench.test.ts`（`BENCH=1 npx vitest run ...` 运行）
- 环境：本机（与 alpha 实测同环境口径尽量对齐，但语料不同，见注）

## 结论摘要

1. **fit 主导热点复测成立**：3000 条 CJK 高密度历史（≈9750 显示行）下，单次 flush ≈ 53–72ms，其中 `fitLinesToWidth` 单独 ≈ 52–66ms（占 90%+）——与 alpha「fit 占 85–98%」的结论一致，阶段 2 的 fit 增量改造方向被再次证实。
2. **ASCII 快路径（阶段 1 交付）**：已合入 `fitLinesToWidth`（纯 ASCII 行直接取 `length`，跳过 `visibleWidth` 调用与 widthCache 查找）。三套 byte-identical 测试全绿；新增「快路径输出 == 慢路径输出」等价性测试（混合语料 × 6 宽度）与「纯 ASCII 零调用 visibleWidth」路由测试。
3. **R3-A（V8 rope）判定：追加专项**。30KB CJK 增量拼接 + 每步 slice/startsWith（模拟 wrapAppendOnly 访问形态）：
   - 模式 A（每步访问）：总 303.5µs，三段 50.8 / 94.0 / 158.7µs——**每步成本随累计长度增长（O(T²) 特征，第三段/第一段 3.1×）**；
   - 模式 B（仅末尾访问）：5.8µs；模式 C（数组 push+join）：7.7µs（前一轮实测）——访问推迟后几乎零成本。
   - 结论：V8 对 `acc += delta` 后立即 `startsWith/slice` 的形态**每次重新 flatten ConsString**，未缓存。当前 `wrapAppendOnly` 的守卫（`text.startsWith(e.text)` + `text.slice(e.text.length)`）在长流（30KB+）下存在 O(T²) 隐患 → rope 项**追加专项**（阶段 2 完成后按基准驱动评估是否落地）。

## 主基准数据（本机实测，最终一轮）

语料：CJK 高密度（user/assistant/thinking 全 CJK，thinking 合计 ≈30KB UTF-8 = 10K CJK 字符），`showThinking: true`，IDENTITY_THEME。

| n（消息数） | 显示行数 | width | 单次 flush | fit 单独 | refetch 载荷 | 冷重建 |
|---|---|---|---|---|---|---|
| 200 | 849 | 80 | 437.6µs | 48.1µs | 37.0KB | 4.85ms |
| 200 | 799 | 100 | 81.0µs | 46.6µs | 37.0KB | 4.31ms |
| 200 | 699 | 120 | 49.2µs | 43.4µs | 37.0KB | 3.37ms |
| 1500 | 4874 | 80 | 26.82ms | 25.82ms | 232.0KB | 68.77ms |
| 1500 | 4874 | 100 | 30.25ms | 29.17ms | 232.0KB | 68.37ms |
| 1500 | 4499 | 120 | 32.00ms | 33.21ms | 232.0KB | 71.29ms |
| 3000 | 9749 | 80 | 53.36ms | 52.64ms | 459.0KB | 132.54ms |
| 3000 | 9749 | 100 | 65.64ms | 61.27ms | 459.0KB | 145.36ms |
| 3000 | 8999 | 120 | 72.02ms | 66.47ms | 459.0KB | 136.41ms |

> 注：alpha 基线（1500/3000/5000 条：flush 1.3/12.3/21.1ms、fit 10.6/20.8ms、refetch 0.63/1.26/2.09MB、冷重建 136/191/386ms）使用通用混合语料；本脚本为 CJK 高密度语料（行数更多、fit 成本更高），**绝对值不可直接对齐**。用途：阶段 2 复测用**同一脚本同一语料**对比（自比），alpha 数据仅作量级参照。阶段 2 验收目标（3000 条 + 思考开）：单次 flush < 1ms（基线 ≈ 53–72ms）。

## 运行方式

```bash
BENCH=1 npx vitest run src/test/bench/inspector-perf.bench.test.ts
```

默认 `npm test` 下整文件跳过（`describe.runIf(process.env.BENCH === "1")`），不污染常规测试。
