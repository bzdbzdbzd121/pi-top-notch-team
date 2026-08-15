# ADR-0004: 团队会话恢复（/team resume）—— 清单持久化 + member 会话落盘 + 停止即保留

## 状态

已接受

## 背景

pi 自身的会话支持 `--continue/--resume`，但团队会话无法恢复：TL 进程退出或异常终止后，member 上下文全部丢失。调查发现的完整丢失链：

1. **member 会话从未落盘（根因 bug）**：member spawn 参数带 `--no-session false`，而 pi 的 `--no-session` 是裸布尔 flag（不消费下一个参数），实际效果是 member 以纯内存会话运行（`"false"` 泄漏为位置参数）。member session 目录一直为空。
2. **目录被主动删除**：`/team stop` 的 teardown 和 `session_shutdown`（/new、/resume、/fork）都会 `rmSync` 整个 session 目录。
3. **团队状态纯内存**：成员名册（动态团队的 systemPrompt 没有任何磁盘副本）、sessionId、origin、Goal 都在模块级内存里。
4. **崩溃重启丢上下文**：manager 的 auto-restart 重新 spawn 时不带 `--continue`。

## 决定

### 1. member 会话必须落盘（P0）

移除 spawn 参数中的 `--no-session false`。pi 的 session 是**增量 append**（`appendFileSync` 逐条写入），SIGKILL 也仅丢最后半条 entry。member 的专属 `--session-dir`（`sessions/<team>/<sessionId>/<member>/`）使 `--continue` 精确恢复到该 member 的最近会话。

### 2. 重启即续接（P0）

`MemberProcessConfig.resume` 控制 `--continue`；`buildMemberConfig` 自动探测：session 目录已有 `.jsonl`（`hasSessionFiles`，递归）则一律续接。进程包装内 `startedOnce` 使崩溃 auto-restart 自动带 `--continue`。`hasSessionFiles` 守卫避免空目录下 `--continue` 找不到会话直接退出。

### 3. 会话清单（manifest）作为恢复锚点（P1）

每个活跃会话在 `sessions/<team>/<sessionId>/session.json` 持久化：teamName、sessionId、origin、isDynamic、dynamicPhase、status、sharedContextWritten、Goal、agentInitiatedTask、**完整成员名册**（动态团队的唯一磁盘副本）、startedMembers（当前启动集合）、memberPids（孤儿检测）。在所有状态变更点合并写入（startSession/addMemberToSession/write_shared_context/set_goal/finish_goal/start_member/stop_member/阶段转换），原子写（tmp+rename），全程 fail-open。

### 4. 停止即保留（P1）

`/team stop` 与 `session_shutdown` **不再删除 session 目录**，改为把 manifest 标记为 `stopped`（干净停止）或保留 `active`（= 中断语义，可恢复列表优先展示）。磁盘清理由 `/team delete` 显式负责——与 pi 自身"任何历史会话都可 resume"的语义对齐。`session_shutdown` 现在会 best-effort 停掉 member 进程（防止孤儿继续 append 会话文件，与将来 resume  reopen 冲突）。

### 5. `/team resume`（P1）

扫描 manifest → 选择（参数匹配团队名/sessionId 前缀，或多个时 select）→ 孤儿清理（/proc/<pid>/environ 校验 TEAM_NAME + 会话路径后 SIGTERM，防 PID 复用误杀）→ 以原 sessionId 重建 TeamSessionState（名册以 manifest 快照为准，描述/workflow 优先取当前 YAML）→ 恢复 Goal/sharedContextWritten/origin/dynamicPhase → 注册会话工具 + widget → 以 `resume: true` 重启 startedMembers（上下文完整恢复）→ 一次性 TL 横幅（before_agent_start 注入后清除）：成员上下文已保留，但**中断时正在执行的任务不重放**、pending corrId 失效，TL 需确认成员状态后决定重派或继续。

## 权衡与边界

- **进行中任务不重放**：member 恢复到中断前最后一条完整 entry，半条 tool call 丢弃，member 回到 idle。任务编排由 TL 重建（它是编排者，上下文也在）。这是刻意接受的语义。
- **磁盘增长**：停止的会话目录不再自动清除，依赖 `/team delete` 或手动清理。换来的是与 pi 一致的恢复语义。
- **孤儿检测仅 Linux**（/proc）；其他平台跳过杀孤儿（新进程 reopen 会话文件是 append 语义，风险可接受）。
- **预定义团队以 manifest 快照为准**而非实时 YAML：member 目录是按当时的名册构建的，YAML 之后可能被编辑。描述等展示字段仍取 YAML。

## 后果

- member 崩溃 auto-restart 不再丢上下文（独立收益）。
- TL 进程崩溃/退出、用户 `/new` 或 `pi --resume` 切换会话后，`/team resume` 可完整恢复团队（成员上下文 + 名册 + Goal + 阶段）。
