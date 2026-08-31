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
  ├── 14 subcommands (/team create, dynamic, edit, done, cancel, start, stop, resume, list, show, delete, status, setting, help)
  ├── TL tools：load-time `start_team_session`；9 个 session-scoped 工具首次会话按需注册、会话期间激活（teardown 后 registry 保留，会话外从 activeTools 移除）；agent session 激活 `stop_team_session`，dynamic mode 提供 `add_dynamic_member`

Batch send: team_send_and_wait now supports tasks array for concurrent dispatch to multiple members. Previously single-target to/content/nextSteps; now unified tasks:[{to, content}] + nextSteps. **Batch when tasks are independent (parallel execution); sequential when task B depends on task A's output. See TL Tools table for decision rules.**
  ├── Message channel (queue → router → responseWaiter)
  ├── Activity display layer (activity-tracker: 纯函数细粒度阶段状态，与 memberOpsStates 并行不互写；onMemberActivity 多播 → Inspector + tracker + widget)
  ├── Member Process Manager
  │     ├── Member A (pi --mode rpc, member.ts)
  │     ├── Member B (pi --mode rpc, member.ts)
  │     └── Member C (pi --mode rpc, member.ts)
  └── Team mode UI widget (live member status + context usage %, above editor)
      └── 事件驱动刷新：N1 双层渲染去重（签名过滤 + styled 行闸门）→ 合并节流 120ms+自适应退避
