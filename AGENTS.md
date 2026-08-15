# pi-top-notch-team — Agent Guide

Multi-agent team collaboration extension for [pi](https://pi.dev). Enables users to define teams of specialized agent roles that work together on complex, long-running tasks.

## Quick Start

```bash
# Install locally
pi install ./pi-top-notch-team

# Create a team definition
/team create

# Start a team session with pre-defined team
/team start <team-name>

# Start a dynamic team session (TL designs team on the fly)
/team dynamic

# End the session
/team stop
```

## Architecture

```
User's pi session (TL extension)
  ├── 11 subcommands (/team create, dynamic, edit, cancel, start, stop, list, show, delete, status, help)
  ├── 10 个 TL 工具（9 个会话专用工具 start_member, stop_member, list_members, get_member_log, wait_and_get_member_status, team_send_and_wait, write_shared_context, set_goal, finish_goal + 动态模式专用 add_dynamic_member）——仅在团队会话期间注册+激活

Batch send: team_send_and_wait now supports tasks array for concurrent dispatch to multiple members. Previously single-target to/content/nextSteps; now unified tasks:[{to, content}] + nextSteps. **Batch when tasks are independent (parallel execution); sequential when task B depends on task A's output. See TL Tools table for decision rules.**
  ├── Message channel (queue → router → responseWaiter)
  ├── Member Process Manager
  │     ├── Member A (pi --mode rpc, member.ts)
  │     ├── Member B (pi --mode rpc, member.ts)
  │     └── Member C (pi --mode rpc, member.ts)
  └── Team mode UI widget (live member status + context usage %, above editor)
```

**Key files:**

| File | Role |
|------|------|
| `index.ts` (~400 lines) | TL extension entry point. Registers `/team` command, wires DI dependencies, `before_agent_start` injection, team-status + edit-mode widget lifecycle, autocomplete provider, `agent_settled` interrupt handler (Esc detection with member-running notification). Refactored from ~800 lines via modular extraction. |
| `member.ts` | Member extension entry point. Registers `team_send_message` tool, injects team awareness via env vars. Uses `JSON.parse` for TEAM_MEMBERS (no longer comma-delimited). |
| `package.json` | pi package manifest with `pi.extensions` pointing to `["./index.ts", "./member.ts"]` |

## Source Map

```
src/
├── commands/
│   ├── team.ts       ← Dispatcher: ~150 lines, registers /team command, delegates to handlers
│   ├── save-team-definition.ts  ← Pure function: team merge & persist logic
│   ├── status.ts     ← StatusProvider type for getMemberStatuses
│   ├── handlers/     ← 12 extracted subcommand handlers (< 120 lines each)
│   │   ├── create-handler.ts
│   │   ├── dynamic-handler.ts
│   │   ├── edit-handler.ts
│   │   ├── start-handler.ts
│   │   ├── stop-handler.ts
│   │   ├── list-handler.ts
│   │   ├── show-handler.ts
│   │   ├── delete-handler.ts
│   │   ├── status-handler.ts
│   │   ├── setting-handler.ts   ← /team setting 交互式设置菜单（成员默认模型 + 自动压缩）
│   │   ├── done-handler.ts
│   │   └── help-handler.ts
│   ├── shared/        ← Shared schemas, tool helpers, and extracted pure functions
│   │   ├── workflow-schema.ts     ← workflowStageSchema + workflowSchema
│   │   ├── register-definition-tool.ts  ← Unified registerTeamDefinitionTool (mode: create|update)
│   │   └── ensure-tool.ts         ← ensureToolRegistered(): dedup getAllTools pattern
│   ├── team.test.ts
│   ├── save-team-definition.test.ts  ← saveTeamDefinition merge logic tests
│   └── team-dynamic.test.ts  ← /team dynamic tests
├── channel/          ← Real-time message channel
│   ├── types.ts      ← TeamMessage interface
│   ├── message-queue.ts  ← Serial FIFO queue (event-driven drain, no polling)
│   ├── router.ts     ← Routes to member / tl / all / self-skip
│   ├── response-waiter.ts  ← team_send_and_wait correlation matching + response buffer
│   ├── auto-compact.ts    ← Shared Auto-Compaction runtime (primitives + pending/flush)
│   └── event-handler.ts    ← Member RPC event handler (state machine, dedup, routing)
├── process/          ← Member process lifecycle
│   ├── member-process.ts  ← pi --mode rpc spawn wrapper (write queue, size guard)
│   └── manager.ts    ← Multi-member lifecycle + operational state + auto-restart
├── tools/
│   ├── tl-tools.ts   ← 7 TL process management tools (Deps-based DI)
│   ├── goal-tools.ts  ← Goal system: set_goal/finish_goal tools + agent_end reminder
│   ├── agent-session-tools.ts ← start_team_session（加载时注册，ADR-0003 例外）+ stop_team_session（会话作用域，仅自主会话激活）
│   ├── agent-session-tool-names.ts ← 工具名常量（叶子模块，防循环依赖）
│   ├── session-tool-visibility.ts ← 会话工具可见性强制（纯函数）：9 个团队会话工具（start_member…finish_goal）仅在会话期间注册+可见，before_agent_start 回合边界强制执行；AGENT_SESSION_TOOL_NAMES 按 origin 条件激活
│   ├── shared-context-tool.ts ← write_shared_context 工具：唯一合法的共享上下文写入入口，成功后标记会话状态（start_member 门控依赖）
│   └── tl-tools-add-dynamic.test.ts  ← add_dynamic_member tool tests
├── team/
│   ├── definition.ts ← TeamDefinition / TeamMember types
│   ├── schema.ts     ← YAML field validation
│   └── store.ts      ← Read/write/delete team YAML files
├── session/
│   ├── state.ts      ← TeamSessionState (structuredClone deep copy), addMemberToSession(), SessionOrigin
│   ├── teardown.ts   ← 共享会话终结逻辑（/team stop 与 stop_team_session 复用）+ sessionEndedNotice 一次性置位
│   ├── teardown.test.ts ← sessionEndedNotice 置位/空转不置位测试
│   ├── shared-context.ts ← Shared context path 单一来源 + ensureSharedContextFile() 自愈创建（缺 stub 则自动生成）
│   ├── state.test.ts ← addMemberToSession tests
│   ├── tl-read-guard.ts  ← TL 亲自分析的运行时软纠偏（turn 内未派发且非管理工具调用超阀值 → 持续拦截直到派发）
│   ├── tl-read-guard.test.ts ← read guard 单元测试
│   ├── context.ts    ← TeamContext shared mutable state interface (incl. isDynamicSession)
│   └── state-machine.ts  ← Pure function state machine: MemberOperationalState transitions
├── prompts/
│   ├── dynamic-mode.ts  ← TL system prompt template for /team dynamic mode (design/execution phases)
│   ├── agent-initiated-mode.ts ← agent 自主会话提示词（ADR-0003）：使命锚定、无 grilling/确认门/第一动作协议
│   ├── tl-first-action.ts ← 共享「第一动作协议」提示词片段，注入两种模式 TL 提示词顶部
│   ├── workflow-prompt.ts ← 预定义团队的工作流提示词构建（纯函数）：激活横幅 + 操作型执行协议，替代旧内联描述性注入
│   ├── workflow-prompt.test.ts ← 工作流提示词测试
│   ├── orchestration-playbook.md  ← TL 编排方法论：需求对齐(grilling)/任务拆分/质量加固模式库/确认门，注入设计阶段提示词
│   └── dynamic-mode.test.ts  ← 动态模式提示词测试
├── setup/            ← Modular extracted setup modules
│   ├── member-lifecycle.ts  ← createAndRegisterMember, buildMemberConfig, getMemberLog
│   ├── message-channel.ts   ← createMessageChannel factory (queue+router+waiter wiring)
│   ├── dynamic-session-bootstrap.ts ← 动态会话共享 bootstrap（/team dynamic 与 start_team_session 复用）+ ensureAddDynamicMemberTool
├── settings/         ← Global settings (/team setting)
│   ├── settings.ts        ← TeamSettings type + <rootDir>/settings.yaml read/write
│   ├── resolve-model.ts   ← Pure function: member model precedence resolution
│   └── resolve-auto-compact.ts ← Pure functions: auto-compaction resolution + threshold check + menu label
├── ui/               ← TUI components for team mode
│   ├── team-status-widget.ts  ← Bordered widget: live member status + context %
│   ├── edit-mode-widget.ts   ← Bordered widget: ✏️ EDIT MODE — <team name>
│   ├── create-mode-widget.ts ← Bordered widget: 🆕 CREATE MODE
│   ├── scroll-select.ts      ← Scrollable + filterable select dialog (ctx.ui.custom, maxVisible window + fuzzy search)
│   ├── member-inspector.ts   ← Member Inspector overlay (alt+t): tabs, conversation view, input box, footer
│   └── member-inspector-state.ts  ← Inspector pure display state + line building (no TUI deps)
├── config.ts         ← getRootDir() via env var or ~/.pi/top-notch-team
├── config.test.ts    ← getRootDir() env var tests
└── test/fixtures/    ← Test YAML files + mock-extension-api.ts
```

## Key Design Decisions

1. **Members as independent `pi --mode rpc` processes** — each Member has its own session context. TL communicates via stdin/stdout JSONL. See ADR-0001.

2. **TL as central message router** — Member messages detected via `tool_execution_end` RPC events, enqueued in serial FIFO queue, routed via `router.ts`. See ADR-0002.

3. **Environment variables for Member awareness** — `TEAM_ROLE`, `TEAM_NAME`, `TEAM_MEMBERS`, `TEAM_MEMBER_DESCRIPTION` are set on spawn. No YAML file reading in member.ts. `TEAM_MEMBERS` uses `JSON.stringify`/`JSON.parse` (not comma-delimited) for member names that may contain special characters.

4. **Two separate extensions** — `index.ts` (TL) and `member.ts` (Member) are both declared in `pi.extensions`. Mode detection: `index.ts` returns early if `TEAM_ROLE` is set (to avoid tool name conflicts with `member.ts`); `member.ts` checks `process.env.TEAM_ROLE`.

5. **Dependency Injection for testability** — five DI interfaces (`TlToolsDeps`, `MemberLifecycleDeps`, `MessageChannelDeps`, `EventHandlerDeps`, `SendToMemberDeps`) explicitly document each module's dependencies, enabling isolated testing with mocked dependencies. See the Dependency Injection Pattern section below.

6. **Pure function state machine** — `src/session/state-machine.ts` implements `transitionState(current, event)` as a pure function with no side effects. Member operational states (`idle`/`working`/`compacting`/`crashed`/`stopped`) are derived deterministically from events (`task_started`/`task_completed`/`compaction_started`/`compaction_completed`/`process_exit`/`started`/`stopped`).

7. **Modular extraction** — `index.ts` was reduced from ~800 to ~341 lines by extracting:
   - `setup/member-lifecycle.ts` — member creation, config building, log querying
   - `setup/message-channel.ts` — message channel wiring (queue+router+waiter)
   - `channel/event-handler.ts` — member RPC event processing with dedup
   - `channel/response-waiter.ts` — correlation matching with response buffering
   - `session/state-machine.ts` — pure state transitions

8. **Dynamic team mode (`/team dynamic`)** — A free-form mode where the TL designs the team at runtime. No YAML is written to disk. The TL enters a session with 0 members, discusses requirements with the user, uses `add_dynamic_member` to register member roles, then starts and dispatches them via the standard tool chain. The session guard blocks code file writes from the moment `/team dynamic` is entered. On `/team stop`, the temporary session directory (`sessions/_dynamic_<ts>/`) is cleaned up.

9. **Session isolation via sessionId** — Each team session generates a unique `sessionId` in `TeamSessionState`. `buildMemberConfig` uses this ID to nest session data under `sessions/<team-name>/<sessionId>/` instead of the flat `sessions/<team-name>/`. This prevents conflicts when the same pre-defined team is used across multiple sessions. On `/team stop`, the session subdirectory is cleaned up. Dynamic mode sessions (`_dynamic_<ts>`) use their unique team name for the same purpose — the entire team directory is removed on stop.

10. **Goal system for TL autonomy** — `src/tools/goal-tools.ts` registers `set_goal` and `finish_goal` tools plus an `agent_end` event handler. When the TL sets a goal at session start and later finishes a turn (agent_end), the system checks if the goal is still active and incomplete. If so, it queues a user message (via `setTimeout(0)` to avoid the agent_end lifecycle conflict with `sendUserMessage`, plus `deliverAs: "followUp"` so the reminder queues instead of throwing `Agent is already processing` if the TL agent is still inside the post-agent_end settlement window or already streaming again when the timer fires) re-triggering the TL with a reminder of the goal and its completion criteria. This prevents the TL from unnecessarily asking the user "should I continue?" mid-task. The goal is stored in module-level memory, has a 10-second cooldown between reminders to prevent loops, checks `ctx.signal?.aborted` to skip reminders when the user pressed Esc or redirected the agent, and is reset on session shutdown.
   **会话工具注册与可见性（turn-boundary enforcement）**：全部 9 个团队会话工具（`start_member`/`stop_member`/`list_members`/`get_member_log`/`team_send_and_wait`/`wait_and_get_member_status`/`write_shared_context`/`set_goal`/`finish_goal`）**只在团队会话（`/team start` 或 `/team dynamic`）期间注册**——扩展加载时不注册任何团队工具（见决策 #21）。由于 pi 没有 unregisterTool API，首次会话后工具会永久留在注册表中——活跃工具集是唯一可见性闸门，因此 `src/session/session-tool-visibility.ts` 的 `enforceSessionToolVisibility()`（纯函数 + DI，`SESSION_TOOL_NAMES` 与 `teamCtx.tlToolNames` 同源）在每个 `before_agent_start` 回合边界强制该不变式：会话活跃 → 确保注册（幂等）+ 激活；会话不活跃 → 从活跃集移除（绝不注册）。防止扩展重载/其他扩展 setActiveTools/plan-mode 切换等产生陈旧活跃列表导致工具泄漏到会话外。

11. **Defensive parsing for `tasks` parameter** — `src/tools/tl-tools.ts` includes a `parseTasks()` function that handles four formats for the `tasks` parameter:
    - Raw array (correct): `tasks: [{to: "a", content: "..."}]` (invalid entries missing string `to`/`content` are dropped with a warning)
    - String-encoded array (LLM double-encoding): auto-`JSON.parse` recovery
    - Single object (another LLM hallucination): auto-wraps as single-element array
    - **Broken string salvage**: when strict `JSON.parse` fails (truncated LLM output, raw newlines/control chars inside `content`), a brace-matching scanner extracts complete `{...}` objects, parses each (with a regex field-extraction fallback that tolerates raw control chars), dispatches the recovered tasks, and drops the incomplete tail. The result is prefixed with a recovery note ("已尽力恢复 N 个任务，丢弃 M 个不完整条目") so the TL knows to verify. The hard-failure error message includes the `JSON.parse` failure reason to aid debugging.
    This prevents `"tasks: must be array"` validation failures caused by LLMs incorrectly double-encoding JSON-in-JSON, and salvages as much work as possible when the double-encoded string is itself malformed.

12. **Two-phase dynamic mode** — `/team dynamic` is split into a **design phase** and an **execution phase**:
   - **Design phase** (entered on `/team dynamic`): TL is blocked from using `bash`/`code_search`/`fetch_content`/`edit` entirely. `read` is allowed but **soft-limited** (every 4th non-`.md` read is intercepted once with a "do you really need to read?" reminder — retrying the read passes it, single-shot not sticky; `.md` reads never count), `write` is restricted to `.md` files only. This forces TL to focus on discussing requirements and designing the team rather than exploring or modifying code. The only tools available are `add_dynamic_member`, team management tools, `read` (soft-limited), and `.md` writes.
   - **Execution phase** (entered when the first `start_member` succeeds): TL regains access to all tools for monitoring and coordination. The standard team session guard still blocks code file writes.
   - Phase transition is automatic: `start_member` tool calls `onDynamicPhaseTransition`, which flips `teamCtx.dynamicPhase` from `"design"` to `"execution"`. The `before_agent_start` handler injects different prompts depending on the current phase.

13. **Orchestration playbook for the design phase** — `src/prompts/orchestration-playbook.md` is a methodology document injected into the design-phase TL prompt (loaded at runtime relative to `dynamic-mode.ts`, cached, with an inline fallback summary). It turns the design phase from free-form improvisation into a guided six-stage process:
   - **A. 需求对齐（Grilling）**: one question at a time with recommended answers; walks a question tree (goal → scope → acceptance criteria → constraints → non-goals); facts vs decisions separated.
   - **B. 任务拆分**: decompose by deliverables, draw the dependency graph (parallel/sequential/join points), annotate each task with role/input/output/acceptance criteria. Large workloads (many similar subtasks) must be designed as multi-round batches — batch partitioning, pilot batch first, inter-batch verification and adjustment.
   - **C. 工作流编排与质量加固**: assumes agents make mistakes by default; maps risk signals to reinforcement patterns — parallel redundancy + cross-validation, adversarial debate (proposer/opposer/judge), develop-review loop (with exit condition + max rounds), spike-first scouting, human checkpoints for irreversible operations. Only high-risk stages get reinforced (cost-awareness).
   - **D. 团队设计**: roles derived from the workflow, not the reverse.
   - **E. 方案确认门 (hard gate)**: TL must present a full plan document (goal, task DAG, workflow with reinforcement rationale, team roster, risks) and is forbidden from calling `add_dynamic_member`/`start_member` until the user explicitly confirms. Enforced by prompt (not the tool_call guard).
   - **F. 落地执行**: register members, write structured shared-context (including workflow definition with stages/dependencies/failure fallback), then `start_member`.

14. **Member Inspector (成员检视浮窗)** — During an active Team Session, the user can press `alt+t` to open a full-keyboard overlay (`ctx.ui.custom` with `overlay: true`, 90%×85%) showing a horizontal tab per Member, the selected Member's live conversation, and a footer with operational states + context % + key hints. Refresh is event-driven: `EventHandlerDeps.onMemberActivity` passes the **full member RPC event** (`memberName, event`) and a throttled (500ms) RPC `get_messages` refetch rebuilds display lines. **Streaming (thinking/text/toolcall) has a dedicated local path**: RPC-mode `message_update` events carry deltas only (cumulative `partial` stripped on the wire) and `get_messages` excludes the in-progress message — so `MemberInspectorState` assembles a live partial assistant message from `message_start`/`message_update` deltas (`applyAssistantDelta`, contentIndex-keyed, toolcall raw JSON finalized at `toolcall_end`) and `flushStreaming` rebuilds the live tail locally at an adaptive cadence (100ms baseline, backs off to 1s under heavy rebuild cost via `nextStreamFlushDelay` hysteresis; zero RPC traffic per delta; incremental-cache streaming-tail fast path). **P2 streaming-tail perf**: with `t` on, thinking content is huge and grows by appends — the tail rebuild uses `wrapAppendOnly` (WeakMap per block object, wraps only the new delta, byte-identical to `wrapText` incl. grapheme clusters split across deltas), so a flush is O(Δ) instead of re-wrapping the whole block (was O(T) per flush → O(T²) per stream, the thinking-toggle CPU spike); and only the ACTIVE tab's tail is rebuilt per flush (N concurrently streaming members don't multiply the cost — inactive tabs catch up on tab switch or via the refetch path). `message_end` moves the authoritative message into per-tab `pendingCompletions` (rendered after fetched history — no end-of-message flicker) until the refetch confirms it via `reconcilePending` (content equality, tolerates interleaved toolResult messages). `agent_end` clears the live tail. Rendering: user/assistant text in full, tool calls/results as one-line summaries with an `e` expansion toggle, thinking blocks hidden by default with a `t` visibility toggle (with `t` on, thinking streams line-by-line), virtual scroll. **`e`/`t` are GLOBAL view-mode toggles** (not per-member): one keypress flips ALL member tabs — running tabs rebuild via the RPC refetch, stopped/crashed tabs with a history cache rebuild locally with zero RPC (`rebuildTabFromCache`), and members added later (dynamic mode) structurally inherit the current global values (single source of truth on `MemberInspectorState`, no per-tab fields). The user can message a Member directly (input box: Enter = `prompt`/`follow_up`, `Ctrl+Enter` = `steer`; `/...` sent raw for member-side command resolution) and run control commands (`ctrl+a` abort active member, `ctrl+b`/`ctrl+shift+a` abort ALL executing members in one shot — `ctrl+shift+a` needs Kitty keyboard protocol, `ctrl+b` works on all terminals; `ctrl+o` compact — NOT ctrl+m, which is indistinguishable from Enter in terminals). Direct messages are prefixed `[用户直接指令（非 TL）]:` so the Member can distinguish the source. **User interventions are NOT mirrored into the TL session** — the TL only learns about them indirectly (via member replies or `get_member_log`). `/team stop` auto-closes the overlay. See DESIGN.md §17.

15. **Global settings + model resolution** — `/team setting` opens an interactive `ctx.ui.select` menu for global team settings, persisted to `<rootDir>/settings.yaml`. The first setting, **member default model**, supports `follow` (member spawned later uses the TL's current model, tracked via `session_start`/`model_select`) or `fixed` (one of `ctx.modelRegistry.getAvailable()` logged-in models). Resolution precedence in `src/settings/resolve-model.ts`: member YAML `model` > team YAML `defaults.model` > global fixed > global follow > no override. The resolved model is passed as `--model provider/id` at member spawn — this also wires up the previously inert team-YAML model fields. Only subsequently started members are affected. The model picker uses `src/ui/scroll-select.ts` (a custom `ctx.ui.custom` component with a `maxVisible` scroll window, scroll indicator, and fuzzy-search input) because pi's built-in `ctx.ui.select` renders all options without scrolling — unusable for 100+ models.

16. **Auto-Compaction (自动压缩)** — When a member is `idle` and about to receive a new prompt via the message channel (`createSendToMember`), the TL first queries `get_session_stats` (3s timeout). If usage exceeds the configured threshold (percent and/or absolute tokens, OR semantics, resolved in `src/settings/resolve-auto-compact.ts`), the member enters the new **`compacting`** operational state and a `compact` RPC is awaited (configurable timeout, default 10 min) before the prompt is delivered. Design properties:
   - **Fail-open everywhere**: stats query failure, compaction failure, or timeout all end with the prompt dispatched anyway. The TL is only notified when a configured compaction did *not* happen — success is silent.
   - **At most one compaction per dispatch**, no re-check loop afterwards.
   - **`compacting` state shield**: the compaction turn's own RPC `agent_start`/`agent_end` events do not transition the state machine (`task_started`/`task_completed` on `compacting` are no-ops), so all-idle wait logic (`wait_and_get_member_status`, `team_send_and_wait`) naturally treats compacting as busy with zero changes to the wait code.
   - **Race-free dispatch**: the `compaction_started` transition happens synchronously before any await; messages arriving mid-compaction are queued and flushed after it ends.
   - Configured globally via `/team setting` (no team-YAML override): `autoCompact: { enabled, thresholdPercent?, thresholdTokens?, timeoutMinutes }`. Enabled-but-no-thresholds falls back to 80% and the menu surfaces this fallback explicitly.
   - Member Inspector direct messages bypass auto-compaction (user can compact manually via `ctrl+o`).
   - **共享压缩运行时（阶段 1）**: `src/channel/auto-compact.ts` 的 `AutoCompactRuntime` 拥有全部压缩原语（queryStats/shouldCompact/beginCompaction/compactNow/endCompaction/queueDuringCompaction/flushPending）与 per-member pending 队列。内联派发路径（`createSendToMember`）与批屏障（tl-tools）共享**同一实例**（`createMessageChannel` 创建并注入），压缩期间到达的消息（Inspector 直发等）统一进 pending、`flushPending` FIFO 释放——预检路径与内联路径共享同一 pending/flush，孤儿消息结构性不可能（D2）。接口为 discriminated union `{ ok: true, stats? } | { ok: false, error }`，错误携带真实 RPC 原因供通知。
   - **skipAutoCompact 标记（阶段 2）**: `TeamMessage.skipAutoCompact?: boolean`——"本批压缩决策已由预检做出"的唯一信号（正确性机制非优化）。带标记消息在 `createSendToMember` 中跳过内联检查直接派发（防 E12：压缩后 usage 仍超阈值时的二次压缩；同时保证 at most one per dispatch）。非屏障路径（单任务/成员互发/Inspector 直发）永不产生带标记消息。
   - **批屏障（阶段 3）**: `sendAndWaitExecute` 在 enqueue 之前运行批预检（tasks.length > 1 且 autoCompact 启用才启用）。【不变式 E1】整个屏障（WAIT + stats + 串行压缩）在 corrId 注册与 enqueue **之前**完成——屏障期不存在任何 wait 检测，all-idle 误释放不可能（顺序硬编码 + 测试锁定：压缩完成前 messageQueue 长度为 0）。流程：`planBatchCompaction`（纯函数：idle→查 stats / compacting→待等集合，不重复发 compact / 其他→跳过）→ 并行 stats（本地 RPC）→ 需压缩集合 **串行** compact（同一时刻至多一个 compact RPC，无 PD 分离下并发压缩=并发 prefill）→ per-member fail-open（失败者带 skip 随批派发、其余继续）→ maxWait 批预算（`batchMaxWaitMinutes`，默认 15 分钟，0=不限）超预算停止**未开始的**压缩整批派发（在飞 compact RPC 跑满自身 timeout 后才停，属预期） → COMMIT 注册全部 corrId 并 enqueue，`skipAutoCompact: true` **仅加给实际执行过压缩尝试的成员**（成功或失败均算）。可见性：屏障对 TL **完全静默**（[批屏障] 通知已移除）——TL 只感知更长的等待时间，不感知屏障内部过程（压缩等待/开始/失败/超预算均不通知；失败与超预算由内联路径的既有通知兜底）。单任务/关闭路径完全原路径零预检（E9）。待等集合的释放条件为"非 compacting"（idle/crashed/stopped 均放行——toWait 成员崩溃或 /team stop 后压缩已无意义，不得挂起到超时）。

17. **First-action protocol + TL read guard（双防亲自分析）** — TL 收到任务型诉求后亲自埋头分析（而不派发）是最常见的角色偏离。纯提示词约束不可靠（基座 coding-assistant 提示词驱动模型自己动手，且提示词中"能用代码验证的不要去问用户"曾与之矛盾、给了模型合规借口）。修复分两层：
   - **提示词层**：`src/prompts/tl-first-action.ts` 的「第一动作协议」（共享片段，防漂移）注入两种模式 TL 提示词的**顶部**——收到任务型诉求时第一个工具调用必须是 `start_member`/`team_send_and_wait`，派发前禁止 read/bash 代码文件；同时将旧规则限定为"需求对齐阶段允许读取 1-2 个文件查证"以消除矛盾。
   - **运行时层**：`src/session/tl-read-guard.ts`——`agent_start` 重置 turn 计数；turn 内未发生 `team_send_and_wait` 派发时，**所有非管理工具**（read/bash/web_search/ctx_execute 等，不只 `read`——否则可用 bash grep/rg 绕过）超过阈值（默认 3）即进入**持续拦截模式**：派发前每次非管理工具调用都被 block，reason 含纠偏指引，首次拦截带 `firstBlock` 标记触发用户可见的通知与状态栏警示；`team_send_and_wait` 派发后立即解锁。管理工具（含 write/edit 与派发通道）永不拦截，解锁通道永远畅通。fail-open。
   - **设计阶段 read 软限制（`createDesignReadGuard`，同文件）**：动态模式设计阶段没有可派发的 Member，上述 sticky 守卫不适用；但 read 仍需节流——非 `.md` read 每 `threshold` 次（默认 4）拦截**一次**并提醒「是否真的需要 read」，随后下一次 read 无条件放行（确需读取可再次调用，不持续拦截）；`.md` read 不计数；首次拦截触发通知 + 状态栏警示；`agent_start` 重置。

18. **Shared context 自愈创建**——`.shared-context.md` 过去完全依赖 TL（LLM）在 `start_member` 前用 `write` 写入，LLM 不可靠遵守顺序，导致 `buildMemberConfig` 只能打警告且 member 带着悬空路径启动。现在 `src/session/shared-context.ts` 的 `ensureSharedContextFile()` 保证文件恒存在：会话启动时（`/team start` / `/team dynamic`）创建最小 stub（团队名册 + 占位章节），`buildMemberConfig` 内也防御性调用；已存在则绝不覆盖，fs 失败 fail-open。TL 仍负责后续用真实内容覆盖。

19. **操作型工作流注入（workflow-prompt.ts）**——预定义团队 YAML 的 `workflow` 过去以内联描述性文本注入（"尽可能遵循步骤顺序"、执行者标在行尾括号里），无激活规则、无执行协议，TL 收到"根据团队流程进行 xxx 分析"仍自由发挥、自己分析。修复：抽为纯函数 `buildWorkflowPrompt()`，注入内容改为操作型——激活条件（用户提「团队流程/按流程」或任务与流程描述匹配）、逐 stage 用 `team_send_and_wait` 派给「执行者」（stage 执行者为 `tl` 的除外）、串行等待产出传递、独立 stage 批量并行、onFailure/loops 处理、逐 stage 进度汇报；每个 stage 以 `→ 执行者：\`member\`` 醒目标注；团队有 workflow 时另在第一动作协议下方注入 `WORKFLOW_ACTIVATION_BANNER` 横幅指针防稀释。Reference 模式措辞从"尽可能遵循"改为"默认按序执行、偏离须向用户说明理由"。

20. **Shared-context gate（write_shared_context 工具 + start_member 硬门控）** — 过去共享上下文完全依赖 TL 用 `write` 工具按顺序写入，LLM 不遵守顺序导致 member 经常在 TL 写入前启动（只有 stub）。修复：
   - 新增专用工具 `write_shared_context(content)`（`src/tools/shared-context-tool.ts`），只写会话的 `.shared-context.md`，成功后调用 `markSharedContextWritten()` 置位会话状态 `sharedContextWritten`（`src/session/state.ts`）；fs 失败则 fail-open 且**不置位**。
   - `start_member` 工具执行前检查 `getSessionState().sharedContextWritten`，未置位则拒绝启动并提示先调用 `write_shared_context`（硬门控，无逃生口——工具本身很轻量，TL 只需先写一次）。
   - tool_call 守卫拦截 `write`/`edit` 直接写 `.shared-context.md` 的调用，重定向到 `write_shared_context`，保证标记与文件内容一致。
   - 工具与其他会话工具一样**只在会话期间注册**（`onSessionStart` → `ensureSessionToolsRegistered`），随 `tlToolNames` 在会话期间激活/停用。`.shared-context.md` 的 stub 自愈（`ensureSharedContextFile`）保留为兜底（member 启动后仍能读到文件），但不再替代 TL 的显式写入。

21. **会话工具只在会话期间注册（session-scoped registration）** — 全部 9 个团队会话工具（6 个 TL 进程管理工具 + `write_shared_context` + `set_goal`/`finish_goal`）**不在扩展加载时注册**，而是由 `index.ts` 的 `ensureSessionToolsRegistered()`（内部用 `ensureToolRegistered` 幂等去重）在 `onSessionStart`（`/team start` 与 `/team dynamic` 共用，置于 widget 守卫之前）按需注册；`before_agent_start` 回合边界经 `enforceSessionToolVisibility()`（`src/session/session-tool-visibility.ts`，纯函数 + DI，`SESSION_TOOL_NAMES` 与 `teamCtx.tlToolNames` 同源）强制注册+激活/停用不变式。效果：会话外工具注册表与活跃集均不含任何团队工具（实测 fresh pi 运行 9 工具零出现）；`dynamic-handler` 先 `onSessionStart` 注册再 `setActiveTools` 激活（不依赖 pi 的 registerTool 自动激活行为）。模式工具（`create_team_definition`/`update_team_definition`/`add_dynamic_member`）维持各自的按需注册生命周期，不在本强制范围内。**唯一刻意例外**：`start_team_session` 在加载时注册（见决策 #22）。

22. **Agent 自主会话（agent-initiated team sessions，ADR-0003）** — `start_team_session(task)` 在**扩展加载时注册**（决策 #21 的唯一例外），agent 可随时自主进入动态团队会话委派复杂任务。核心设计哲学：**会话来源（`origin: "user" | "agent"`，`TeamSessionState.origin`）决定守卫强度**——手动会话 = 用户期望「以团队方式做事」，全守卫；自主会话 = agent 自己的手段选择，用户只要结果，故移除派发管制（tl-read-guard、设计 read 软限制、第一动作协议），保留写入管制（TL 与成员共享同一文件系统，并发写会物理覆盖——结构性安全非不信任）。完全自主：无 Playbook grilling、无确认门；`task` 必填并自动置 Goal + 注入自主版提示词（`src/prompts/agent-initiated-mode.ts`）。生命周期对称：`stop_team_session` 由 agent 自主终结会话——会话作用域注册但**仅自主会话激活**（`AGENT_SESSION_TOOL_NAMES` 条件可见性），与 `/team stop` 共享 `src/session/teardown.ts`。嵌套结构性不可能（`TEAM_ROLE` 早退）；重入返回错误。可见性：启动 notify（🤖 + task 摘要）+ widget 持久来源标记（🤖/👤）。预定义团队支持明确推迟（dynamic-only 先行）。

23. **团队会话恢复（/team resume，ADR-0004）** — 四层设计：(a) **member 会话落盘**：移除 spawn 参数中的 `--no-session false`（pi 的 `--no-session` 是裸布尔 flag，该写法曾使 member 纯内存运行、上下文从不落盘——根因 bug）；pi session 增量 append，崩溃仅丢最后半条。(b) **重启即续接**：`MemberProcessConfig.resume` + `buildMemberConfig` 自动探测（session 目录有 `.jsonl` 则 `--continue`）+ 进程内 `startedOnce`（崩溃 auto-restart 自动续接）；`hasSessionFiles` 守卫空目录。(c) **会话清单**：`sessions/<team>/<sessionId>/session.json` 持久化名册（动态团队唯一磁盘副本）/origin/phase/Goal/sharedContextWritten/startedMembers/memberPids，所有状态变更点合并写（tmp+rename 原子，fail-open）。(d) **停止即保留**：`/team stop`/`session_shutdown` 不再 rmSync，manifest 标记 `stopped` 或保留 `active`（中断语义）；`session_start` 检测到中断会话时状态栏提示。`/team resume` 以原 sessionId 重建状态、`--continue` 重启成员（上下文完整恢复）、/proc 校验后清理孤儿进程；中断时进行中的任务不重放，由 TL 确认状态后重建编排。会话列表按 **cwd 项目作用域**过滤（对齐 `pi --resume`：manifest 记录创建时的 cwd，默认只列当前目录会话，`--all` 显示全部并附目录标注）。

24. **会话结束一次性提醒（session-ended banner）** — 用户 `/team stop`（或 agent 调 `stop_team_session`）后，TL 的对话历史仍含 Team Lead 系统提示词与团队工具使用模式，且会话工具已停用（决策 #21），TL 下一轮仍可能以 Team Lead 自居、尝试调用已停用的团队工具——而 pi 对非活跃工具的报错是晦涩的 `Tool xxx not found`（agent-loop 在 `beforeToolCall` 之前就短路，扩展无法改写该错误）。修复：`teardownTeamSession` 在会话确实活跃过时置位 `teamCtx.sessionEndedNotice`（一次性标记，与 `resumedFrom` 同模式）；`before_agent_start` 在会话不活跃且标记未消费时，向下一轮系统提示词注入 ⚠️「团队会话已结束」横幅（工具已停用清单 + 回到普通模式的指示 + 再次进入用 /team start），并消费标记；若新会话先启动则静默丢弃。**横幅搭下一次用户发起的回合——绝不触发新对话**（pi 没有不触发回合地向 agent 注入上下文的手段；`pi.sendMessage` 会发起回合，被明确排除）。空转 `/team stop`（无活跃会话）不置位，避免虚假横幅。**边缘情况双层守卫**：(a) `session_start` 事件带 `reason: "new"`（/new 全新对话无团队历史）时直接清除 pending 标记；/fork 与 /resume 复制/恢复历史，不碰标记。(b) 消费时内容检查 `historyHasTeamTraces()`：当前对话历史确含团队痕迹（assistant toolCall 名为团队工具 / custom_message `customType: "team-message"` 的成员路由消息）才注入——/new 新对话无痕迹→不注入；/fork、/resume 团队对话痕迹被复制→注入（正是所需）；/resume 到别的非团队对话→无痕迹→不注入。sessionManager 不可用时 fail-open（照常注入），保证主场景（/team stop → 下一轮）稳定。

## Dependency Injection Pattern

The codebase uses an explicit Dependency Injection (DI) pattern to decouple modules and enable testability. Every subsystem receives its dependencies through a typed interface, rather than importing them directly.

| DI Interface | Module | Dependencies |
|-------------|--------|-------------|
| `TlToolsDeps` | `tools/tl-tools.ts` | `pi`, `manager`, `responseWaiter`, `memberOpsStates`, `lastPendingCorrId`, `messageQueue`, `createMember?`, `buildMemberConfig?`, `getMemberLog?`, `isDynamicSession?`, `addMemberToSession?`, `onDynamicMemberAdded?`, `onDynamicPhaseTransition?`, `getAutoCompact?`, `getHandle?`, `autoCompact?` |
| `MemberLifecycleDeps` | `setup/member-lifecycle.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages`, `processManager?` |
| `MessageChannelDeps` | `setup/message-channel.ts` | `pi`, `memberOpsStates`, `lastPendingCorrId`, `memberHandles`, `onRouteNotification?`, `getAutoCompact?` |
| `EventHandlerDeps` | `channel/event-handler.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages`, `processManager?`, `onMemberActivity?` |
| `SendToMemberDeps` | `channel/event-handler.ts` | `pi`, `memberOpsStates`, `memberHandles`, `getAutoCompact?`, `autoCompact?` |

Benefits:
- **Testability**: each module can be tested with mocked dependencies
- **Isolation**: modules don't reach into other modules' internals via global imports
- **Clarity**: the DI interfaces document exactly what each subsystem needs

## Message Channel Flow

```
Member A calls team_send_message({to: "mover", content: "..."})
  → RPC stdout emits tool_execution_end
  → event-handler.ts (createMemberEventHandler)
    → Dedup check (Map-based, auto-pruning)
    → Auto-populate <corr:...> for TL-directed messages
    → messageQueue.enqueue(TeamMessage)
  → messageQueue (serial FIFO, event-driven drain)
    → router.route(msg)
      ├── to="mover"  → handle.sendCommand({type:"prompt", streamingBehavior:"followUp", ...}) on Member B's stdin
      ├── to="tl"     → responseWaiter.resolveIfWaiting(corrId, ...) OR buffer
                          → pi.sendMessage({customType:"team-message", ...})
      ├── to="all"    → broadcast to all (skip self)
      └── unknown     → pi.sendMessage ("无法路由消息到未知成员")

Process exit + auto-restart flow:
  Member process exits unexpectedly
  → child.on("exit") → notifyHandlers({type:"process_exit", memberName, exitCode, wasRunning})
  → event-handler.ts
    → Update memberOpsStates ("crashed" / "stopped" via state machine)
    → Notify TL (crash/stop message)
    → Invoke processManager.handleExit(memberName, exitCode) ← NEW bridge
      → Crash tracking (sliding window, exponential backoff 1s/2s/4s/8s/16s)
      → Auto-restart timer or crash-loop freeze
      → onRestarting / onCrashLoopDetected callbacks

Backup path: assistant text outputs matching
  `<team-message to="..." subject="...">...</team-message>`
are also parsed via parseTeamMessageTag() (non-greedy regex, length guard) and enqueued.

Prompt delivery semantics:
  Channel prompts carry streamingBehavior:"followUp" — pi itself queues the
  prompt when the member is still streaming (incl. the post-agent_end settlement
  window: listener drain / auto-retry / auto-compaction continuation, during
  which memberOpsStates already shows "idle"), so dispatches are never lost to
  "Agent is already processing" rejections. No effect when the member is idle.
  Fire-and-forget rejections (response events with no RPC id, e.g. member
  model/auth failure) are surfaced by createMemberEventHandler: any pending
  team_send_and_wait is resolved with [消息未送达] + TL notified via team-route.

team_send_and_wait flow:
  TL calls team_send_and_wait({tasks: [{to, content}], nextSteps}) →
    → responseWaiter.waitForResponse(corrId)
    → Message enqueued with <corr:...> tag
    → Member replies → responseWaiter.resolveIfWaiting(corrId, ...) → TL continues
    → All-idle detection: returns early when all members are idle
```

## Team Definition Format

Stored at `~/.pi/top-notch-team/teams/<name>.yaml`:

```yaml
name: "refactoring"
description: "负责大型代码重构任务"
defaults:
  model: "anthropic/claude-sonnet-4"
members:
  - name: "analyzer"
    label: "代码分析员"
    systemPrompt: "你是一个代码分析专家..."
    # model: "..."  # optional override
```

Validation rules in `src/team/schema.ts`.

## Development Workflow

### 1. Test-driven development (TDD)
- 先写测试用例描述预期行为，再写实现代码
- 新增功能需添加对应的 `*.test.ts` 文件
- 测试文件放在源码同目录下（如 `src/team/store.test.ts`）

### 2. 已有测试必须全部通过
- 不涉及本次改动的已有功能，其测试用例必须保持绿色
- 提交前运行 `npm test` 确认 0 failure
- 如果现有测试因修改而红，检查是破坏性变更还是测试过时需要更新

### 3. 文档同步更新
- 每次新增或修改功能，检查以下文档是否需要对应更新：
  - `AGENTS.md` — 源文件映射、命令参考、设计决策
  - `DESIGN.md` — 架构、流程、接口说明
  - `docs/adr/` — 当决策满足 ADR 条件（高逆成本、外人意外、真正权衡）
- 修改接口签名（`TeamContext`、工具参数等）时必须同步更新文档中的类型定义
- 新增 UI 组件时需在 Source Map 中登记

## Testing

```bash
npm test          # Run all tests (vitest)
npm run test:watch  # Watch mode
```

870 tests across 53 files (state-machine, member-process incl. resume args, manifest, resume-handler, event-handler, response-waiter, message-channel, member, save-team-definition, config, ui-widget, member-inspector, agent-session-tools, agent-initiated-mode prompt tests included). Tests live alongside source as `*.test.ts`.

| Test Level | What | How |
|-----------|------|-----|
| Unit | schema, store, message-queue, router, config, state-machine, response-waiter | Pure functions, no mocking |
| Integration | commands, tl-tools, index, member-process, manager, event-handler, member-lifecycle, message-channel | Mock ExtensionAPI / child_process |
| E2E | Manual via `pi --mode json -e ./index.ts` | Real pi binary |

## Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `TOP_NOTCH_TEAM_ROOT` | Tests / config | Override data directory (~/.pi/top-notch-team) |
| `TEAM_ROLE` | Member process | Member identifier |
| `TEAM_ROLE_LABEL` | Member process | Human-readable role name |
| `TEAM_NAME` | Member process | Team name |
| `TEAM_MEMBERS` | Member process | JSON-serialized member name array (e.g. `'["analyzer","mover"]'`). Parsed via `JSON.parse` with comma-delimited fallback for backward compatibility. |
| `TEAM_MEMBER_DESCRIPTION` | Member process | System prompt for role |
| `TEAM_SESSION_DIR` | Member process | Session file storage path (`sessions/<team-name>/<sessionId>/<memberName>/`) |
| `TEAM_SHARED_CONTEXT_PATH` | Member process | Shared context file path (`sessions/<team-name>/<sessionId>/.shared-context.md`) |

## Commands Reference

| Command | Description |
|---------|-------------|
| `/team create` | Natural language team creation via TL dialogue |
| `/team dynamic` | Dynamic team mode — TL designs team on the fly based on user requirements |
| `/team edit <name>` | Natural language team modification via TL dialogue; installs edit-mode widget (⟳ `onEditStart`/`onEditEnd` hooks) |
| `/team start <name>` | Start team session with a pre-defined YAML team, activate TL tools |
| `/team resume [标识\|--all]` | 恢复中断或已停止的团队会话：按 session.json 清单重建状态，成员以 `--continue` 带完整上下文重启。默认仅列当前目录（cwd）的会话，`--all` 显示全部（ADR-0004） |
| `/team stop` | Stop all members, deactivate TL tools（会话目录保留并标记 stopped，可用 /team resume 恢复；磁盘清理由 /team delete 负责） |
| `/team list` | List all team definitions |
| `/team show <name>` | Display team definition details |
| `/team done`             | Finish and exit current create or edit mode |
| `/team cancel`           | Alias for `/team done` (backward compatibility) |
| `/team delete <name>` | Delete a team definition (with confirmation) |
| `/team status` | Show active session + member process statuses |
| `/team setting` | Interactive settings menu — member default model (follow TL current model / fixed available model) + auto-compaction (toggle / percent & token thresholds / timeout). Also allowed during a session |
| `/team help` | Display usage help for all subcommands |

## TL Tools (registered + active only during team session)

> **例外（ADR-0003）**：`start_team_session` 在**扩展加载时注册**、会话外可见（见下表）；`stop_team_session` 会话作用域注册、仅自主会话激活。

| Tool | Description |
|------|-------------|
| `start_team_session(task)` | **加载时注册**（决策 #21 唯一例外）。agent 自主启动动态团队会话（`origin: "agent"`）：`task` 必填——自动置 Goal + 注入自主版设计阶段提示词。全程无确认门；读/分析自由（无派发管制守卫），代码写入仍归成员。已有活跃会话时返回错误。成员进程结构性无法调用（`TEAM_ROLE` 早退）。 |
| `stop_team_session()` | 结束 agent 自主会话（停成员、摘 widget、清理会话目录）。会话作用域注册，**仅自主会话出现在活跃工具集**；对 `origin: "user"` 的会话拒绝执行（手动会话归用户 `/team stop`）。与 `/team stop` 共享 `teardownTeamSession()`。 |

| Tool | Description |
|------|-------------|
| `write_shared_context(content)` | Write the team shared context to the session's `.shared-context.md` (overwrite). **Must be called before the first `start_member` — start_member is blocked until then.** Sets the session `sharedContextWritten` flag; direct `write`/`edit` of `.shared-context.md` is intercepted and redirected here. Call again to update, then notify members to re-read. |
| `add_dynamic_member(name, label, systemPrompt, model?)` | Register a member in `/team dynamic` mode. Name is the identifier, label is Chinese display name, systemPrompt is role definition. Only available in dynamic mode. |
| `set_goal(text, criteria)` | Set a session goal with verifiable completion criteria. The system will automatically re-trigger the TL with a reminder if it stops working before the goal is met. Call at the start of a task to prevent unnecessary mid-task interruptions. **可见性**：仅团队会话（`/team start`/`/team dynamic`）期间可见——`onSessionStart` 注册，`before_agent_start` 回合边界强制（见决策 #10）。 |
| `finish_goal()` | Mark the current goal as completed and stop the reminder system. Call when all goal criteria are met, or when an unresolvable blocker is encountered. |
| `start_member(name)` | Launch a Member's pi RPC process. In dynamic mode, the first call triggers the design→execution phase transition. |
| `stop_member(name)` | Gracefully terminate a Member process |
| `list_members()` | Show all member statuses |
| `get_member_log(name, lines?, maxContentLength?)` | Query Member's recent session via RPC. `maxContentLength` truncates each message content (default 200 chars). Truncation uses `slice(0, max-3) + "..."` so total length = maxContentLength. |
| `wait_and_get_member_status()` | 等待所有 member 空闲后查看所有 Member 的运行状态 (idle/working/crashed/stopped)。No parameters. 如果任何 member 仍在工作中会阻塞，和 team_send_and_wait 检测 all-idle 的方式相同。 |
| `team_send_and_wait({tasks: [{to, content}], nextSteps})` | Send message(s) to **one or more** team members and wait for ALL responses. tasks 支持批量发送到不同 member 实现并发执行。Waits until all targeted members reply or all become idle. Returns partial results if some members fail. nextSteps 在 wait 结束后随结果返回。
>
> **批屏障（统一开始）**：多 task 批次（tasks.length > 1）中若有成员需自动压缩，整批 prompt 在**最后一个需要的压缩完成后才统一派发**——一个都不先跑（压缩完成后任务间仍并发执行）。屏障对 TL **完全静默**（TL 无需感知压缩屏障，只感知更长的等待），受批预算限制（默认 15 分钟，`/team setting` 可调，0=不限）。单任务批次与 autoCompact 关闭时完全走旧路径，零预检。
>
> **⚠️ `tasks` 必须是原始 JSON 数组，不要传 JSON 字符串。** LLM 有时会错误地将数组二次序列化（`"tasks": "[{...}]"`），这会导致框架校验失败。
> 工具参数 schema 已使用 `oneOf` 同时接受 `array` 和 `string` 类型，框架校验不会拦截。
> 工具内部已添加 `parseTasks()` 防御性解析，能自动处理字符串编码的数组和单对象包裹情况；严格 `JSON.parse` 失败时（输出截断、content 含裸换行）还会逐对象 salvage，恢复完整任务、丢弃截断尾部，并在结果前附恢复提示。
> - 原始数组 ✓：`"tasks": [{ "to": "planner", "content": "..." }]`
> - 字符串编码 ✗：`"tasks": "[{"to": "planner", ...}]"`（框架放行 + 自动 JSON.parse 恢复）
> - 单对象包裹 ✓（自动修正）：`"tasks": { "to": "planner", "content": "..." }`
> - 截断/含裸换行的字符串 ✓（salvage）：完整任务正常派发，丢弃的尾部会在结果中提醒
>
> **Batch vs Sequential 决策规则：**
> - **Batch**（多个 tasks[] 条目）→ 任务相互独立时使用。各 Member 同时工作，耗时 ≈ 最慢的单任务。
> - **Sequential**（逐个调用）→ 任务 B 依赖任务 A 的输出时使用。耗时 = 所有任务时间之和。
> - **混合策略**：先 batch A+B 并行，再 sequential C（依赖前序结果）。最高效。 |

## Design Time Tools (create/edit team)

These tools are dynamically registered and only available during their respective modes:
- `create_team_definition` — **only during `/team create`** (registered on enter, deactivated on cancel/success)
- `update_team_definition` — **only during `/team edit <name>`** (registered on enter, deactivated on cancel)

| Tool | Description |
|------|-------------|
| `create_team_definition` | Creates a new team YAML. Accepts full member data (name, label, systemPrompt, model) + optional workflow. Validates and writes to disk. |
| `update_team_definition` | Updates an existing team YAML. **Merge mode**: for unchanged members, TL may omit `systemPrompt` — value auto-fills from stored YAML. Omit a member from `members` to delete it. Workflow/defaults not provided preserve existing values. This avoids large payloads that could cause model output truncation. |

### Team Session Guards (Whitelist-based)

During an active team session (including `/team dynamic`), a `tool_call` event handler enforces tool restrictions using a **whitelist** (not a blocklist). Any tool not on the whitelist is blocked at runtime.

**Design phase whitelist (`DESIGN_PHASE_WHITELIST`):**
```
add_dynamic_member, start_member, stop_member, list_members,
get_member_log, wait_and_get_member_status, team_send_and_wait,
set_goal, finish_goal, write_shared_context,
start_team_session, stop_team_session,   ← ADR-0003（重入报错/放弃委派）
read (unrestricted),
write (only .md files — checked per-call)
```

**Execution phase whitelist (`EXECUTION_PHASE_WHITELIST`):**
```
start_member, stop_member, list_members, get_member_log,
wait_and_get_member_status, team_send_and_wait,
set_goal, finish_goal, add_dynamic_member, write_shared_context,
start_team_session, stop_team_session,   ← ADR-0003
read, bash, web_search, fetch_content, get_search_content,
write, edit (both only .md files — checked per-call),
ctx_search, ctx_stats, ctx_doctor, ctx_insight,
ctx_index, ctx_fetch_and_index,
true_sight_search, true_sight_get_facts, true_sight_filter,
true_sight_related, true_sight_graph_viz, true_sight_report,
true_sight_coverage, true_sight_validate, true_sight_review,
true_sight_synthesize, true_sight_ingest,
true_sight_diff_impact, true_sight_verify_evidence
```

Key points:
- **No more blocklist gaps** — tools like `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `mcp`, `ctx_upgrade` are NOT on either whitelist, so they're automatically blocked. No need to manually track every tool that could write files.
- **`write`/`edit` are on both whitelists** — but an additional per-call check restricts them to `.md` files only.
- **`.shared-context.md` 专属拦截** — `write`/`edit` 的目标若是 `.shared-context.md`，无论哪个阶段都会被 block 并重定向到 `write_shared_context` 工具（保证 start_member 门控标记准确）。
- **TL 预派发守卫（执行阶段）** — `read`/`bash`/`web_search` 等虽在白名单中，但 `src/session/tl-read-guard.ts` 会对"turn 内未派发任务且非管理工具调用超过 3 次"的情况**持续拦截**（sticky block）：派发前每次非管理工具调用都被 block（首次含用户可见通知），直到 `team_send_and_wait` 发生。防止 TL 亲自分析代码而不派发，且无法用 grep/rg 绕过。详见 DESIGN.md。**仅 `origin: "user"` 会话生效**——自主会话（ADR-0003）移除此守卫与设计阶段 read 软限制（读与分析自由，代码写入守卫不变）。
- The design phase whitelist lifts to the execution phase whitelist on the first `start_member` call.

The design phase guard is active from the moment `/team dynamic` is entered. It lifts when the first `start_member` call succeeds, transitioning to the execution phase.

### Dynamic Mode Flow

```
/team dynamic
  → mkdir sessions/_dynamic_<ts>/
  → startSession({name:"_dynamic_<ts>", members:[]})
  → isDynamicSession = true
  → dynamicPhase = "design"
  → 激活 TL 工具 + 设计阶段严格守卫 + widget（显示"设计阶段"）
  → 注入设计阶段提示词

═══ 设计阶段（TL 被阻断：仅允许管理工具 + read（软限制）+ .md 写入，其余工具被白名单拦截）═══

TL 按编排方法论 Playbook（orchestration-playbook.md，注入设计阶段提示词）推进六阶段：
  A. 需求对齐 — grilling 式逐个问题深挖（目标/范围/验收标准/约束/非目标）
  B. 任务拆分 — 按交付物拆，画依赖图，标注输入/输出/验收标准
  C. 工作流编排与质量加固 — 识别薄弱环节，选用交叉验证/对抗辩论/开发-审核循环等模式
  D. 团队设计 — 从工作流推导角色
  E. 方案确认门 — 展示完整计划书；用户明确确认前禁止 add_dynamic_member / start_member
  F. 落地执行 — 注册成员、写 shared-context、启动成员

TL: add_dynamic_member({name, label, systemPrompt, model?})
  → addMemberToSession() 刷新 currentSession
  → router / widget 更新

TL: write_shared_context(content)（团队成员、术语、工作流、协作规则）
  → 写入 .shared-context.md + 置位 sharedContextWritten
  → 此前调用 start_member 会被工具层拦截

═══ 阶段门：start_member 首次调用自动进入执行阶段 ═══

TL: start_member("coder")
  → buildMemberConfig 从 session 找到成员
  → 创建进程
  → onDynamicPhaseTransition() → dynamicPhase = "execution"
  → 设计阶段守卫解除，恢复工具权限
  → 下次 before_agent_start 注入执行阶段提示词

═══ 执行阶段（标准团队会话守卫）═══

TL: team_send_and_wait(...)
  → 消息通道正常流转

TL: 监控进展、协调异常、write_shared_context 更新共享上下文（更新后通知成员重新阅读）

/team stop
  → stopAll() → rm -rf sessions/_dynamic_<ts>/ → endSession() → dynamicPhase = "design"
```


### Escape (中断) 处理

当用户在团队会话期间按下 Escape（`app.interrupt`），pi 会取消 TL 当前的 LLM 回合。但成员进程（独立的 `pi --mode rpc` 子进程）会继续在后台运行。

`agent_settled` 事件处理器（位于 `index.ts`）负责检测这种情况并提醒用户：

1. **Escape 按下 + 成员仍在运行**（`ctx.signal?.aborted === true`）：
   - 在 TUI 底部状态栏设置醒目的警告：`⚠️ N 个成员仍在运行 — 使用 /team stop 结束会话`
   - 通过 `ctx.ui.notify()` 显示一条浮动通知
   - 不会自动停止成员进程（避免中断正在进行的工作）

2. **TL 正常结束 + 成员仍在运行**：
   - 在状态栏显示一条柔和的提示：`团队成员运行中 — 使用 /team stop 结束会话`
   - 不显示弹出通知

3. **所有成员停止后**：
   - 自动清除状态栏

用户可以在看到提醒后选择：
- 输入新消息让 TL 继续派发任务
- 使用 `/team stop` 结束整个团队会话
- 不处理，让成员在后台自行运行

## ADRs

- `docs/adr/0001-members-as-independent-pi-rpc-processes.md` — Core architecture
- `docs/adr/0002-tl-as-central-message-router.md` — Message channel design
- `docs/adr/0003-agent-initiated-team-sessions.md` — Agent-initiated sessions via load-time `start_team_session`
- `docs/adr/0004-team-session-resume.md` — Team session resume: member session persistence + manifest + /team resume

## Design Document

See [DESIGN.md](./DESIGN.md) for the full design specification (16 sections).
