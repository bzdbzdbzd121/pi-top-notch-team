# Spike：`get_entries {since}` 增量拉取能力确认（P4 先行）

日期：2026-08（P4 阶段，最终方案 rev-1787229361 阶段 4）
验证源：① pi 文档 `docs/rpc.md` §get_entries ② pi 0.84.2 dist 源码（rpc-mode.js / session-manager.js / agent-session.js）③ 真实成员会话文件（`.pi/top-notch-team/sessions/think-tank/msvkzvwa-czhu/analyst-beta/*.jsonl`，964 entries）

## 结论：可行，游标方案成立

`get_entries {since}` 在 pi RPC 层完整支持，entry id 是稳定游标，跨进程重启有效。

## 1. 字段 shape（rpc-mode.js L502-513）

请求：
```json
{"type": "get_entries"}                    // 全量
{"type": "get_entries", "since": "abc123"} // 增量：严格在 since 之后
```

响应：
```json
{
  "type": "response", "command": "get_entries", "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123",
       "timestamp": "...", "message": {"role": "user", "content": [...]}}
    ],
    "leafId": "def456"
  }
}
```

**since 语义**（rpc-mode.js）：`entries.findIndex(e => e.id === since)` → `entries.slice(sinceIndex + 1)`。
- since 不匹配任何 entry id → `success: false` + error `Entry not found: <id>`（失效信号）
- since 匹配 → 返回严格在后的全部 entries（append order）
- 游标 = entry.id，磁盘持久化（session-manager 从 jsonl 重建 byId）→ **跨进程重启有效**

## 2. entry 类型与 message 嵌套

`getEntries()` = `fileEntries.filter(e => e.type !== "session")`（session header 排除）。真实文件 964 entries 类型分布：

| type | 数量 | 说明 |
|---|---|---|
| message | 956 | `{type, id, parentId, timestamp, message:{role, content, timestamp}}` |
| compaction | 5 | `{summary, firstKeptEntryId, tokensBefore, usage, ...}`（非 message，须过滤） |
| model_change / thinking_level_change | 各 1 | 非 message，须过滤 |

- **`entry.message` 与 `get_messages` 返回对象同源**：agent-session.js L378 `message_end` 持久化 `appendMessage(event.message)`，即 `agent.state.messages` 中的同一对象。role 分布（真实文件）：user 40 / assistant 441 / toolResult 475 / bashExecution（源码确认也 appendMessage）。字段与现有渲染完全兼容（content 块数组：thinking/toolCall/text）。
- message 顺序 = append order，父先子后（真实文件验证 `all parentIds resolve: True`）。

## 3. 分支语义与 leafId

- `leafId` = 当前 leaf entry id（append 推进）；主分支 = leafId 沿 parentId 回溯到根（null）的祖先链。
- **abandoned branches 包含在 entries 中**（与 get_messages 不同——后者仅 agent 当前上下文）→ 增量路径必须做祖先链过滤：只保留当前 leafId 祖先链上的 message entries。
- **分支移动判定**：增量响应带回新 leafId；若 since 条目仍在新祖先链上 → 主分支未移动（steer/retry fork 分叉点 ≤ since 时增量安全）；否则（主分支重写）→ 全量回退。
- **断链**：回溯时 parentId 不在「已见映射」中 → 数据不完整（seen 缺失）→ 全量回退。

## 4. 压缩（compaction）对游标的影响：**不影响**

- 磁盘 append-only：compaction 是额外 entry（append），**不删除/改写旧 entry**（真实文件：5 个 compaction entry 与 message 共存）。→ since 游标压缩后依然有效。
- 但 `agent.state.messages` 在压缩时被整体替换（agent-session.js L1435 `messages = sessionContext.messages`）→ **get_messages 视图变（摘要链），get_entries 视图不变（磁盘原文）**。
- 决策：inspector 显示切到磁盘原文视图（更完整——压缩前的历史仍可见）。增量路径在压缩后继续有效，无需回退。
- 分支重写（steer/retry）会 fork 新分支 → leafId 变化 → 若 since 不在新祖先链 → 全量回退（fingerprint 守卫自动重建）。

## 5. 与 get_messages 的差异（显示语义变化，须记录）

| 维度 | get_messages（现状） | get_entries（P4） |
|---|---|---|
| 数据源 | agent 运行时上下文（内存） | 磁盘原文（持久化） |
| 压缩后 | 摘要链（旧历史消失） | 原文全保留（更完整） |
| 分支 | 仅当前上下文 | 全部（须祖先链过滤） |
| 载荷 | 全量 O(history) | 增量 O(new)（since 游标） |
| 消息对象 | agent.state.messages | entry.message（同源同 shape） |

## 6. 失效回退链（fail-open）

1. `success: false`（since 不匹配，如跨会话重启后新会话）→ 删游标 + 全量重拉
2. 分支移动（since 不在新祖先链）→ 全量重拉
3. 断链（seen 映射缺失 parentId）→ 全量重拉
4. 响应无 entries 字段（老版本 pi 不支持 / RPC 异常）→ **回退 get_messages 全量**（方案备胎：TL 侧差异合并仅作版本兜底，此处简化为直接回退旧命令）

## 7. 交付决策

- 游标存 TL 进程内（per-tab `entryCursors`）：跨成员进程重启有效（since 是磁盘 id）；TL 重启后自然全量重建。
- 增量追加 = `[...prev, ...newMsgs]`；`canIncrementCache` 边界指纹基于内容（messageFingerprint）→ 追加后增量构建正常（既有 P2 守卫复用，零新机制）。
- 分支过滤纯函数放 `member-inspector-state.ts`（可测）：`filterMainChainEntries` / `isSinceOnMainChain`。
- R5：`reconcilePending` 哈希化（contentKey = role + JSON.stringify(content) 预计算 Map，O(p+m)）。