```

**Key files:**

| File | Role |
|------|------|
| `index.ts` (~400 lines) | TL extension entry point. Registers `/team` command, wires DI dependencies, `before_agent_start` injection, team-status + edit-mode widget lifecycle, autocomplete provider, `agent_settled` interrupt handler (Esc detection with member-running notification). Refactored from ~800 lines via modular extraction. |
| `member.ts` | Member extension entry point. Registers `team_send_message` tool, injects team awareness via env vars. Uses `JSON.parse` for TEAM_MEMBERS (no longer comma-delimited). |
| `package.json` | pi package manifest with `pi.extensions` pointing to `["./index.ts", "./member.ts"]`; includes `check:goal-reminder` release scan |
| `scripts/check-goal-reminder.mjs` | Stage 3 static guard for settled-boundary, first-user marker correlation, API-only cooldown, legacy wording, reminder finish_goal-first decision structure, and closing-protocol injection across all three prompt variants |

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
│   │   ├── setting-handler.ts   ← /team setting 交互式设置菜单（成员默认模型 + 自动压缩 + 等待上限）
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
│   ├── tl-wait-gate.ts     ← S3 等待期缓冲门控（决策 #39）：team_send_and_wait 在飞时 member→TL 非回复消息入缓冲，all-idle 门控打开时经 steer 即时注入（纯状态）
│   ├── auto-compact.ts    ← Shared Auto-Compaction runtime (primitives + pending/flush)
│   ├── message-coalescer.ts ← S1 合并运行时（决策 #37）：per-receiver 桶 + 前缀上限 + flusher 钩子（纯状态，派发由 createSendToMember 注入）
│   ├── message-coalescer.test.ts ← 前缀选择/上限降级/drain/flusher 生命周期（14 例）
│   ├── activity-tracker.ts  ← 细粒度活动状态纯函数层（阶段 1 + v2 简化）：ActivityPhase/MemberActivity、applyActivityEvent()/derivePhase()/createActivityTracker()；N5 硬性 O(1) 纪律（零 import、零字符串构建）+ v2 删 toolName/phaseSince（仅 icon+label+百分比）
│   ├── activity-tracker.test.ts ← 转换表全映射/多流优先级/陈旧判定边界/agent_end 丢弃门/N5 纪律静态锁定（44 例）
│   └── event-handler.ts    ← Member RPC event handler (state machine, dedup, routing; N4 调用点隔离)；S1 接线：入桶判定 + agent_end flush + compaction_end 后 flush + process_exit drain（决策 #37）
├── process/          ← Member process lifecycle
│   ├── member-process.ts  ← pi --mode rpc spawn wrapper (write queue, size guard)
│   └── manager.ts    ← Multi-member lifecycle + operational state + auto-restart
├── tools/
│   ├── tl-tools.ts   ← 6 TL process management tools (Deps-based DI)
│   ├── goal-tools.ts  ← Goal system: set_goal/finish_goal + settled-boundary reminder delivery
│   ├── goal-tools.test.ts  ← Lifecycle, rollover, abort, cooldown, failure, and marker unit tests
│   ├── goal-tools.agent-session.test.ts  ← Real pi 0.83.0 AgentSession lifecycle/void-wrapper integration tests
│   ├── agent-session-tools.ts ← start_team_session（加载时注册，ADR-0003 例外）+ stop_team_session（会话作用域，仅自主会话激活）
│   ├── agent-session-tool-names.ts ← 工具名常量（叶子模块，防循环依赖）
│   ├── session-tool-visibility.ts ← 会话工具可见性强制（纯函数）：9 个团队会话工具首次会话按需注册、会话期间激活，teardown 后 registry 保留、会话外从 activeTools 移除；before_agent_start 回合边界强制执行；AGENT_SESSION_TOOL_NAMES 按 origin 条件激活
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
│   ├── goal-closing-protocol.ts ← 共享「强制 Goal 关闭协议」提示词片段（预定义/dynamic/agent-initiated 三模式复用防漂移）
│   ├── workflow-prompt.ts ← 预定义团队的工作流提示词构建（纯函数）：激活横幅 + 操作型执行协议，替代旧内联描述性注入
│   ├── workflow-prompt.test.ts ← 工作流提示词测试
│   ├── orchestration-playbook.md  ← TL 编排方法论：需求对齐(grilling)/任务拆分/质量加固模式库/确认门，注入设计阶段提示词
│   └── dynamic-mode.test.ts  ← 动态模式提示词测试
├── setup/            ← Modular extracted setup modules
│   ├── member-lifecycle.ts  ← createAndRegisterMember, buildMemberConfig, getMemberLog
│   ├── message-channel.ts   ← createMessageChannel factory (queue+router+waiter wiring)；sendToTl 以 deliverAs:"nextTurn" 注入成员→TL 消息（S2 阶段 1，决策 #36；S3 修正：team_send_and_wait 等待期间改入 tlWaitGate 缓冲，门控打开时 steer 即时注入，决策 #39）；创建共享 coalescer 实例（S1 阶段 2，决策 #37）
│   ├── dynamic-session-bootstrap.ts ← 动态会话共享 bootstrap（/team dynamic 与 start_team_session 复用）+ ensureAddDynamicMemberTool
├── settings/         ← Global settings (/team setting)
│   ├── settings.ts        ← TeamSettings type + <rootDir>/settings.yaml read/write
│   ├── resolve-model.ts   ← Pure function: member model precedence resolution
│   ├── resolve-thinking.ts ← 纯函数：成员思考强度解析（支持集复刻 pi-ai getSupportedThinkingLevels + 支持→传 --thinking / 不支持→保持默认）
│   ├── resolve-auto-compact.ts ← Pure functions: auto-compaction resolution + threshold check + menu label
│   ├── resolve-message-coalescing.ts ← 纯函数：消息合并设置解析（enabled + 上限回退默认）与菜单标签
│   └── resolve-wait-timeout.ts ← Pure functions: 顶层通用等待预算 waitTimeoutMinutes（wait 工具 all-idle deadline + 批屏障共享，独立于自动压缩）
├── ui/               ← TUI components for team mode
│   ├── team-status-widget.ts  ← Bordered widget: live member status + context %；阶段 2 实时化 + v2 简化：细粒度阶段渲染（💭×2/🔧×2/✏️/✅——working 与 thinking 同 💭 靠颜色区分（默认 vs accent），无耗时无工具名）+ N1 双层渲染去重（调度侧签名 logical|phase + 渲染侧 styled 行比较闸门）+ N2 轮询完成保留 refresh + N3 轮询并行化 + 合并节流（120ms + nextStreamFlushDelay 自适应退避，上限 1s）
│   ├── team-status-widget.test.ts ← widget 单测：徽标/截断/overlay 优先级/时长格式/N1 双闸门（颜色盲区 B1）/S1 进程死亡强制调度/定时器清理
│   ├── team-status-widget.integration.test.ts ← 集成测试：mock 成员 RPC 事件注入断言 setWidget 内容；N2 轮询闭环/N3 并行化/N6 风暴护栏 + P3 + 单帧成本实测留档
│   ├── edit-mode-widget.ts   ← Bordered widget: ✏️ EDIT MODE — <team name>
│   ├── create-mode-widget.ts ← Bordered widget: 🆕 CREATE MODE
│   ├── scroll-select.ts      ← Scrollable + filterable select dialog (ctx.ui.custom, maxVisible window + fuzzy search)
│   ├── member-inspector.ts   ← Member Inspector overlay (alt+t): tabs, conversation view, input box, footer
│   ├── member-inspector-state.ts  ← Inspector pure display state + line building (no TUI deps)
│   ├── pi-key-decode.ts      ← decodePrintableKey 本地实现（decodeKittyPrintable 主入口导入 + modifyOtherKeys 回退按上游 keys.js 复刻；不能深导入 pi-tui/dist/keys.js——loader jiti alias 前缀替换会拼坏子路径，见 DESIGN.md §17）
│   └── pi-key-decode.test.ts ← 本地解码器单元测试（kitty CSI-u / modifyOtherKeys / legacy 三协议 + 修饰拒绝 + Caps Lock 掩码）
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

8. **Dynamic team mode (`/team dynamic`)** — A free-form mode where the TL designs the team at runtime. No YAML is written to disk. The TL enters a session with 0 members, discusses requirements with the user, uses `add_dynamic_member` to register member roles, then starts and dispatches them via the standard tool chain. The session guard blocks code file writes from the moment `/team dynamic` is entered. Session data is retained in `sessions/_dynamic_<ts>/` after stop so it can be resumed; `/team delete` is the explicit disk cleanup path.

9. **Session isolation via sessionId** — Each team session generates a unique `sessionId` in `TeamSessionState`. `buildMemberConfig` uses this ID to nest session data under `sessions/<team-name>/<sessionId>/` instead of the flat `sessions/<team-name>/`. This prevents conflicts when the same pre-defined team is used across multiple sessions. `/team stop` and `session_shutdown` preserve the session directory and mark its manifest stopped/interrupted for `/team resume`; `/team delete` performs explicit disk cleanup. Dynamic mode sessions (`_dynamic_<ts>`) use their unique team name for the same isolation and resume semantics.

10. **Goal system for TL autonomy** — `src/tools/goal-tools.ts` registers `set_goal` and `finish_goal` tools plus lifecycle handlers. A low-level `agent_end` only records the current run's candidate; `agent_settled` is the sole reminder delivery boundary, and its one-shot `setTimeout(0)` is only a listener re-entry barrier. Run state carries a stable `runId`, signal set, session ID/epoch, goal generation, abort state, settled state, first-user-prompt association, candidate, and one-shot suppression for a confirmed reminder continuation. A team session activated **mid-run** by `start_team_session` (the origin run's identity snapshot predates the session) records `sessionActivatedMidRun`/`activatedSessionId`/`activatedSessionEpoch` in `currentSessionIdentity()`, so the run that created the session can still produce a candidate at `agent_end`; switches between already-active sessions never set this (rollover protection preserved). Retry, compaction, and queued continuations reuse the outer run until settlement. The dispatch timer revalidates session/goal identity, completion, abort state, settled state, and `ctx.isIdle()`; busy contexts retain the candidate and never receive a queued reminder.
   - **Cooldown** is anchored exactly once immediately before `pi.sendUserMessage`; matching ACKs never refresh `lastReminder.at`.
   - **Fire-and-forget correlation** uses the complete hidden HTML marker in `before_agent_start`; `agent_start` without a prompt is never an ACK. A void/no-ACK watchdog only reports uncertainty and never retries; observable sync/Promise failures restore the candidate.
   - **Rollover isolation** captures live markers across session or goal-generation changes. The exact marker map is keyed by marker ID, capped at 64 unresolved entries, and stores only numeric identity metadata. A captured marker is stale only after its own `before_agent_start` is observed; `message_start` then examines only the first `role === "user"` prompt. Assistant/tool-result text, later user messages, consumed historical IDs, and unrelated markers cannot suppress or abort a fresh run.
   - A confirmed reminder continuation is suppressed once so it cannot generate a second candidate. `finish_goal`, reset/teardown, abort, and session changes invalidate candidates; `session_shutdown` clears timers, submissions, and rollover quarantine. The marker protocol is confirmation/de-duplication protection, not an independent retry watchdog.
   - **提醒正文决策结构与强制关闭协议**：`buildReminderText` 不再断言实际工作「尚未完成」——仅说明「Goal 仍处于激活状态（尚未调用 `finish_goal`）」，并要求以完成条件逐条核对后「执行下列唯一匹配的分支」。决策分支：① 全部完成条件已满足 → 调用 `finish_goal`、不要再派发；② 不可解决阻塞 → 调用 `finish_goal` 并告知用户；③ 需用户提供关键信息或做决策才能继续 → 提出一个具体问题并等待、不要调用 `finish_goal`；④ 仅当确有未满足条件且可继续时才 `team_send_and_wait` 派发下一轮。三模式 TL 提示词（预定义 index / dynamic design+execution / agent-initiated）统一注入共享的 `GOAL_CLOSING_PROTOCOL_PROMPT`（`src/prompts/goal-closing-protocol.ts`，单一事实来源防漂移，调用处直接注入不重复前缀）；**收尾顺序统一为「汇总并验证（不结束回合）→ 立即 finish_goal → 向用户最终汇报」**（finish_goal 置于最终汇报之前，防弱模型汇报后直接结束回合）；dynamic 工具列表补齐 `set_goal`/`finish_goal`。`finish_goal` 的 promptSnippet 与 promptGuidelines 区分于 `set_goal`（Finish 语义 + 仅当条件未满足且仍可推进时不得调用 + 仅口头宣称不算关闭）。生命周期通知措辞统一为「Goal 仍处于激活状态（尚未关闭）」，避免「未完成」认知偏置。
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

14. **Member Inspector (成员检视浮窗)** — During an active Team Session, the user can press `alt+t` to open a full-keyboard overlay (`ctx.ui.custom` with `overlay: true`, 90%×85%) showing a horizontal tab per Member, the selected Member's live conversation, and a footer with operational states + context % + key hints. Refresh is event-driven: `EventHandlerDeps.onMemberActivity` passes the **full member RPC event** (`memberName, event`) and a throttled (500ms) RPC `get_messages` refetch rebuilds display lines. **Streaming (thinking/text/toolcall) has a dedicated local path**: RPC-mode `message_update` events carry deltas only (cumulative `partial` stripped on the wire) and `get_messages` excludes the in-progress message — so `MemberInspectorState` assembles a live partial assistant message from `message_start`/`message_update` deltas (`applyAssistantDelta`, contentIndex-keyed, toolcall raw JSON finalized at `toolcall_end`) and `flushStreaming` rebuilds the live tail locally at an adaptive cadence (100ms baseline, backs off to 1s under heavy rebuild cost via `nextStreamFlushDelay` hysteresis; zero RPC traffic per delta; incremental-cache streaming-tail fast path). **P2 streaming-tail perf**: with `t` on, thinking content is huge and grows by appends — the tail rebuild uses `wrapAppendOnly` (WeakMap per block object, wraps only the new delta, byte-identical to `wrapText` incl. grapheme clusters split across deltas), so a flush is O(Δ) instead of re-wrapping the whole block (was O(T) per flush → O(T²) per stream, the thinking-toggle CPU spike); and only the ACTIVE tab's tail is rebuilt per flush (N concurrently streaming members don't multiply the cost — inactive tabs catch up on tab switch or via the refetch path). `message_end` moves the authoritative message into per-tab `pendingCompletions` (rendered after fetched history — no end-of-message flicker) until the refetch confirms it via `reconcilePending` (content equality, tolerates interleaved toolResult messages). `agent_end` clears the live tail. Rendering: user/assistant text in full, tool calls/results as one-line summaries with an `e` expansion toggle, thinking blocks hidden by default with a `t` visibility toggle (with `t` on, thinking streams line-by-line), virtual scroll. **`e`/`t` are GLOBAL view-mode toggles** (not per-member): one keypress flips ALL member tabs — running tabs rebuild via the RPC refetch, stopped/crashed tabs with a history cache rebuild locally with zero RPC (`rebuildTabFromCache`), and members added later (dynamic mode) structurally inherit the current global values (single source of truth on `MemberInspectorState`, no per-tab fields). The user can message a Member directly (input box: Enter = `prompt`/`follow_up`, `Ctrl+Enter`/`Alt+Enter` = `steer` — **Ctrl+Enter 依赖终端协议**（kitty CSI-u / modifyOtherKeys），legacy 终端两者同字节无法区分，**Alt+Enter 是协议无关的 steer 路径**；`/...` sent raw for member-side command resolution) and run control commands (`ctrl+a` abort active member, `ctrl+b`/`ctrl+shift+a` abort ALL executing members in one shot — `ctrl+shift+a` needs Kitty keyboard protocol, `ctrl+b` works on all terminals; `ctrl+o` compact — NOT ctrl+m, which is indistinguishable from Enter in terminals). Direct messages are prefixed `[用户直接指令（非 TL）]:` so the Member can distinguish the source. **User interventions are NOT mirrored into the TL session** — the TL only learns about them indirectly (via member replies or `get_member_log`). `/team stop` auto-closes the overlay. See DESIGN.md §17. **输入键位协议纪律（场景 K/L 双根因，详见 DESIGN.md §17）**：字符插入路径必须经 `decodePrintableKey`（与 pi 主输入框 editor.js 一致；**本地实现 `src/ui/pi-key-decode.ts`**——主 index 仅 re-export `decodeKittyPrintable`，且深导入 `@earendil-works/pi-tui/dist/keys.js` 会被扩展加载器（loader.js）的 jiti alias 前缀替换拼坏（→ `dist/index.js/dist/keys.js`，扩展整体加载失败，2025 实测根因，见 DESIGN.md §17）——故 modifyOtherKeys 回退按上游 keys.js 原样复刻本地，0.83.0/0.84.2 diff 验证一致）——kitty 协议激活时所有按键均为 CSI-u，不解码则文字进不去、Ctrl+Enter 空发送静默关闭；Ctrl+Enter 在 legacy 终端与 Enter 同字节 `\r`，任何回退都会误触发 steer（原理不可能），故双绑定 Alt+Enter 作为协议无关路径；Enter 判断含字面 `\n` 兜底（kitty 激活后 pi-tui 不再将 `\n` 识别为 enter，LF 混合终端吞键），必须位于任何未来 ctrl+j 分支之后；已知失效窗口（macOS Option 未设 Meta / Windows 系统级 Alt+Enter / kitty 激活 alt 走 legacy 前缀）均 fail-safe——Enter 永远可发送；空文本与无成员发送均显式 notice（「输入为空」/「✗ 无成员可发送」）不再静默。

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
   - **批屏障（阶段 3）**: `sendAndWaitExecute` 在 enqueue 之前运行批预检（tasks.length > 1 且 autoCompact 启用才启用）。【不变式 E1】整个屏障（WAIT + stats + 串行压缩）在 corrId 注册与 enqueue **之前**完成——屏障期不存在任何 wait 检测，all-idle 误释放不可能（顺序硬编码 + 测试锁定：压缩完成前 messageQueue 长度为 0）。流程：`planBatchCompaction`（纯函数：idle→查 stats / compacting→待等集合，不重复发 compact / 其他→跳过）→ 并行 stats（本地 RPC）→ 需压缩集合 **串行** compact（同一时刻至多一个 compact RPC，无 PD 分离下并发压缩=并发 prefill）→ per-member fail-open（失败者带 skip 随批派发、其余继续）→ maxWait 批预算（顶层 `waitTimeoutMinutes`，默认 15 分钟，0=不限，与 wait 工具兜底 deadline 共享）超预算停止**未开始的**压缩整批派发（在飞 compact RPC 跑满自身 timeout 后才停，属预期） → COMMIT 注册全部 corrId 并 enqueue，`skipAutoCompact: true` **仅加给实际执行过压缩尝试的成员**（成功或失败均算）。可见性：屏障对 TL **完全静默**（[批屏障] 通知已移除）——TL 只感知更长的等待时间，不感知屏障内部过程（压缩等待/开始/失败/超预算均不通知；失败与超预算由内联路径的既有通知兜底）。单任务/关闭路径完全原路径零预检（E9）。待等集合的释放条件为"非 compacting"（idle/crashed/stopped 均放行——toWait 成员崩溃或 /team stop 后压缩已无意义，不得挂起到超时）。

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

21. **会话工具只在会话期间注册（session-scoped registration）** — 全部 9 个团队会话工具（6 个 TL 进程管理工具 + `write_shared_context` + `set_goal`/`finish_goal`）**不在扩展加载时注册**，而是由 `index.ts` 的 `ensureSessionToolsRegistered()`（内部用 `ensureToolRegistered` 幂等去重）在 `onSessionStart`（`/team start` 与 `/team dynamic` 共用，置于 widget 守卫之前）按需注册；`before_agent_start` 回合边界经 `enforceSessionToolVisibility()`（`src/session/session-tool-visibility.ts`，纯函数 + DI，`SESSION_TOOL_NAMES` 与 `teamCtx.tlToolNames` 同源）强制注册+激活/停用不变式。效果：**fresh pi 初始 registry 为空；已有进程在会话外 registry 仍保留，但 `activeTools` 不含这些工具（因此不可见/不可调用）**；`dynamic-handler` 先 `onSessionStart` 注册再 `setActiveTools` 激活（不依赖 pi 的 registerTool 自动激活行为）。模式工具（`create_team_definition`/`update_team_definition`/`add_dynamic_member`）维持各自的按需注册生命周期，不在本强制范围内。**唯一刻意例外**：`start_team_session` 在加载时注册（见决策 #22）。

22. **Agent 自主会话（agent-initiated team sessions，ADR-0003）** — `start_team_session(task)` 在**扩展加载时注册**（决策 #21 的唯一例外），agent 可随时自主进入动态团队会话委派复杂任务。核心设计哲学：**会话来源（`origin: "user" | "agent"`，`TeamSessionState.origin`）决定守卫强度**——手动会话 = 用户期望「以团队方式做事」，全守卫；自主会话 = agent 自己的手段选择，用户只要结果，故移除派发管制（tl-read-guard、设计 read 软限制、第一动作协议）**与写入管制（ADR-0003 修订，见 docs/adr/0003）**：设计+执行两阶段工具面与普通模式一致（write/edit 任意扩展名、bash、ctx_execute 等全部放行，早退分支在阶段/白名单解析之前生效），仅保留 `.shared-context.md` 必须经 `write_shared_context` 写入的机制契约（start_member 硬门控依赖其置位标记）。放开理由（三路论据）：写守卫是策略而非硬不变量（成员-成员并发写从未被管制）；守卫从未消除覆盖风险、只缩小重叠面；守卫在 agent 会话已被 bash 旁路事实绕过——放开是收敛回正规工具、更可观测。残余风险（低-中）由提示词写纪律（编辑前确认无成员处理同一文件 + 修改后通知重读重验）+ git 可恢复 + TL 回合挂起语义缓解。完全自主：无 Playbook grilling、无确认门；`task` 必填并自动置 Goal + 注入自主版提示词（`src/prompts/agent-initiated-mode.ts`）。生命周期对称：`stop_team_session` 由 agent 自主终结会话——会话作用域注册但**仅自主会话激活**（`AGENT_SESSION_TOOL_NAMES` 条件可见性），与 `/team stop` 共享 `src/session/teardown.ts`。嵌套结构性不可能（`TEAM_ROLE` 早退）；重入返回错误。可见性：启动 notify（🤖 + task 摘要）+ widget 持久来源标记（🤖/👤）。预定义团队支持明确推迟（dynamic-only 先行）。

23. **团队会话恢复（/team resume，ADR-0004）** — 四层设计：(a) **member 会话落盘**：移除 spawn 参数中的 `--no-session false`（pi 的 `--no-session` 是裸布尔 flag，该写法曾使 member 纯内存运行、上下文从不落盘——根因 bug）；pi session 增量 append，崩溃仅丢最后半条。(b) **重启即续接**：`MemberProcessConfig.resume` + `buildMemberConfig` 自动探测（session 目录有 `.jsonl` 则 `--continue`）+ 进程内 `startedOnce`（崩溃 auto-restart 自动续接）；`hasSessionFiles` 守卫空目录。(c) **会话清单**：`sessions/<team>/<sessionId>/session.json` 持久化名册（动态团队唯一磁盘副本）/origin/phase/Goal/sharedContextWritten/startedMembers/memberPids，所有状态变更点合并写（tmp+rename 原子，fail-open）。(d) **停止即保留**：`/team stop`/`session_shutdown` 不再 rmSync，manifest 标记 `stopped` 或保留 `active`（中断语义）；`session_start` 检测到中断会话时状态栏提示。`/team resume` 以原 sessionId 重建状态、`--continue` 重启成员（上下文完整恢复）、/proc 校验后清理孤儿进程；中断时进行中的任务不重放，由 TL 确认状态后重建编排。会话列表按 **cwd 项目作用域**过滤（对齐 `pi --resume`：manifest 记录创建时的 cwd，默认只列当前目录会话，`--all` 显示全部并附目录标注）。多会话选择器用 `src/ui/scroll-select.ts`（maxVisible 滚动窗口 + 模糊筛选）——内置 `ctx.ui.select` 全量渲染不滚动，会话多时溢出屏幕（与模型选择器同因）。

24. **会话结束一次性提醒（session-ended banner）** — 用户 `/team stop`（或 agent 调 `stop_team_session`）后，TL 的对话历史仍含 Team Lead 系统提示词与团队工具使用模式，且会话工具已停用（决策 #21），TL 下一轮仍可能以 Team Lead 自居、尝试调用已停用的团队工具——而 pi 对非活跃工具的报错是晦涩的 `Tool xxx not found`（agent-loop 在 `beforeToolCall` 之前就短路，扩展无法改写该错误）。修复：`teardownTeamSession` 在会话确实活跃过时置位 `teamCtx.sessionEndedNotice`（一次性标记，与 `resumedFrom` 同模式）；`before_agent_start` 在会话不活跃且标记未消费时，向下一轮系统提示词注入 ⚠️「团队会话已结束」横幅（工具已停用清单 + 回到普通模式的指示 + 再次进入用 /team start），并消费标记；若新会话先启动则静默丢弃。**横幅搭下一次用户发起的回合——绝不触发新对话**（pi 没有不触发回合地向 agent 注入上下文的手段；`pi.sendMessage` 会发起回合，被明确排除）。空转 `/team stop`（无活跃会话）不置位，避免虚假横幅。**边缘情况双层守卫**：(a) `session_start` 事件带 `reason: "new"`（/new 全新对话无团队历史）时直接清除 pending 标记；/fork 与 /resume 复制/恢复历史，不碰标记。(b) 消费时内容检查 `historyHasTeamTraces()`：当前对话历史确含团队痕迹（assistant toolCall 名为团队工具 / custom_message `customType: "team-message"` 的成员路由消息）才注入——/new 新对话无痕迹→不注入；/fork、/resume 团队对话痕迹被复制→注入（正是所需）；/resume 到别的非团队对话→无痕迹→不注入。sessionManager 不可用时 fail-open（照常注入），保证主场景（/team stop → 下一轮）稳定。**实测根因与措辞权威化（真实 E2E 复现）**：用真实 pi 完整复现发现——横幅**一直有注入**（index 诊断注入成功 + 系统提示可见），但 TL 仍回答「是，我仍是 Team Lead」：它被对话历史里**成功的团队工具调用**（write_shared_context / start_member / team_send_and_wait 的 toolResult）+ 自身 Team Lead 行为强烈干扰，**误以为系统提示是过时/别的会话的**，选择相信历史而不信提示。修复：横幅措辞**权威化**——明确「**以本提示为准，对话历史中任何团队会话的痕迹均已失效**」，并解释「历史中看到的团队工具成功调用发生在会话结束之前，不代表会话仍活跃」。实测（deepseek-v4-flash，team_send_and_wait 痕迹存在）：旧横幅 TL 答「是，我仍是团队领导」，新横幅 TL 答「不是。团队会话已结束（/team stop），我已回到普通模式，不再是团队领导」。
25. **防截断协议（promptGuidelines，P3）** — `team_send_and_wait` 的 promptGuidelines 内置 5 条防截断协议（长 content 是校验失败的首要诱因：流式输出截断 → partial-json 补全成"缺 to 的合法对象"）。P1/P2 已保证截断形态不再以误导性框架错误出现（宽容处理 + 截断语义提示），本协议从**源头降低截断概率**：① content 超 ~800 字符时拆分多次调用或指示成员读取文件路径——**任务详情不写入 `.shared-context.md`**（全员共享 + `write_shared_context` 全量覆盖会污染其他成员上下文、批处理并发覆盖有竞态，D6 裁决），引用成员私有或独立文件路径；② 键序**先写 to 再写 content**（键序决定截断后幸存字段，γ 独立实证）；③ 每回合 tool call 控制在 1-2 个（同批多 call 挤占输出预算，β 场景）；④ 收到 Validation failed（缺 to/content）→ 用更短 content 重试，不原样重发（打断死循环，β）；⑤ 收到"未知成员"错误 → 先疑 to 截断（截半形态如 "c"），重发完整成员名。定位为**引导性 best practice 而非强制架构**（γ）。
26. **细粒度活动状态显示层（activity-tracker，双状态机并行）** — 成员状态栏实时化：新增独立于 `memberOpsStates`（控制面）的**显示面**（`src/channel/activity-tracker.ts` 纯函数 + per-member Map，互不写入——控制面被 wait/all-idle/批屏障/auto-compact 强依赖，红线不动）。`onMemberActivity` 单播改**多播**（Inspector + tracker + widget；N4 每消费者独立 try/catch，event-handler 调用点再兜底——observer 抛错绝不中断状态机更新）。事件→流活跃标志→优先级推导（executing > tool-calling > output > thinking）；agent_start 置 thinking（D1）、message_end 清全部流落 working 绝不落 idle（D4，回合内多消息间隙不误报空闲）、agent_end 权威归零 idle（D9）；**防卡死三层兜底**：message_end 清流 → agent_end 归零 → 30s 陈旧判定（豁免 executing，惰性化于渲染时 derivePhase(state, now)）；agent_end 后旧 delta 丢弃门（`ended` 标记，未启动成员不受门控）；**P3**：process_exit/process_error 时 `tracker.delete(memberName)`（executing 豁免 stale 下崩溃成员必须清条目，auto-restart 后 agent_start 重建）+ 进程死亡**强制调度**渲染（S1：idle 成员崩溃签名不变时不再等 30s 轮询）。显示优先级：`compacting > crashed/stopped > 细粒度 phase > working 兜底 > idle`（进程级与压缩态以逻辑层为权威）；widget 渲染时 overlay，tracker 生命周期随 widget install/uninstall（防泄漏）。
27. **事件驱动渲染的性能纪律（N1-N6）** — 阶段 2 性能验收项全部落实：**N1 双层渲染去重**（收益最大）：调度侧 per-member 显示签名（logical+phase，未变不调度）+ 渲染侧 **styled 行比较闸门**（未变跳过 setWidget——setWidget 是上游全量重建+无条件 requestRender 的最大成本项；比较必须含颜色：raw 比较有颜色盲区（B1），styled 内嵌 raw 是稳健超集）。**N2**：轮询完成保留 refresh()（原方案"轮询不再承担刷新职责"表述修正——否则长无事件期百分比冻结、30s 陈旧判定无执行窗口）；渲染闸门把关使轮询 refresh 零额外成本。**N3**：轮询 `Promise.allSettled` 并行化（串行 for-await + 3s 超时最坏 3N s → ≤3s）+ abort 后不重排（修复 uninstall 期间定时器泄漏）。**N5**：tracker 事件路径硬性 O(1)（零 import、零字符串构建（v2 删 D10 截断后彻底为零）、被忽略事件返回同引用零分配，静态扫描测试锁定）。**N6**：性能护栏测试（8 成员 × 500 事件风暴：setWidget 有界 ≤100 且非零、tracker <50ms、uninstall 零定时器、单帧成本实测留档）。伪优化排除清单（P1-P13）与可选优化（O1-O4）定位见 DESIGN.md §20。
28. **v2 最终简化（用户确认，纯减法）** — 状态栏只保留 `图标 + label + 百分比`：working 兜底 💭（默认色，与 thinking 同 💭 靠颜色区分——默认 vs accent，styled 闸门捕获该颜色切换）、tool-calling 与 executing 均 🔧（warning，阶段保持结构区分、视觉不区分——tool-calling↔executing 切换 styled 相同被渲染闸门正确去重）、output ✏️（success）、thinking 💭（accent）、idle ✅、🗜️💥⏹️ overlay 不变、上下文百分比保留（D1 消解）。删：tracker `toolName`/`toolNameTruncated`/`phaseSince` 字段 + D10 截断 + P1/P2/A1 逻辑 + start/update 分支合并（无名字逻辑后同构）；widget `formatDuration`/时长/工具名渲染 + 签名简化为 `logical|phase`（事件路径不再读时钟）。节流/渲染闸门/轮询/防卡死/N6 护栏全部保留。**浮窗同步**：inspector `stateIcon()` working → 💭（footer 消费点，toolCall 摘要行 🔧 与 💭 标签语义一致不改）。**list_members 文本输出 working → 💦**（D5 用户裁决，独立保持不改）。**v2.1 图标微调**：output ✍️→💬、working 🧱→💦。**v2.2 图标微调（用户三次确认）**：working 兜底 💦→💭（默认色，与 thinking 💭 同图标——颜色是唯一区分，渲染闸门 styled 含颜色故正确捕获 working→thinking 双向切换）、output 💬→✏️（U+270F+U+FE0F emoji 变体，success 不变）；浮窗 stateIcon 同步 💭；list_members 保持 💦（未点名）。废弃：bugfix 方案（耗时/工具名显示修复、sticky）未实施零回滚，仅文档记录决策演变（见 DESIGN.md §20 修订变更摘要）；增强 A（时长微文案）与 D10 展示用途随 v2 废除；R1 次生症状（快速工具 <120ms 窗口吞没 executing）在 v2 下信息损失降为零（executing 与 tool-calling 视觉相同）。
29. **自动压缩超时事件驱动出口（Phase 1 止血）** — 修复「压缩超时→成员永久 working→wait 工具卡死」根因链的止血层（根治见 Phase 2 方案，未实施）：
    - **1.1 compaction_end 消费分支**（`src/channel/event-handler.ts`）：成员端 `compaction_end` 事件（无论成败必发，F7 盲区）是压缩生命周期的**权威心跳**——TL 端 `timeoutMinutes` 只是「停止主动等待」的租约，到期 ≠ 压缩失败。收到事件 → `autoCompact.endCompaction`（compacting→idle）→ `flushPending` 派发积压消息（→working→agent_end→idle 全链路）；此前发生过 compactNow 超时的场景通知 TL「压缩已于 N 分钟后结束，积压消息已自动补发」（正常路径静默）。超时痕迹由 runtime 新原语 `markCompactionTimeout`/`takeCompactionTimeout`（per-member Map，`compactNow` 在本地租约超时错误（`timed out`）时记录，非超时失败不记录——成员端已结算）承接，消费一次即清。**审查修订（重要）——在飞租约守卫**：成员端先 emit `compaction_end`、后写 compact 响应（agent-session.js → rpc-mode.js），故每次租约内成功的压缩，事件都会在 compactNow 响应前到达。runtime 新增在飞租约跟踪（`hasInFlightCompaction`/`markCompactionEndDuringLease`，compactNow 登记、settle 后清除），分支开头 `if (hasInFlightCompaction) return`——在飞期间由持有流程（内联 finally / 批屏障）负责退出与**按序**补发（当前消息 A 先、pending FIFO 后），杜绝顺序反转（B 先于 A）与双重压缩窗口（提前复位 idle 后亚毫秒窗口重派发→第二个 compact）。仅「无在飞租约」（超时后心跳）才执行 endCompaction+flush+通知。**near-miss 陈旧 mark 抑制（建议 1）**：心跳在租约在飞期间到达（压缩实际已完成、响应延迟过租约）→ 超时 catch 不记录 mark（`compactionEndDuringLease` 按租约起始时间戳校验），防止残留 mark 误报下一次压缩的「压缩已于 N 分钟后结束」。
    - **1.2 拒收分支状态纠正（get_state 判定，beta 形态）**：prompt 拒收分支（`success===false && id===undefined`）在 resolve+通知后追加 `get_state` 查询（3s 超时 fail-open，runtime 新原语 `queryCompactionState`，复用 queryStats 模式）——`isCompacting===true` → 置 `compacting`（状态机新事件 `compaction_confirmed`：working→compacting 纠正黑洞状态；出口由 1.1 提供；新消息经 sendToMember 的 compacting 分支自动入 pending → **双重压缩循环结构上消灭**）；`false` → 置 `idle`（`task_completed` 事件，纯函数纪律）；查询失败 → `idle`+通知（保守）。通知文案诚实化：删除「已直接派发任务」假陈述，改为「消息未送达（已丢失，请稍后重试）…已按实际状态恢复」。**审查修订（建议 2）——陈旧答案不覆盖新状态**：查询窗口（≤3s）内若真实回合开始（agent_start/agent_end）或进程退出（process_exit/process_error），handler 内 per-member `stateGeneration` 递增；纠正应用前校验「状态仍为拒收快照 + 代际未变」，否则跳过（陈旧 isCompacting=false 覆盖 running turn 为假 idle、或陈旧 true 覆盖新 prompt 为假 compacting 均被杜绝；查询失败路径同守）。`compaction_end` 刻意不计入代际：单管道 FIFO 下 **true 答案恒先于事件到达**（成员查询时仍在压缩 → 响应先于 compaction_end 写出），而 false 答案可能后至（查询时压缩已结束）——计入代际会误杀后至 false 的正常闭合路径，且会让已结算租约的心跳流程（endCompaction 对 working 是 no-op）困死在 working。
    - **1.3 waitForAllIdle deadline（防御纵深最后一道）**：`waitForAllIdle` 增加 deadline（默认 15 分钟，复用顶层 `waitTimeoutMinutes` 预算语义，0=不限保持现状；`resolveWaitIdleDeadlineMs` 解析）；到期返回**诊断结果**（`timedOut` + 疑似卡死成员清单 + 建议 stop_member / `/team stop` 后 `/team resume`）而非无限挂起——`wait_and_get_member_status` 与 `team_send_and_wait` 的 all-idle 等待门控（决策 #38）同时受益（后者 partial 结果追加诊断）；`setInterval` 加 `unref`（与批屏障 `waitForMembersIdle` 一致，Esc 中断后无轮询泄漏）；wait 结束后状态重读（输出反映 post-wait 现实，不再用 pre-wait 快照）。
    - **DI/接线**：`EventHandlerDeps` 新增 `autoCompact?`（共享 runtime）与 `memberHandles?`（get_state 查询 + flush 派发）；`MemberLifecycleDeps` 同步新增并转发；`index.ts` 注入。共享派发提取为模块级 `dispatchPromptToMember`（PromptDispatchDeps），内联路径与 compaction_end flush 路径同一套发送语义（working 标记 + followUp）。
    - **测试（37 个新用例，含审查修订 7 个）**：拒收分支状态恢复断言（compacting/idle/查询失败/无接线四态）、诚实文案、compaction_end 分支（正常静默/超时通知/无 runtime no-op/working 不动）、双重压缩防护（compacting 成员新消息入 pending→compaction_end flush，期间零 RPC）、状态机 `compaction_confirmed` 转换表、runtime 新原语、wait deadline 诊断/0=不限/unref 存在性、压缩超时→拒收→纠正→wait 正常返回回归；审查修订：在飞租约守卫集成用例（compaction_end 先于 compact 响应→A→B→C 顺序 + 窗口零二次压缩）、租约生命周期、near-miss 陈旧 mark 抑制、陈旧答案不覆盖（agent_start 窗口 skip×2）。
30. **自动压缩超时根治（Phase 2：事件驱动派发，三出口闭合）** — 依赖 Phase 1（#29）；根治「超时后仍派发必被拒收 → 消息丢失」：
    - **2.1 内联超时语义重定义**（`runAutoCompactAndDispatch`）：`CompactResult` 增加 `timedOut` 判别——租约超时 → **不再派发**，保持 `compacting`，消息经 `queueDuringStuckCompaction` 入 pending（心跳 flush）；非超时失败（成员端已结算）→ endCompaction+直接派发；成功路径时序不变。入队竞态闭合（alpha）：入队前状态已非 compacting → 直接派发。通知：`压缩超过 N 分钟未完成，任务已排队，将在压缩结束后自动派发`。
    - **2.2 轮询兜底 + 二次超时（三出口之②）**：runtime 原语 `waitCompactionIdle(name, handle, budgetMs)`（30s 轮询 get_state.isCompacting，3s 单次超时 fail-open 按已结束，预算 = timeoutMinutes 一租约周期，unref）；兜底 watcher（`startFallbackWatcher`，per-channel dedupe）仅对**无在飞租约**的 compacting 启动（内联超时分支 + sendToMember compacting 分支）——释放 → `closeCompactionAndFlush`（共享于心跳分支与兜底：消费 mark+endCompaction+flush+超时通知，幂等）；预算耗尽 → `abandonPendingMessages`（清空 pending+resolve 各 corrId [已放弃]+通知人工干预）；新租约守卫（结算时在飞 → 不 close/abandon，新周期持有流程接管）。四场景闭合：心跳/事件丢失/进程退出/永不结束。
    - **2.3 进程退出清 pending（三出口之③）**：process_exit/process_error/主动停止统一 `drainPendingOnProcessExit`——清 pending+resolve corrId（[消息未送达]）+静默消费超时 mark+通知概要（重启后重派）。
    - **2.4 批屏障接线 + attempted 语义修正（alpha P2）**：屏障超时 → 保持 compacting、不 endCompaction、**不计 attempt**（批消息 commit 后经 compacting 分支入 pending + 自动启动 watcher，等待计入 `waitTimeoutMinutes` 预算）；`skipAutoCompact` 仅绑定「压缩已结清」——compact 响应（成功/非超时失败）或 compaction_end（runtime 心跳计数 `markCompactionEnd`/`getCompactionEndCount`，屏障按等待期/循环期增量判定，toWait 成员同规则）→ 打标；超时未结清 → 不打标（等待流程接管，不再跳过压缩检查）。事件结清打标同时闭合 E12 竞态（屏障期间事件到达的成员被打标，杜绝 commit 后第二个压缩）。
    - **测试（17 新用例，全量 1108 通过）**：F11 全链（超时→心跳→flush→派发不被拒，全程 1 个 compact RPC=E12）、事件丢失→轮询补发、二次超时→放弃+resolve+通知、进程退出×3（崩溃/主动停止/process_error）清 pending、批屏障超时（不打标+状态保持+E1 顺序）/屏障期事件结清（打标）/toWait 事件结清（打标）、waitCompactionIdle 全形态、心跳计数。E1/E12/E15 核对（§22 清单）；既有「超时→fail-open→派发」用例按新语义更新。
    - **文档精度修正（审查遗留）**：「FIFO 保证查询答案先于事件写出」措辞精确化——true 恒先于事件（查询时仍在压缩 → 响应先写出）、false 可后至（查询时已结束，后至 false 恰为正常闭合路径）；`compaction_end` 不计入代际的理由以此为准。
31. **Phase 3（ADR-0006）+ 审查建议三修** — 上游 `abort_compaction` RPC 提案以 ADR 交付（无本地代码），顺带落地审查员 3 个建议级修复（含 TDD 测试）：\n
    - **ADR-0006（Phase 3 交付物）**：`docs/adr/0006-pi-upstream-abort-compaction-rpc.md`——pi 0.84.2 dist 实读证据：`agent-session.abortCompaction()` 方法已存在（~1488 行，abort `_compactionAbortController`+`_autoCompactionAbortController`）、在飞压缩确实响应 abort（~1429 行抛 "Compaction cancelled"）、`abort` RPC 命令只调 `session.abort()` 不碰压缩 controller（rpc-mode.js ~329）、`compact`/`get_state` 命令入口已存在（~416/~349）。成本 ~3 行接线；abort 后 compaction_end 照常发出，扩展侧心跳分支零改动消费。**不依赖上游**：Phase 2 三出口已兜住场景，ADR 仅提供「取消」升级路径。

    - **建议 1（waitCompactionIdle 重排 unref）**：`pollOnce` 内重排定时器提取 `schedulePoll()` 辅助（初始 + 每次重排统一 unref）——Esc 中断后卡死压缩的轮询不再持有事件循环至预算耗尽。测试：fake-clock 包装 setTimeout 断言 3 次调度（初始+两次重排）全部 unref。

    - **建议 2（超时路径消息顺序反转）**：`queueDuringCompaction(name, msg, front?)` 增加 front 参数（unshift）；内联超时分支的**触发消息 A** 经 `queueDuringStuckCompaction(..., front=true)` 入队头部——B/C 压缩期间先到者保持 FIFO 在 A 后，flush 顺序与成功路径一致（A 先、pending FIFO 后）；压缩期间新到达消息走默认尾部（FIFO 不反转）。测试：runtime 级 front/false 两用例 + 全链路（B/C 先到→A 超时插头→compaction_end→sendCommand 顺序 A/B/C）。

    - **建议 3（near-miss ~30s 有界延迟）**：`CompactResult` 增加 `settledByHeartbeat?: boolean`（仅 timedOut 分支、仅近失时置位）——租约内心跳已到 + 超时 settle = 压缩**已结清**（响应只是延迟）：内联路径落入静默 settled 路径（不 notify、不入队、不启 watcher）直接 endCompaction+派发；批屏障 in-loop 同步闭合（`ok || !timedOut || settledByHeartbeat` → endCompaction+打标，commit 时成员已 idle 直接派发，零 watcher 轮询）。取消「近失需等首轮轮询才 close+flush」的 ~30s 延迟。

    - **测试（6 新用例 + 2 更新，全量 1114 通过）**：settledByHeartbeat 置位（near-miss 用例更新断言）/缺位（新）、queue front/false 两向（新）、重排 unref 计数（新）、内联近失全链——零 notify/零 pending/直接派发（新）、stuck 顺序全链 A/B/C（新）；批屏障近失用例更新（状态 compacting→idle）。
32. **压缩后 get_session_stats 的 percent:null 语义分流（问题二 Phase 1）** — 「压缩完成后查不到上下文用量」不是故障：pi 上游 `getContextUsage()`（0.83.x/0.84.x dist 实测，agent-session.js ~2542 行）在「最新压缩条目之后无有效 assistant 回复」时刻意返回 `{tokens:null, contextWindow, percent:null}`（上游注释："context token count is unknown until the next LLM response"）——压缩前 usage 不可信、宁缺毋滥。扩展层 `queryStats` 曾用 `typeof percent !== "number"` 把合法「未知」与真失败混为一谈 → 误导性「无法查询成员上下文用量」通知。修复 = 语义三分：\n
    - **null（合法未知）→ `{ok:true, stats:{percent:0, tokens:0}}`**：语义化为「已知低」静默跳过压缩检查（压缩刚完成上下文 = summary+保留窗口+待派发任务，必远低于阈值；与现状「跳过+通知」的压缩行为完全一致，仅去噪音）；批屏障共享 runtime 自动受益（预检 ok:true → needs=false → 内联再查一次 → 仍静默，双查询保留但零噪音）。percent:0 是语义化猜测而非事实——防御性注释写明上游契约/版本/字段粒度（勿锁死「同时 null」假设，混合形态需字段级判别）。\n
    - **undefined（模型无 contextWindow/配置缺失）与 RPC 失败 → 保留 fail-open 通知**：仅放宽 `=== null`，其他形态测试锁定不放宽。\n
    - **通知文案诚实化**：stats 失败分支改为「（原因：<RPC 原因或成员未返回上下文用量数据>）」如实带原因。\n
    - **测试矩阵 7 条**：null→ok:true/percent:0+shouldCompact false；contextUsage undefined→仍 ok:false；percent 其他异常形态→仍 ok:false（锁定）；端到端压缩后窗口零通知+正常派发（仅一次 stats 查询、无 compact RPC）；窗口闭合回归（成员处理任务后 percent 正常→超阈值仍触发压缩）；resume 场景（--continue 恢复会话最新条目为压缩边界→首笔任务零通知）；既有 percent 非 number 用例锁定。\n
    - 不做（未采纳）：冷却标记跳过查询（省本地管道 RPC，复杂度/收益倒挂）、重试（数据源恒 null）、tokens 历史累计（含压缩前严重高估）、批屏障双查询优化（零噪音后无意义）。显示层 0% 修复与 ADR-0007 属 Phase 2，不在本阶段。
33. **显示层 percent null 判空 + ADR-0007（问题二 Phase 2）** — 与 Phase 1 同根的第二用户可见症状（gamma 发现）+ 上游提案：\n
    - **显示层判空**：`Math.round(null) === 0` 把压缩后合法「未知」渲染成误导性 "0%"——widget（team-status-widget.ts）与 inspector footer（member-inspector-state.ts buildFooterStatusLine）两处渲染点改为 `percent === null ? "?" : Math.round(percent)%`；`MemberContextInfo.percent` 类型放宽为 `number | null`（两处定义同步，注释写明上游契约）。测试：widget 集成（percent null → "?" + 无 "0%"）、inspector-state 纯函数（footer 行 "💭 分析员 ?" + 无 "0%"）；既有数值渲染用例锁定。\n
    - **ADR-0007**（`docs/adr/0007-pi-upstream-context-usage-reason.md`）：上游 `getContextUsage()` null 分支返回结构化 `reason: "post-compaction"`（主推，一行成本，全体消费者通用，不依赖下游对实现细节的推测）；备选：null 分支改用 `estimateContextTokens` 估算值（可行性已验证——无 usage 时退化逐条估算，compaction.js:131；但与上游「only trust usage」保守注释原则冲突）。两者非互斥、均非阻塞。\n
    - 上游合入后的演进空间：queryStats 改判 reason 字段（不再依赖 `percent === null` 隐含知识）或恢复单分支（估算值形态）——均为可选适配，非本阶段范围。
34. **等待预算提升为顶层通用设置（waitTimeoutMinutes）** — 用户裁决：批等待上限本与自动压缩无关（wait 工具永不超时的原始设计被 1.3 的防御性 deadline 修正后，该 deadline 只是**借用**了自动压缩设置组的 `batchMaxWaitMinutes` 槽位），故提升为 `TeamSettings` 顶层字段 `waitTimeoutMinutes?`（默认 15 分钟，0=不限）并改名：
    - **新位置/新名字**：`src/settings/resolve-wait-timeout.ts`（`DEFAULT_WAIT_TIMEOUT_MINUTES`/`resolveWaitTimeoutMinutes`/`describeWaitTimeoutSetting`）；旧 `resolve-auto-compact.ts` 的 `DEFAULT_BATCH_MAX_WAIT_MINUTES` 与 `ResolvedAutoCompact.batchMaxWaitMinutes` 删除，`describeAutoCompactSetting` 不再含「批等待」。
    - **消费点**：`resolveWaitIdleDeadlineMs(getSettings?)`（wait 工具 all-idle 兜底 deadline）与批屏障 maxWait 预算（`runBatchCompactionBarrier`，0→Infinity 转换在调用点保留）共用同一预算；`TlToolsDeps`/`SendAndWaitCtx` 新增 `getSettings?`（index.ts 两处接线注入 `() => loadSettings(getRootDir())`），inline 派发路径（message-channel）不需要，不注入。
    - **迁移**：`loadSettings` 读旧 `autoCompact.batchMaxWaitMinutes` 一次性搬移到顶层（守卫用**原始 YAML 值**判断新键缺省——settings 克隆恒带默认 15，用克隆值判断会永不迁移）；已保存文件下次写入即为新形态。
    - **UI**：`/team setting` 顶层菜单新增「等待上限（当前：15 分钟/不限）」，自动压缩子菜单移除「设置批等待上限」；菜单标签 `等待上限`，提示语明示「0 = 永不超时（恢复原始语义）」。
    - **测试**：settings 解析/往返/迁移（3 例）、新 resolver 单测（5 例）、tl-tools deadline 配置化与 0=不限（1 例）、批屏障 budgetMinutes 接线（2 例改），全量 1155 通过。
35. **成员思考强度配置（memberThinkingLevel）** — `/team setting` 新增顶层项「成员思考强度」：配置一个思考级别（off/minimal/low/medium/high/xhigh/max），成员启动时**若其生效模型支持该级别则传 `--thinking <level>`，否则不传 flag 保持 pi 默认思考级别**（用户裁决：不支持时保持现状，不做就近 clamp——pi 自身的 `setThinkingLevel` 会 clamp 到最近支持级别，语义不符）。
    - **支持集语义**（`src/settings/resolve-thinking.ts`，逐字复刻 pi-ai `getSupportedThinkingLevels` 并版本锚定；不 import pi-ai——非本包依赖且 jiti 深导入有拼坏前科）：非 reasoning 模型仅 `off`；reasoning 模型 off/minimal/low/medium/high 默认支持（thinkingLevelMap 映射为 null 者除外），xhigh/max 仅当 thinkingLevelMap 有对应条目。
    - **接线**：`loadSettings` 新增顶层 `memberThinkingLevel?`（非法值丢弃）；`buildMemberConfig` 新增 `lookupSupportedThinkingLevels?` 选项——index.ts 在 `session_start` 缓存 `ctx.modelRegistry`，lookup 按 `provider/modelId` 在 `getAvailable()` 里查模型（查不到/注册表不可用均 fail-open 不传 flag）；两个 buildMemberConfig 调用点（start_member 工具 + /team resume 的 startResumedMember）均传入。崩溃 auto-restart 复用已存 config，flag 自然保留。
    - **边界**：无生效模型覆盖（source=none）时不检测不传 flag；团队 YAML `model` 写 `provider/id:high` 后缀的逃生口不受影响（`splitModelRef` 的 id 含后缀匹配不到注册表 → fail-open）。仅影响之后启动的成员。
    - **可观测性**：start_member 结果文本在指定成功时附「思考强度：<level>（模型支持该级别，已显式指定）」。
    - **测试**：resolve-thinking 单测（支持集语义表 5 例 + 解析器 4 例 + 校验/标签 3 例）、settings 往返/非法丢弃/七级别接受（4 例）、member-process spawn 参数（3 例）、buildMemberConfig 集成（5 例），全量 1247 通过。
36. **S2：member→TL 消息以 nextTurn 注入（消息合并阶段 1）** — 用户诉求「消息合并」三阶段计划之阶段 1：成员→TL 消息（`sendToTl` 的 team-message）不再逐条即时注入，改为 `pi.sendMessage(msg, { deliverAs: "nextTurn" })`——消息进 pi 的 `_pendingNextTurnMessages`，**下一次任意回合开始时与用户消息统一注入 context**，消灭 TL streaming 期间逐条 steer 打断，idle 时也不触发新回合。
    - **版本验证（0.83.0 实读，peerDep 实际解析版本）**：dist/core/agent-session.js `sendCustomMessage` 的 `options.deliverAs === "nextTurn"` 分支直接 `_pendingNextTurnMessages.push(appMessage)`（1075-1077 行，不 steer 不 followUp 零打断）；`prompt()` 构建 messages 时注入全部 pending 消息并清空（876-880 行）；扩展 API `SendMessageHandler` 类型含 `"nextTurn"`（dist/core/extensions/types.d.ts）；runner 绑定 `sendMessage: (message, options) => this.sendCustomMessage(message, options)` 原样透传（1846 行）。**支持存在，主路径成立**——回退方案 D（debounce 合并）不启用。
    - **wait 回复零影响**：`resolveIfWaiting` 前置分支不变——corrId 被 wait 消费的消息根本到不了 sendMessage；迟到回复（corrId 存在但 waiter 未等待）也走 nextTurn（下回合可见）。
    - **范围**：仅 `src/setup/message-channel.ts` 的 `sendToTl` team-message 路径。event-handler 的系统通知（崩溃/拒收/压缩/清理）与 `onUnknownTarget` 的 team-route 错误消息**保持即时**（操作通知需立刻可见，测试锁定）。
    - **语义变化（方案接受）**：idle 时成员消息不再即时显示，滞留到下一回合——正是「不逐条触发会话」诉求（未采纳 gamma Phase 3 滞留兜底）；nextTurn 注入前消息不进 TUI 历史（不 emit message_start/end）。
    - **测试**：sendToTl 无 corrId→nextTurn、带未匹配 corrId→仍 nextTurn、resolve 分支零影响（既有）、team-route 无 options（既有），共 3 新例；既有 2 例断言更新（参数精确匹配），全量 1250 通过。
37. **S1：member→member 派发层回合边界合流（消息合并阶段 2，本需求主体）** — 无等待链消息（无 corrId ∧ 非 `to:"all"` ∧ 非 Inspector 直发（直发不经通道天然绕过））在接收方 working 或桶非空时入 per-receiver 桶（`src/channel/message-coalescer.ts`，纯状态 + flusher 钩子，跨 sender 合并、来源逐条标注）；**flush 点 = 接收方 `agent_end`（主）+ corrId 消息到达且桶非空（先 flush 合并包再派发 corrId，FIFO 保序）+ `compaction_end` 后（防御性钩子）+ 进程退出/teardown（drain + 通知条数，复用 `drainPendingOnProcessExit` 模式）**。合并包经完整派发路径（`dispatchWithAutoCompact`：compacting 分支 + 一次压缩检查 + flushPending + dispatch）——合并 = 一次 working 周期，状态机/等待工具/显示层零改动。
    - **合并格式**：`[消息通道 - 来自 <sender>]（合并包：共 N 条未处理消息，请在一个回合内全部处理）\n【消息 i/N｜来自 <sender>】<content>…\n处理要求：逐条处理；如需分别回复，请在回复中注明对应消息编号（如「回复 2：…」）。`（subject 保留在来源标注行内）。
    - **上限与降级**：flush 取「满足上限的最长前缀」——≤`maxBatchSize`（默认 5）条且总长 ≤`maxBatchChars`（默认 4000）；剩余留桶等下一 flush 点；单条超限单独派发（不合并）；字符预算封顶于硬守卫 `MAX_COMMAND_SIZE`（1MB）之下（`takePrefixForFlush` 纯函数）。
    - **corrId 红线（结构性保证）**：带 corrId 消息在任何阶段都不入桶——wait 链消息绝不合并（防死锁）；`skipAutoCompact` 标记消息恒带 corrId，天然绕过。
    - **设置**：`TeamSettings.messageCoalescing { enabled?, maxBatchSize?, maxBatchChars? }`（默认 enabled:true），`/team setting` 新增「消息合并」子菜单（开关/条数/字符），关闭时完全走原逐条路径（fail-open，场景 I）。
    - **与既有机制交互**：压缩 pending 桶与合并桶**双桶正交**——compacting 期间消息走既有 `queueDuringCompaction`/`flushPending`（逐条、在飞租约/超时 mark/flush 顺序测试零触碰）；合并包触发压缩时作为单条消息入压缩 pending，压缩后整体派发（至多一次压缩检查，省 RPC）；settlement 窗口（agent_end 后 idle、pi 仍 streaming）内到达消息按「idle+桶空」立即派发（followUp 保序，方案接受）；flush 失败（拒收）→ 复用既有拒收分支（状态纠正 + 通知），通知注明合并包条数，**清桶不重试**（无等待链消息无重试契约，同时消除 idle+桶非空停滞态）。
    - **DI/接线**：`createMessageChannel` 创建共享 coalescer 实例（返回 `MessageChannel.coalescer`），`createSendToMember` 注册 flusher（合并包构建 + `dispatchWithAutoCompact`）；`EventHandlerDeps`/`MemberLifecycleDeps` 转发（agent_end flush / compaction_end 后 flush / process_exit·process_error drain）；`getCoalescing` per-dispatch 解析（设置即时生效）。
    - **测试（35 新例）**：coalescer 模块 14（前缀/上限/单条超限/原子取出/flusher 生命周期/drain）；settings 5 + resolve 6；event-handler 场景 A（忙时 3→1 回合）/B（idle 突发 2 回合）/D（corrId 保序）/E（旁路）/F（5+1 分批留桶）/G（退出 drain 通知）/I（开关）+ subject 保留 + 合并包触发一次压缩检查（9 新 + 2 更新），全量 1285 通过；压缩全链既有测试零改动。
38. **team_send_and_wait 强制 all-idle 门控（与 wait_and_get_member_status 一致）** — 用户需求：旧语义是「全员回复 OR 全员空闲」的竞速（`Promise.race([allDone, allIdle])`），目标成员全部回复即立即返回——但回复到达时该 member 可能仍在收尾回合（settlement window），非目标 member 也可能仍在处理先前派发，TL 过早继续会与仍在运行的 member 状态错位。修复：`waitWithAllIdleCheck` 重写——
    - **唯一返回条件 = `waitForAllIdle` 门控**（与 `wait_and_get_member_status` 同一检测：active = working/compacting，去抖 4 次连续 3s 检查）；回复仅经 fire-and-forget 的 `waitForResponse().then()` 收集进 `results`，不再参与竞速。全员回复 + 全员空闲 → 完整结果（`details: {nextSteps}`）；否则 partial（`{allIdle, partial, nextSteps}`）+ ⚠️ 标记；deadline（`waitTimeoutMinutes`，默认 15 分钟，0=不限）到期 → partial + 卡死成员诊断（两分支统一由门控结果驱动）。
    - **corrId 清理统一**：门控结束后已回复者清 `lastPendingCorrId`、未回复者 `cancelByCorrId`（微任务语义保证结果收集先于同步清理，与旧 all-idle 分支一致）。
    - **防御性宽容**：`Promise.resolve(waitForResponse(...))` 包裹——容忍返回裸值的 mock（waitForResponse 契约恒为 Promise，纯测试兼容）。
    - **成本特性（语义接受）**：最后一名 member 空闲后仍需 ~12s 去抖窗口才返回（与 wait_and_get_member_status 在成员活跃时调用的行为一致）；被 channel 的 followUp 语义抵消了误判风险（settlement window 内派发会排队不丢失）。
    - **测试**：新增核心语义用例（回复已到但非目标 member 仍 working → 推过整个去抖窗口等待不结束；转 idle 后放行）+ deadline 用例措辞更新；两处测试文件以 `runWithSettledAllIdle` / `settleAllIdleGate`（fake timers 推去抖窗口）改造成功路径用例（避免每个用例真实等待 ~12s）；压缩租约超时用例改推 15 分钟 deadline（成员保持 compacting 时门控无法去抖）。全量 1302 通过。
39. **S3：等待期 member→TL 消息缓冲 + all-idle 即时注入（消息合并阶段 3，依决策 #38）** — S2（决策 #36）的遗留盲区：`team_send_and_wait` 等待期间到达的**非回复** member→TL 消息（无 corrId / corrId 不匹配）进 pi 的 `_pendingNextTurnMessages`，要等 TL 回合结束才可见——而 TL 正阻塞在工具调用里，工具结果返回后继续当前回合时这些消息仍不可见，TL 只能下回合才看到，与 #38 的「全员空闲即返回」形成信息时差。修复：
    - **缓冲层**（`src/channel/tl-wait-gate.ts` 纯状态）：`waitWithAllIdleCheck` 在飞期间 `sendToTl` 的非回复消息改入 `tlWaitGate` 扩展侧缓冲（不进 pi 的 nextTurn 队列——该队列无公开 drain API，缓冲决策必须在消息到达时做出）；corrId 回复仍由 waiter 消费进工具结果（优先级不变）；无等待在飞时 S2 nextTurn 语义零变化。
    - **注入时机（核心）**：all-idle 门控打开（或 deadline 到期）的瞬间，`flushTlWaitBuffer` 以**无 deliverAs 的 `pi.sendMessage`** 投递缓冲消息——工具执行期 agent run 恒 active（`_isAgentRunActive` 覆盖整个 run 含工具执行）→ pi 走 **steer 分支** → agent loop 在工具结果 append 之后、下一次 assistant completion 之前排空 steering 队列（pi-agent-core agent-loop.js runLoop 每轮末 `getSteeringMessages()`）：**同一回合、紧随工具结果、零 streaming 打断**（工具执行期无 token 在流）。**真实 AgentSession E2E 锁定**（`src/tools/tl-wait-gate.agent-session.test.ts`）：工具执行中 sendMessage 的 custom 消息落在 toolResult 之后、final assistant 之前。若 flush 前回合刚被 Esc 中止：pi 的 not-streaming + 无 triggerTurn 分支把消息直接 append 进 history（不触发回合）——不丢失。
    - **注入格式（用户裁决：保持 TL 上下文干净）**：每条缓冲消息以 S2 原格式（`[消息通道 - 来自 X]` + 主题 + 内容）**逐条独立注入**——与 nextTurn 路径的消息外观完全一致，不加合并包头、编号标注等元信息；多条 = 多个独立 custom message，全部落在同一 steering batch（时序上仍紧随工具结果）。
    - **生命周期泄漏防护**：beginWait/endWait 的 try/finally 完全在 `waitWithAllIdleCheck` 内（endWait 先于 flush，两者间无 await——同步块内无 interleaved 入桶）；gate 在飞期间到达的最后一批消息（如成员 idle 前最后一报）恰好在门控打开时被 flush 携带。无 `tlWaitGate` 接线的 legacy 路径零行为变化（flush 直接跳过，测试锁定）。并发等待（并行 tool call）容忍：计数器不归零不算结束，首个打开的门控 drain 全部缓冲。
    - **fire-and-forget**：flush 投递失败（异步 reject / 同步 throw）fail-open，不影响工具结果返回（TL 可经 get_member_log 兜底）。
    - **范围**：仅 `sendToTl` 的 team-message 路径；系统通知（崩溃/拒收/压缩/清理）与 team-route 错误保持即时；批屏障期间（beginWait 之前）到达的消息仍走 S2 nextTurn（屏障静默且短暂）。
    - **接线**：`createMessageChannel` 创建并返回 `tlWaitGate`；`index.ts` 注入 `tlToolsDeps`；`SendAndWaitCtx` 新增 `pi?`/`tlWaitGate?`。
    - **测试**：gate 单测 5 例（计数/缓冲/原子 drain）；message-channel S3 3 例（缓冲不 sendMessage、gate 关闭后 nextTurn 不变、corrId 回复优先）；tl-tools 2 例（门控打开时单次 steer 注入含合并格式与单参数调用断言、无接线零变化）；真实 AgentSession E2E 1 例。全量 1313 通过。

## Dependency Injection Pattern

The codebase uses an explicit Dependency Injection (DI) pattern to decouple modules and enable testability. Every subsystem receives its dependencies through a typed interface, rather than importing them directly.

| DI Interface | Module | Dependencies |
|-------------|--------|-------------|
| `TlToolsDeps` | `tools/tl-tools.ts` | `pi`, `manager`, `responseWaiter`, `memberOpsStates`, `lastPendingCorrId`, `messageQueue`, `createMember?`, `buildMemberConfig?`, `getMemberLog?`, `isDynamicSession?`, `addMemberToSession?`, `onDynamicMemberAdded?`, `onDynamicPhaseTransition?`, `getAutoCompact?`, `getSettings?`, `getHandle?`, `autoCompact?` |
| `MemberLifecycleDeps` | `setup/member-lifecycle.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages`, `processManager?`, `memberHandles?`, `autoCompact?`, `coalescer?`, `onMemberActivity?` |
| `MessageChannelDeps` | `setup/message-channel.ts` | `pi`, `memberOpsStates`, `lastPendingCorrId`, `memberHandles`, `onRouteNotification?`, `getAutoCompact?`, `getCoalescing?` |
| `EventHandlerDeps` | `channel/event-handler.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages`, `processManager?`, `onMemberActivity?`, `memberHandles?`, `autoCompact?`, `coalescer?` |
| `SendToMemberDeps` | `channel/event-handler.ts` | `pi`, `memberOpsStates`, `memberHandles`, `getAutoCompact?`, `autoCompact?`, `coalescer?`, `getCoalescing?` |

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
                          → team_send_and_wait 等待在飞（S3，决策 #39）：入 tlWaitGate 扩展侧缓冲，
                            all-idle 门控打开时由 waitWithAllIdleCheck 经 pi.sendMessage（无 deliverAs
                            → 工具执行期 = steer 分支）注入——工具结果之后、同一回合内，不等 TL 回合结束
                          → 否则 pi.sendMessage({customType:"team-message", ...}, {deliverAs:"nextTurn"})  ← S2：下一次任意回合统一注入，零 steer（决策 #36）
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
    → Member replies → responseWaiter.resolveIfWaiting(corrId, ...) → 结果仅记录，等待继续
    → All-idle gate（强制门控，决策 #38）：等待仅在所有 member 空闲（idle/crashed/stopped）
      时结束——与 wait_and_get_member_status 同一检测；回复本身不结束等待
      （回复的 member 可能仍在收尾，非目标 member 可能仍在处理先前任务）。
      deadline（waitTimeoutMinutes，默认 15 分钟）到期 → partial 结果 + 卡死成员诊断
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
npm test                         # Run all tests (vitest)
npm run test:watch               # Watch mode
npm run check:goal-reminder      # Stage 3 static Goal lifecycle/wording scan
printf '' | timeout 10 ./node_modules/.bin/pi --mode json --no-tools -e ./index.ts  # 0.83.0 CLI smoke
```

