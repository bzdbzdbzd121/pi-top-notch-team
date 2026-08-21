# ADR-0006: pi 上游暴露 `abort_compaction` RPC 提案（压缩永不结束场景的真正取消武器）

## 状态

建议稿（Draft）——供 TL 转交 pi 上游仓库（issue 形式）。**非阻塞**：本仓库扩展侧已通过 Phase 1/2 三出口闭合（compaction_end 心跳 flush / waitCompactionIdle 轮询兜底 / 二次超时放弃+通知）将「压缩永不结束」场景兜住——本 ADR 是针对该场景**主动取消能力**（而非等待或放弃）的上游改进建议。依赖上游合入，不阻塞本项目任何阶段。

## 背景

### 场景

成员（`pi --mode rpc` 子进程）触发自动压缩后，压缩可能长时间不结束（大上下文 summarization 卡顿、上游模型慢等）。本仓库 Phase 2 的三出口闭合处理方式：

1. **compaction_end 心跳**（正常结束 → flush 积压消息，主路径）；
2. **waitCompactionIdle 轮询**（事件丢失/auto-restart，30s 间隔 + 二次超时预算）；
3. **二次超时放弃**（预算耗尽 → resolve corrId + 通知 TL 人工干预）。

出口 3 的通知引导为 `stop_member` 或 `/team stop` 后 `/team resume`——即**当前唯一主动取消手段是杀进程**（进程退出兜底清 pending）。杀进程代价：压缩中写盘可能留半条 jsonl、`--continue` 恢复可能失败、isCrashLoop 退避延迟恢复（未采纳 beta B 的 SIGTERM 变体，风险/收益倒挂）。**上游若提供 `abort_compaction` RPC，则「取消压缩」成为一等公民：成员端压缩被干净中止（abort 信号路径），进程保持存活，上下文保持完整，无需 resume。**

### 上游事实（pi 0.84.2 dist 实读，2026-08）

| 事实 | 位置 | 证据 |
|------|------|------|
| `agent-session.abortCompaction()` 方法**已存在** | `dist/core/agent-session.js` ~1488 行 | `abortCompaction() { this._compactionAbortController?.abort(); this._autoCompactionAbortController?.abort(); }` |
| 压缩挂在独立 AbortController 上 | `dist/core/agent-session.js` ~1369 行 | `compact()` 内 `this._compactionAbortController = new AbortController()`，压缩请求携带 `signal`（~1397） |
| **在飞压缩确实响应 abort** | `dist/core/agent-session.js` ~1429 行 | `if (this._compactionAbortController.signal.aborted) throw new Error("Compaction cancelled")`——abort 后压缩抛错退出 |
| `abort` RPC 命令**不中止压缩** | `dist/modes/rpc/rpc-mode.js` ~329 行 | `case "abort": { await session.abort(); return success(id, "abort"); }`——`session.abort()` 只中止 agent（`this.agent.abort()`），不触碰两个压缩 controller |
| `abortCompaction()` 目前仅被内部路径调用 | `dist/core/agent-session.js` ~559 行 | `dispose()` 内调用（会话销毁兜底），无 RPC 暴露 |
| `compact` RPC 命令入口已存在 | `dist/modes/rpc/rpc-mode.js` ~416 行 | `case "compact": { const result = await session.compact(command.customInstructions); ... }` |
| `get_state` 已返回 `isCompacting` | `dist/modes/rpc/rpc-mode.js` ~349 行 | 扩展侧 `waitCompactionIdle` 轮询依赖此字段 |

**结论**：取消能力已在 agent-session 层实现并通过 abort signal 验证有效（在飞压缩会抛 "Compaction cancelled" 退出、`_emit compaction_end` 收尾），上游仅需在 rpc-mode.js 暴露一个命令——成本最低的纯接线改动。

## 建议：暴露 `abort_compaction` RPC 命令

### 接口

```jsonc
// 请求（rpc-mode.js 命令表新增分支，与 "compact" 并列）
{ "id": 42, "command": "abort_compaction" }
// 响应
{ "type": "response", "id": 42, "command": "abort_compaction", "success": true, "error": null }
```

### 实现位置与成本

`dist/modes/rpc/rpc-mode.js` 命令 switch 新增：

```js
case "abort_compaction": {
    session.abortCompaction();
    return success(id, "abort_compaction");
}
```

约 3 行，零新依赖。`session.abortCompaction()` 幂等（AbortController.abort 重复调用无害）。

### 语义约定（建议）

- **幂等**：无在飞压缩时调用返回 success（no-op），与 `abort` 命令一致。
- **收尾链路自动复用**：abort 后压缩抛 "Compaction cancelled" → agent-session 的 compaction catch 路径 `_emit compaction_end`（无论成败必发）→ 扩展侧心跳分支照常 close+flush——**abort 的消费方无需任何新逻辑**。
- **错误语义**：若需严格区分「无压缩可中止」，可返回 `success: false, error: "No compaction in progress"`——建议宽松（幂等 no-op），与现有 `abort` 的宽松风格一致。

### 与自动压缩的关系（重要）

`abortCompaction()` 同时 abort `_autoCompactionAbortController`（自动压缩）与 `_compactionAbortController`（手动压缩）。上游若实现，应确认自动压缩 abort 后的行为：agent-session 自动压缩路径（`_checkCompaction` 等）在 abort 后应**不再立即重试压缩**（否则 abort_compaction 变成死循环开关）——建议 abort 后清一次性自动压缩意图或依赖现有重试守卫（`willRetry` 语义在 compaction_end 携带，扩展侧已有处理）。

## 本仓库扩展侧现状（Phase 1/2 已落地，不依赖本 ADR）

| 出口 | 机制 | 说明 |
|------|------|------|
| ① | `compaction_end` 心跳分支 close+flush | 正常结束主路径；超时场景通知「压缩已于 N 分钟后结束，积压消息已自动补发」 |
| ② | `waitCompactionIdle` 30s 轮询 | 事件丢失/auto-restart 兜底；预算 = timeoutMinutes |
| ③ | 二次超时放弃 + 进程退出清 pending | resolve corrId + 通知人工干预 |

**上游合入后的演进空间**：二次超时出口的通知文案从「请 stop_member 或 /team stop 后 resume」升级为「可先尝试 abort_compaction 取消压缩，成员保持存活无需恢复」——扩展侧在通知与二次超时分支中映射新 RPC 即可（依赖上游合入后另行评估，非本阶段范围）。

## 复现/验证

### 本地验证 abort 生效（无需上游改动，验证方法）

```
1. 对成员发起大上下文压缩（sendCommandAndWait {type: "compact"}）
2. 压缩进行中（get_state.isCompacting === true）
3. 直接调用成员进程的 agent-session 方法不可行（RPC 无暴露）——
   当前唯一验证路径是 dispose（不可用）或 kill 进程
```

### 上游合入后验证

```
1. 扩展侧 compact 触发 → isCompacting true
2. sendCommand {command: "abort_compaction"} → success
3. 观测：compaction_end 事件到达（reason/aborted 字段）、isCompacting false、
   成员会话完好、新 prompt 正常受理（不再拒收）
```

## 移交说明

本文档可直接作为 pi 上游 issue 的正文或附件。issue 标题建议：`Expose abort_compaction RPC (agent-session.abortCompaction() exists but is not reachable over RPC)`。
