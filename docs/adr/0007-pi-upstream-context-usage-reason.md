# ADR-0007: pi 上游 get_session_stats 上下文用量区分「压缩后未知」与「配置缺失」（reason 字段主推、估算值备选）

## 状态

建议稿（Draft）——供 TL 转交 pi 上游仓库（issue 形式）。**非阻塞**：本仓库扩展侧已通过 queryStats 三分判定（问题二 Phase 1）+ 显示层判空（Phase 2）消除用户可见症状，本 ADR 是针对框架侧**判别困境**（下游无法区分 null 的两种语义）的上游改进建议。

## 背景

### 上游契约现状（pi 0.84.2 dist 实读）

`agent-session.js` `getContextUsage()`（~2542 行）三段逻辑：

```js
getContextUsage() {
    const model = this.model;
    if (!model) return undefined;                          // ① 模型缺失
    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) return undefined;              // ① contextWindow 缺失
    // After compaction, the last assistant usage reflects pre-compaction context size.
    // We can only trust usage from an assistant that responded after the latest compaction.
    // If no such assistant exists, context token count is unknown until the next LLM response.
    const latestCompaction = getLatestCompactionEntry(branchEntries);
    if (latestCompaction) {
        // ... 检查压缩边界后是否存在有效 assistant usage
        if (!hasPostCompactionUsage) {
            return { tokens: null, contextWindow, percent: null };   // ② 压缩后未知（刻意）
        }
    }
    const estimate = estimateContextTokens(this.messages);  // ③ 估算数值
    ...
}
```

| 形态 | 语义 | 是否异常 |
|------|------|---------|
| `undefined` | 模型未选 / contextWindow 缺失（配置问题） | 真异常（配置） |
| `{ tokens: null, contextWindow, percent: null }` | **最新压缩成功后、首个有效 assistant 回复前**——压缩前 usage 反映压缩前大上下文、不可信，宁缺毋滥（上游注释："context token count is unknown until the next LLM response"） | **合法确定性状态** |
| `{ tokens, contextWindow, percent }` | 估算数值（estimateContextTokens：最后有效 usage + 逐条估算尾部） | 正常 |

压缩失败**不写** compaction 条目（`appendCompaction` 仅在成功路径，~1432 行）→ **null ⟺ 最近压缩成功且无后续有效回复**，绝非异常。null 窗口 = 压缩完成到首个有效 assistant 回复（stopReason 非 aborted/error 且 `calculateContextTokens(usage) > 0`）之间；少数提供商 usage 全零时窗口可能持续。

### 下游消费方的判别困境

`get_session_stats` 的 `contextUsage.percent` 在 RPC 层无类型标注，消费者只能靠 `typeof percent !== "number"` 区分失败。两种语义（配置缺失 undefined / 压缩后未知 null）在消费者侧产生**相反的合理动作**：

- **undefined（配置缺失）** → 查询确实失败，通知 TL 合理；
- **null（压缩后未知）** → 刚压缩完上下文必然低，应静默跳过——但消费者无法从响应结构区分，只能误报「无法查询成员上下文用量」或对 null 做脆弱的位置性猜测（如本项目 queryStats 的三分判定，靠 `=== null` 显式识别——但该判别依赖对上游实现细节的了解，上游注释变更即失效）。

本项目 Phase 1 的处理（percent:0 归一 + 防御性注释）已消除症状，但**判别负担压给了下游**：每个消费者都要复刻「null 是合法未知」的上游知识。上游若显式区分两种语义，全体消费者自动受益。

## 建议：`getContextUsage()` null 分支返回结构化 reason 字段

### 主推：reason 字段（一行成本）

```js
// agent-session.js getContextUsage() null 分支
if (!hasPostCompactionUsage) {
    return { tokens: null, contextWindow, percent: null, reason: "post-compaction" };
}
```

- 下游判别：`contextUsage.percent === null && contextUsage.reason === "post-compaction"` → 压缩后未知，静默跳过；`undefined` / 无 reason 的 null → 按配置缺失/异常处理。
- 成本：一行；`get_session_stats` RPC 响应原样透传（rpc-mode.js `get_state` 同源——`getContextUsage` 在 agent-session.js 层，RPC 层零改动）。
- 优点：**显式语义、全体消费者通用**（本项目 queryStats、显示层、任何第三方扩展）；不依赖下游对上游实现细节的推测；null 字段本身保持保守（不提供可能不准确的估算值）。
- 未来可扩展：其他 null 原因（如 `reason: "no-usage-provider"`）时直接枚举，无需消费者猜测。

### 备选：估算值（null 分支改用估算）

```js
if (!hasPostCompactionUsage) {
    const estimate = estimateContextTokens(this.messages);  // 已重建的压缩后消息
    return { tokens: estimate.tokens, contextWindow, percent: (estimate.tokens / contextWindow) * 100 };
}
```

- 可行性已验证：`estimateContextTokens(messages)`（dist/core/compaction/compaction.js:131）在无有效 usage 时**退化逐条估算**（`estimateTokens`，chars/4 启发式，含 thinking/toolCall/bashExecution/compactionSummary 各角色分支）——压缩后 messages 已被重建，估算的是压缩后真实上下文。
- 优点：下游零判别（永远有数值）；压缩后上下文估算误差对阈值决策可接受（summary + 保留窗口远低于阈值，误差不影响决策）。
- 阻力：与上游注释原则直接冲突——「We can only trust usage from an assistant that responded after the latest compaction」是**保守设计**（估算值不精确、宁可未知）；用估算替代需显式论证「估算用于阈值决策的误差可接受」，推进阻力大。

### 对比与建议

| 维度 | reason 字段（主推） | 估算值（备选） |
|------|--------------------|---------------|
| 成本 | 一行 | ~3 行 + 移除保守注释 |
| 语义清晰度 | 显式（下游不再猜） | 隐式（数值即真相，但失去「未知」信息） |
| 与上游保守原则冲突 | 无（null 保持） | 有（需论证误差可接受） |
| 消费者改动 | 判 reason | 零 |
| 通用性 | 全体消费者 | 全体消费者 |

**两者非互斥**：可同时提交上游裁决；若上游只采纳其一，本项目均可适配（reason → queryStats 三分改为判 reason；估算值 → 恢复原始单分支）。

## 本仓库扩展侧现状（已落地，不依赖本 ADR）

| 层 | 手段 | 效果 |
|----|------|------|
| queryStats 三分（Phase 1） | `percent === null` → `{ok:true, percent:0}` 静默跳过；undefined/异常 → fail-open 通知 | 压缩后窗口零噪音；真异常通知保留 |
| 通知诚实化（Phase 1） | stats 失败通知带真实原因 | 「无法查询」不再误导 |
| 显示层判空（Phase 2） | widget/inspector `percent === null` → "?"（原 `Math.round(null)===0` 显示 "0%"） | 状态栏/浮窗无 0% 误导 |
| 防御性注释 | queryStats/显示层注释写明上游契约与版本 | 防维护者误解与上游语义漂移 |

**上游合入后的演进空间**：queryStats 可改为判 `reason === "post-compaction"`（不再依赖 `percent === null` 的隐含知识）；若上游采用估算值，则恢复单分支直通（null 形态消失）。均属上游合入后的可选适配，非阻塞。

## 移交说明

本文档可直接作为 pi 上游 issue 的正文或附件。issue 标题建议：`getContextUsage() returns percent:null after compaction — consider a structured reason field (or an estimate) so consumers can distinguish 'post-compaction unknown' from 'no model/contextWindow'`。