测试覆盖面较广（状态机、member-process 含 resume 参数、manifest、resume-handler、event-handler、response-waiter、message-channel、member、save-team-definition、config、UI widget、member-inspector、agent-session-tools、agent-initiated-mode 提示词等）。测试以 `*.test.ts` 形式与源码同目录存放，具体数量以 `npm test` 实时输出为准。

| Test Level | What | How |
|-----------|------|-----|
| Unit | schema, store, message-queue, router, config, state-machine, response-waiter | Pure functions, no mocking |
| Integration | commands, tl-tools, index, member-process, manager, event-handler, member-lifecycle, message-channel | Mock ExtensionAPI / child_process |
| E2E | `./node_modules/.bin/pi --mode json --no-tools -e ./index.ts` smoke; `src/tools/goal-tools.agent-session.test.ts` high-fidelity lifecycle | Installed pi 0.83.0 runtime; provider transport is deterministic/fake in the AgentSession fixture |

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
| `/team setting` | Interactive settings menu — member default model (follow TL current model / fixed available model) + member thinking level (成员思考强度: 模型支持则传 `--thinking`，否则保持默认) + auto-compaction (toggle / percent & token thresholds / timeout) + wait budget (等待上限, 0=永不超时 — wait 工具 all-idle deadline 与批屏障共享的顶层通用预算) + message coalescing (消息合并: 开关/批量上限/字符上限，S1 阶段 2). Also allowed during a session |
| `/team help` | Display usage help for all subcommands |

