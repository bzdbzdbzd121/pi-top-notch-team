# 交付说明：并行任务下自动压缩的统一开始（批压缩屏障）

- 交付阶段：4/4（阶段 1 共享运行时 → 阶段 2 skipAutoCompact 标记 → 阶段 3 批预检屏障 → 阶段 4 本说明）
- 实现提交：`18fa8b8`（阶段 1）、`0d85643`（阶段 1 审查修复）、`3597c3c`（阶段 2）、`ffd32ed`（阶段 3）、`6f26c15`（阶段 3 审查修复）
- 需求来源：用户模型服务无 PD 分离，批量派发多 member 并行任务时，若某 member 需自动压缩，其他 member 不得提前开始，须等压缩完成后统一开始

---

## 1. 需求规格（形式化定义）

**统一开始（强一致）**：一次 `team_send_and_wait` 批内所有任务的 prompt，在**最后一个需要压缩的成员压缩完成之后**才发送——一个都不先跑。

**压缩串行**：同一批次内至多一个 compact RPC 并发（无 PD 分离下并发压缩 = 并发 prefill，正违背用户初衷）。

**范围边界**：
- 屏障只覆盖 `tasks[]` 显式目标成员；`to:"all"` 广播不属 batch 语义；
- 成员间消息、Inspector 直发消息不参与屏障（手动干预优先）；
- `tasks.length <= 1` 或 autoCompact 关闭时完全走旧路径（零预检）。

### P1 需求边界（防验收误判，明示）

**统一开始 ≠ 任务串行。** 压缩完成后，批内任务之间仍**并发执行**（各 Member 同时工作）——这是并行工作流的收益，不在本次需求内。屏障只保证"开始时机对齐"，不改变执行模型：耗时仍 ≈ 最慢的单任务，而非任务之和。

## 2. 实现行为核对（与实现逐条一致）

| 方案条目 | 实现行为（提交后最终态） |
|---|---|
| 屏障位置 | `sendAndWaitExecute` 内，corrId 注册与 enqueue **之前**（不变式 E1，测试锁定：压缩完成前 messageQueue 长度为 0） |
| 触发条件 | `tasks.length > 1` 且存在非 `all` 显式目标 且 DI 就绪（共享运行时/getAutoCompact/getHandle）且 `autoCompact.enabled`；否则完全原路径 |
| 成员分类 | `planBatchCompaction` 纯函数：idle→查 stats；compacting→待等集合（不重复发 compact）；working/crashed/stopped→跳过（消息走 followUp/未送达现有路径） |
| stats 预检 | 并行 `get_session_stats`（3s 超时，per-member fail-open=不压缩）；同成员多任务去重（只查一次） |
| 压缩执行 | 需压缩集合 S **串行**：`beginCompaction`（同步置位）→ `compactNow`（RPC，timeoutMinutes 超时）→ `endCompaction`（finally 复位） |
| 压缩失败 | per-member fail-open：失败者**带 skip** 随批统一派发 + 通知「成员 X 压缩失败/超时（原因），将随本批直接派发」；**其余成员继续串行压缩** |
| 批预算 | `batchMaxWaitMinutes`（默认 15 分钟，0=不限，`/team setting` 可调）：WAIT 与全部压缩共享总预算；超预算**停止未开始的压缩**（在飞 compact RPC 跑满自身 timeout 后停，属预期）→ 整批 enqueue 派发 + 通知 |
| 待等集合 | 轮询条件为**非 compacting**（idle/crashed/stopped 均放行——成员崩溃或 /team stop 后压缩已无意义，不得挂起到超时）；1s 轮询；等待开始即通知 |
| skip 规则 | `skipAutoCompact: true` **仅加给屏障中实际执行过压缩尝试的成员**（成功或失败均算，at most one per dispatch）；maxWait 中断未轮到者、非 S 成员不带（内联路径自然获得第二次机会）；非屏障路径（单任务/成员互发/Inspector 直发/backup 解析）永不产生带标记消息 |
| 孤儿消息防护 | 屏障压缩期间到达的消息进共享 pending（`queueDuringCompaction`）；屏障 `endCompaction` 只复位不 flush，由后续第一条到达该成员的消息（内联直发分支，含带标记消息）**先 drain pending（FIFO）再发自己**；内联路径 finally 保持 [当前消息 → 积压] 顺序 |
| 可见性 | 压缩开始前通知一次（成功静默哲学不变）；待等开始通知一次；单成员失败/超时通知一次；超预算通知一次 |
| 状态机 | 复用 `compacting` 状态（无新状态）；屏障期间无 wait 检测（wait 在 enqueue 后启动），all-idle 误释放不可能 |
| Esc/中断 | `endCompaction` 在 finally 中复位（成功/失败/中断均复位）；corrId 注册与 enqueue 严格在预检之后——promise 被丢弃无残留状态；promise 继续则压缩完成、消息照常派发（与现状"Esc 后成员后台运行"一致） |
| `to:"all"` | team_send_and_wait 的未知目标校验本就拒绝 `all`（非成员）；屏障只见显式目标（E13 文档化） |

