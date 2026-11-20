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

`/team stop` 与 `session_shutdown` **不再删除 session 目录**，改为把 manifest 标记为 `stopped`（干净停止）或保留 `active`（= 中断语义，可恢复列表优先展示）。磁盘清理需显式执行 `/team delete`——与 pi 自身"任何历史会话都可 resume"的语义对齐（作用域限定：`/team delete` 以 YAML 团队定义为入口，对预定义团队可连同 `sessions/<name>/` 一起删；动态会话没有 YAML 定义，其目录不由它清理，保留供 `/team resume`）。`session_shutdown` 现在会 best-effort 停掉 member 进程（防止孤儿继续 append 会话文件，与将来 resume  reopen 冲突）。

### 5. `/team resume`（P1）

扫描 manifest → 选择（参数匹配团队名/sessionId 前缀，或多个时 select）→ 孤儿清理（/proc/<pid>/environ 校验 TEAM_NAME + 会话路径后 SIGTERM，防 PID 复用误杀）→ 以原 sessionId 重建 TeamSessionState（名册以 manifest 快照为准，描述/workflow 优先取当前 YAML）→ 恢复 Goal/sharedContextWritten/origin/dynamicPhase → 注册会话工具 + widget → 以 `resume: true` 重启 startedMembers（上下文完整恢复）→ 一次性 TL 恢复通知（`before_agent_start` 追加在下一轮用户消息之后，不改系统提示词）：成员可能接续旧上下文，但**中断时正在执行的任务不重放**、pending corrId 失效，TL 需确认成员状态后决定重派或继续。

## 权衡与边界

- **进行中任务不重放**：member 恢复到中断前最后一条完整 entry，半条 tool call 丢弃，member 回到 idle。任务编排由 TL 重建（它是编排者，上下文也在）。这是刻意接受的语义。
- **磁盘增长**：停止的会话目录不再自动清除，依赖 `/team delete`（仅预定义团队；动态会话目录不在其作用域内）或手动清理。换来的是与 pi 一致的恢复语义。
- **孤儿检测仅 Linux**（/proc）；其他平台跳过杀孤儿（新进程 reopen 会话文件是 append 语义，风险可接受）。
- **预定义团队以 manifest 快照为准**而非实时 YAML：member 目录是按当时的名册构建的，YAML 之后可能被编辑。描述等展示字段仍取 YAML。

## 后果

- member 崩溃 auto-restart 不再丢上下文（独立收益）。
- TL 进程崩溃/退出、用户 `/new` 或 `pi --resume` 切换会话后，`/team resume` 可完整恢复团队（成员上下文 + 名册 + Goal + 阶段）。

## 增量：干净重启（`fresh`）、归档与清理（决策 #49）

本 ADR 的恢复语义**不变**（重启默认**尝试**续接、`--continue` 仍是恢复通道；实际是否续接以启动结果为准）。后来新增的是一组**参数化与可撤销性**能力，属于既有恢复语义的补充，没有高逆转成本，因此不新建 ADR：

- **默认尝试续接显式化**：`start_member` 在成员会话目录已有 `.jsonl` 时一律加 `--continue`（既有 `hasSessionFiles` 自动探测），并在工具说明、提示词指引与启动结果里说清「默认尝试续接；实际是否续接以结果附注为准」。结果附注只报**实测事实**：仅当「未 `fresh` 且启动前确有文件」时，启动后向成员进程查询一次 `get_state`（3s，失败不阻断）——「已续接（历史 N 条）」/「⚠️ 未续接（查到 0 条）」/「无法确认（查询失败）」。原因：扩展的续接探测是递归扫描，pi 的 `--continue` 只扫顶层并做工作目录比对，两者不一致时「请求了续接」不等于「续接成功」，不能对 TL 说假话。
- **`fresh: true`（干净重启）**：配置层不产生续接标记（优先级高于自动探测与显式 `resume: true`），并在启动前把该成员会话目录下的全部 `.jsonl` 移到**同级**的 `sessions/<team>/<sessionId>/.member-resets/<member>/<YYYYMMDD-HHMMSS[-n]>/`（同步文件 API；失败不阻断启动）。同级而非成员目录内是**结构性**排除：探测是递归的，留在成员目录内（哪怕改后缀）仍会被算作「有历史」。`fresh` 只丢弃该成员自己的对话，不回滚它已改写的文件，不动共享上下文。
- **归档保留 + `/team clean`**：归档默认保留（它是唯一的事后现场），不自动删除；`/team clean [团队名]` 是唯一只删归档的入口（只读扫描 → 预览 → 确认「删除后不可恢复」→ 逐条删除 → 汇总）。只删形状完全匹配且真实路径位于 `<数据目录>/sessions` 内的目录，符号链接/不合规时间戳/越界路径一律跳过并报告。`/team delete` 仍会连归档一起删除；`/team resume` 不看归档，行为不变。
- **重复启动保护**：同一成员名同时至多一个运行中的进程（判定只看进程句柄状态；`start_member` 工具层 + `createAndRegisterMember` 结构性兜底），避免两个同名进程写同一会话文件（pi 的会话落盘有截断重写路径，并发写会造成分叉/丢历史）。
- **文案**：`/team resume` 横幅改为条件式（「是否真正续接取决于该成员是否有可用的会话记录」），不再断言「完整对话上下文已保留」——工作目录变化或文件在子目录里时那句话为假。