## TL Tools (session-scoped registration + activation; exception below)

> **例外（ADR-0003）**：`start_team_session` 在**扩展加载时注册**、会话外可见（见下表）；`stop_team_session` 会话作用域注册、仅自主会话激活。

| Tool | Description |
|------|-------------|
| `start_team_session(task)` | **加载时注册**（决策 #21 唯一例外）。agent 自主启动动态团队会话（`origin: "agent"`）：`task` 必填——自动置 Goal + 注入自主版设计阶段提示词。全程无确认门；读/分析自由（无派发管制守卫），**可自由 read 与编辑文件（任意扩展名，写纪律见系统提示词；ADR-0003 修订）**，`.shared-context.md` 仍须经 `write_shared_context` 写入。已有活跃会话时返回错误。成员进程结构性无法调用（`TEAM_ROLE` 早退）。 |
| `stop_team_session()` | 结束 agent 自主会话（停成员、摘 widget、保留会话目录供 `/team resume`；磁盘清理由 `/team delete` 负责）。会话作用域注册，**仅自主会话出现在活跃工具集**；对 `origin: "user"` 的会话拒绝执行（手动会话归用户 `/team stop`）。与 `/team stop` 共享 `teardownTeamSession()`。 |

| Tool | Description |
|------|-------------|
| `write_shared_context(content)` | Write the team shared context to the session's `.shared-context.md` (overwrite). **Must be called before the first `start_member` — start_member is blocked until then.** Sets the session `sharedContextWritten` flag; direct `write`/`edit` of `.shared-context.md` is intercepted and redirected here. Call again to update, then notify members to re-read. |
| `add_dynamic_member(name, label, systemPrompt, model?)` | Register a member in `/team dynamic` mode. Name is the identifier, label is Chinese display name, systemPrompt is role definition. Only available in dynamic mode. |
| `set_goal(text, criteria)` | Set a session goal with verifiable completion criteria. The system reminds the TL only after one run is fully settled (with no automatic retry, compaction, or queued continuation) while the goal remains active (not yet closed); `agent_end` alone never sends a reminder. **可见性**：仅团队会话（`/team start`/`/team dynamic`）期间可见——`onSessionStart` 注册，`before_agent_start` 回合边界强制（见决策 #10）。 |
| `finish_goal()` | Mark the current goal as completed and stop the reminder system. Call when all goal criteria are met, or when an unresolvable blocker is encountered. **仅条件全部满足或遇到不可解决阻塞时调用**——条件未满足且仍可推进时不得调用，继续派发任务；仅口头宣称完成不会停止提醒（提醒系统只认真实的 finish_goal 调用）。promptSnippet 区分于 set_goal（Finish 语义）。 |
| `start_member(name)` | Launch a Member's pi RPC process. In dynamic mode, the first call triggers the design→execution phase transition. |
| `stop_member(name)` | Gracefully terminate a Member process |
| `list_members()` | Show all member statuses |
| `get_member_log(name, lines?, maxContentLength?)` | Query Member's recent session via RPC. `maxContentLength` truncates each message content (default 200 chars). Truncation uses `slice(0, max-3) + "..."` so total length = maxContentLength. |
| `wait_and_get_member_status()` | 等待所有 member 空闲后查看所有 Member 的运行状态 (idle/working/crashed/stopped)。No parameters. 如果任何 member 仍在工作中会阻塞，和 team_send_and_wait 的 all-idle 门控完全一致（team_send_and_wait 同样必须等到全员空闲才结束等待，见决策 #38）。 |
| `team_send_and_wait({tasks: [{to, content}], nextSteps})` | Send message(s) to **one or more** team members and WAIT until ALL members are idle（决策 #38：回复到达不结束等待——必须等到全员空闲，与 wait_and_get_member_status 一致；回复在等待期间陆续收集，门控结束后一并返回；等待期间到达的非回复 member→TL 消息随门控打开经 steer 即时注入——决策 #39，不等 TL 回合结束）. tasks 支持批量发送到不同 member 实现并发执行。Returns partial results if some members fail. nextSteps 在 wait 结束后随结果返回。
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