## 3. 服务端 PD 分离建议（治本，供服务端团队参考）

本功能为**客户端治标**方案：把并发 prefill 从"压缩期"挪走，但不消除压缩本身产生的 prefill 压力。**治本**方向在服务端：

1. **PD 分离（prefill/decode 分离）**：prefill 与 decode 走独立资源池，压缩（纯 prefill 密集）不抢占生成（decode）吞吐——消除"并发压缩拖垮所有成员"的根因；
2. **Chunked prefill（分块 prefill）**：将长 prompt 的 prefill 分片调度、与 decode 交错，降低单次 prefill 尖峰；
3. 若服务端短期无法支持：可考虑**软 PD 分离**——扩展本屏障为"任意来源压缩互斥"（见 future work 全局压缩互斥），把客户端并发压到 1。

## 4. 限制声明

- **成员间消息触发的压缩不受屏障约束**：屏障只对齐一次 `team_send_and_wait` 的批内任务；成员在工作产出中互发消息触发的内联压缩仍可能与其他成员的 prefill 并发。若未来对**任意来源**的 prefill 并发都敏感，需全局压缩互斥（future work）。
- **在飞压缩的预算是自身 timeout**：maxWait 超预算只停止未开始的压缩；已开始的 compact RPC 跑满 `timeoutMinutes`（默认 10 分钟）后才结束，期间仍占用服务端 prefill。
- **压缩中进程崩溃的等待代价**：成员在屏障压缩中崩溃时，compact RPC 挂到超时才 reject，屏障等满该超时（首版接受；future work：监听 process_exit 提前释放）。
- **间隙竞态**：预检后、队列 drain 前成员状态变化（如 Inspector 直发使其 working）→ 消息走 followUp 排队，不丢消息、仅顺序变化（接受并文档化）。
- **批预算为整体上限**：多成员需压缩时总耗时 = Σ 各压缩时长（串行），预算内可全部完成；超预算的成员本轮不压缩，下轮派发时由内联路径兜底。

## 5. Future Work 清单

| 项目 | 背景 | 触发条件 |
|---|---|---|
| 全局压缩互斥 | 成员间消息触发的内联压缩不在屏障范围内；屏障只对齐批任务 | 用户对**任意来源** prefill 并发敏感（现场景仅抱怨批派发） |
| 压缩间隔冷却 | 防止高频率压缩（每轮派发都可能触发）浪费算力 | 观察到压缩频率过高/重复压缩 |
| process_exit 提前释放 | E7：压缩中崩溃要等 compact RPC 超时（默认 10 分钟） | 崩溃恢复体验优化 |
| 并行压缩开关 | 串行压缩写死常量（maxConcurrentCompactions=1） | 服务端获得 PD 分离后，并发压缩不再有害，可放行 |
| 主动预压缩 | 阈值下移/定时预压缩被否决（浪费算力） | 用户对派发延迟敏感且可接受后台预压缩成本 |
| `waiting` 新状态 | 屏障期成员状态显示 ⏳（现复用 compacting） | 未来改走"enqueue 后屏障"（通道层聚合）时才需要 |
| 增量同步（`syncParallelBatch`） | 当前预检开销 = 一次并行本地 stats RPC（无模型调用），无需逃生门 | 出现 stats 查询成为瓶颈的证据 |

## 6. 配置参考（`/team setting` → 自动压缩）

```
autoCompact:
  enabled: true            # 总开关（默认 true）
  thresholdPercent: 80     # 百分比阈值（默认 80，未配置时回退 80 并显示"默认"）
  thresholdTokens: null    # token 阈值（可选）
  timeoutMinutes: 10       # 单次 compact RPC 超时（≥1，默认 10）
  batchMaxWaitMinutes: 15  # 批屏障总预算（≥0 整数，0=不限，默认 15）
```

## 7. 验证摘要

- 全量 `npm test`：748 通过 / 2 失败（`src/index-shortcut.test.ts` 为存量问题，与本次功能无关，单独跟进）；`tsc --noEmit` 25 个错误 = 基线（0 新增）。
- 关键测试：`src/tools/tl-tools-batch-align.test.ts`（20 用例：调用序数组断言、串行压缩、不变式 E1、per-member fail-open、maxWait 超预算、待等/崩溃放行、去重、零预检、孤儿消息修复、非屏障路径无标记）；`src/channel/auto-compact.test.ts`（29 用例：运行时原语）；`src/channel/event-handler.test.ts`（skipAutoCompact 标记 + 直发 drain）。
- 已知存量 flaky：`src/ui/member-inspector.interaction.test.ts` 偶发失败（负载敏感型，单跑全过，与本次功能无逻辑关联）。
