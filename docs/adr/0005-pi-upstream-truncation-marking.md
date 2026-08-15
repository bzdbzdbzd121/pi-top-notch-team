# ADR-0005: pi 上游框架侧截断打标建议（partial-json finalize 检测 + length 保护扩展 + oneOf 消噪）

## 状态

建议稿（Draft）——供 TL 转交 pi 上游仓库（issue 形式）。**非阻塞**：本仓库扩展侧已通过 P1-P3（schema 放宽 + prepareArguments 规范化 + 防截断提示词）消除用户可见症状，本 ADR 是针对框架侧**根因**（截断静默化）的上游改进建议。

## 背景

### 根因链（本仓库实测复现）

```
TL 长 content 流式生成 tool_call 参数
  → 输出在 content 字符串内部被截断（to 的字节从未发出）
  → 框架 parseStreamingJson / partial-json 静默补全（缺字段无标记，注释自认
    "Always returns a valid object, even if the JSON is incomplete"）
  → validateToolArguments（agent-loop prepareToolCall 内）在 execute 与扩展
    钩子之前短路（TypeBox oneOf 硬校验）
  → 框架错误文本误导（"tasks: must be string" 与提示词"必须传数组"字面矛盾）
  → TL 原样重试 → 再截断 → 再失败（死循环）
```

三方独立分析一致确认：**"TL 声称传了 to" 是真实但失真**——模型生成意图中 `to` 位于 `content` 之后（或部分场景 content 极长），截断发生在 content 内部，`to` 字节从未发出；partial 修复后 content 补全闭合、`to` 缺失。TL 不知道自己被截断。

### 现有 length 保护缺口

`failToolCallsFromTruncatedMessage` 仅当 `stopReason === "length"` 时触发。以下场景**零保护**：

- provider 返回 `stop`（自认为完成但输出被网关/后处理截断）
- 同批多 tool call 挤占输出预算（TL 单回合连发 start_member + team_send_and_wait 时，第二个 tool call 被截断——解释"经常失败"是模式化重复而非随机）
- 中间件/代理层静默截断

### 截断 vs 模型漏生成的不可区分性

从落盘参数**无法区分**"截断"与"模型漏生成"——两条路径的修复手段相同（宽容处理 + 截断语义提示）。上游打标的意义不在于区分二者，而在于**让截断不再以误导性框架错误形式出现**，并让模型收到可行动的反馈（"精简后重发"）而不是矛盾的 schema 报错。

## 建议一：parseStreamingJson finalize 时刻截断打标

### 触发条件（D7 裁决：检测必须限定流结束时刻）

在流式 tool call 参数**拼接完成的 finalize 时刻**（不是每个增量到达时），检测：

- 原始串尾字符未闭合（以缺 `}`/`]`/引号结尾），**或**
- 最终 parse 走了 partial 修复路径（partial-json 承认补全过）

命中任一条件 → 对该 tool call 打 `_truncated` 标记。

### finalize 时机约束的实证论据（中间态误杀演示）

**检测绝不能在增量中间态进行**。正常流式 tool call 的增量中间态几乎必然 strict parse 失败：

```
增量 1: {"tasks": [{"to": "analyzer"
增量 2: {"tasks": [{"to": "analyzer", "content": "分析"
增量 3: {"tasks": [{"to": "analyzer", "content": "分析这段代码"}], "nextSteps": "x"}
```

增量 1、2 都 strict parse 失败——若"任何时刻失败过即打标"，**几乎所有正常调用都会被误杀**，每轮 tool call 都带冗余重发。只有 finalize 时刻（流结束、完整串在手）的未闭合检测才有意义：正常调用的最终串是闭合的，截断调用的最终串缺尾字符。

### 标记语义

`_truncated` 是**诊断元数据**，不下发模型（不改变 tool call 内容）；agent-loop 消费。

## 建议二：agent-loop 对带标记 tool call 走 length 同款 fail 路径

带 `_truncated` 标记的 tool call 进入 `failToolCallsFromTruncatedMessage` 同款路径（与 `stopReason === "length"` 并列），但文案区分：

- length 场景：现有文案（输出达到 max tokens）
- 截断场景：`参数疑似在输出传输中被截断，请精简后重发。`

失败信息中给出可行动指引（精简 content / 拆分调用），避免模型按矛盾的 schema 报错向错误方向"修复"（double-encoding）。

## 建议三：TypeBox oneOf 错误消噪

当 oneOf 校验失败时，`Errors()` 会输出**所有分支**的深层错误。对 `tasks` 这类多分支字段，错误文本是：

```
- tasks.0.to: must have required properties to
- tasks: must be string
- tasks: must match exactly one schema in oneOf
```

问题：

1. `must be string` 与提示词"必须传原始数组"**字面矛盾**——模型被诱导向错误方向修正（double-encoding）
2. 汇总行无信息量
3. 真实原因（`tasks.0.to` 缺失）埋在三行中间

建议：`Errors()` 跳过**与值类型不匹配分支**的深层错误（例如值不是字符串时，不输出 string 分支的内部错误；值不是数组时，不输出 array 分支的 items 深层错误），只保留类型匹配分支的深层错误 + 顶层汇总。

## 复现样例

### 用户场景（本仓库实测）

```
调用：team_send_and_wait({tasks: [{content: "<600+ 字符的长任务>"}], nextSteps: "..."})
失败：- tasks.0.to: must have required properties to
      - tasks: must be string
      - tasks: must match exactly one schema in oneOf
Received arguments 中 tasks[0] 仅含 content，缺 to 字段
```

### 本地复现步骤

1. 流式生成一个 tool_call，`content` 字段内包含超长文本（>输出预算），`to` 键位于 content 之后
2. 观察输出在 content 内部被截断
3. 观察框架侧：partial-json 补全 content 闭合 → 校验失败错误文本如上
4. 扩展侧（已修复后的现状）：P1 schema 放宽放行 → execute 丢弃条目 + 逐条"疑似截断"提示；P2 prepareArguments 提前规范化；P3 提示词降低截断概率

## 本仓库扩展侧现状（P1-P3，已落地）

| 层 | 手段 | 效果 |
|----|------|------|
| P1 | schema 放宽（items `{}` + object 分支）+ execute 截断语义提示（丢弃逐条化 / 0 任务启发式 / 未知成员截半检测） | 截断形态不再出现 TypeBox 三行框架错误；提示携带截断语义 |
| P2 | prepareArguments 校验前规范化（string 解码 / 单对象包裹 / 放行契约） | 确定性形态在校验前转正，execute 兜底面最小化 |
| P3 | promptGuidelines 防截断协议（800 字拆分 / 先 to 后 content / 1-2 个 tool call / 短重试 / 未知成员疑截断） | 从源头降低截断概率 |

**上游打标落地后的演进空间**：框架层可在截断发生时直接 fail 并给出可行动文案（建议二），届时扩展侧可评估恢复严格 schema（截断形态由框架识别，不再需要 P1 的宽容处理）——见本 ADR 背景中"未采纳 β C1（schema 极简 `{}`）"的潜在适用场景说明。

## 移交说明

本文档可直接作为 pi 上游 issue 的正文或附件。issue 标题建议：`Tool call args truncated mid-string are silently "repaired" by partial-json → misleading oneOf validation errors (proposal: finalize-time _truncated marking)`。