During an active team session (including `/team dynamic`), a `tool_call` event handler enforces tool restrictions using a **whitelist** (not a blocklist). Any tool not on the whitelist is blocked at runtime. **白名单仅约束 `origin: "user"` 会话**——agent 来源会话（start_team_session）早退旁路白名单与扩展名检查（ADR-0003 修订，见决策 #22）。

**Design phase whitelist (`DESIGN_PHASE_WHITELIST`):**
```
add_dynamic_member, start_member, stop_member, list_members,
get_member_log, wait_and_get_member_status, team_send_and_wait,
set_goal, finish_goal, write_shared_context,
start_team_session, stop_team_session,   ← ADR-0003（重入报错/放弃委派）
read (unrestricted),
write (only .md files — checked per-call)   ← 仅约束 user 来源会话；agent 来源早退旁路（ADR-0003 修订，见决策 #22)
```

**Execution phase whitelist (`EXECUTION_PHASE_WHITELIST`):**
```
start_member, stop_member, list_members, get_member_log,
wait_and_get_member_status, team_send_and_wait,
set_goal, finish_goal, add_dynamic_member, write_shared_context,
start_team_session, stop_team_session,   ← ADR-0003
read, bash, web_search, fetch_content, get_search_content,
write, edit (both only .md files — checked per-call)   ← 仅约束 user 来源会话；agent 来源早退旁路（ADR-0003 修订，见决策 #22）
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
- **`write`/`edit` are on both whitelists** — but an additional per-call check restricts them to `.md` files only. **仅 user 来源会话**：agent 来源会话早退旁路白名单与扩展名检查（ADR-0003 修订，见决策 #22）。
- **`.shared-context.md` 专属拦截** — `write`/`edit` 的目标若是 `.shared-context.md`，无论哪个阶段都会被 block 并重定向到 `write_shared_context` 工具（保证 start_member 门控标记准确）。
- **TL 预派发守卫（执行阶段）** — `read`/`bash`/`web_search` 等虽在白名单中，但 `src/session/tl-read-guard.ts` 会对"turn 内未派发任务且非管理工具调用超过 3 次"的情况**持续拦截**（sticky block）：派发前每次非管理工具调用都被 block（首次含用户可见通知），直到 `team_send_and_wait` 发生。防止 TL 亲自分析代码而不派发，且无法用 grep/rg 绕过。详见 DESIGN.md。**仅 `origin: "user"` 会话生效**——自主会话（ADR-0003 修订）移除此守卫、设计阶段 read 软限制**与代码写入守卫**（读与分析自由、可自由编辑任意文件，写纪律见系统提示词）。
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
  → stopAll() → manifest=stopped (保留 sessions/_dynamic_<ts>/) → endSession() → dynamicPhase = "design"
  → 可用 /team resume 恢复；/team delete 负责显式磁盘清理
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
- `docs/adr/0005-pi-upstream-truncation-marking.md` — Upstream framework truncation marking proposal (finalize-time detection + length-protection extension + oneOf error de-noising; non-blocking, for pi upstream issue)
- `docs/adr/0006-pi-upstream-abort-compaction-rpc.md` — Upstream `abort_compaction` RPC proposal (`agent-session.abortCompaction()` exists but is not reachable over RPC; ~3-line wiring in rpc-mode.js; non-blocking, for pi upstream issue)
- `docs/adr/0007-pi-upstream-context-usage-reason.md` — Upstream `getContextUsage()` structured-reason proposal (`percent:null` after compaction is a legal state, indistinguishable from config-missing `undefined` by consumers; reason field primary / estimate alternative; non-blocking, for pi upstream issue)

## Design Document

See [DESIGN.md](./DESIGN.md) for the full design specification (26 sections), including the Goal reminder lifecycle and release verification checklist.
