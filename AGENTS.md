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
  ├── 9 TL tools (start_member, stop_member, list_members, get_member_log, wait_and_get_member_status, team_send_and_wait, add_dynamic_member, set_goal, finish_goal)

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
│   ├── handlers/     ← 11 extracted subcommand handlers (< 120 lines each)
│   │   ├── create-handler.ts
│   │   ├── dynamic-handler.ts
│   │   ├── edit-handler.ts
│   │   ├── start-handler.ts
│   │   ├── stop-handler.ts
│   │   ├── list-handler.ts
│   │   ├── show-handler.ts
│   │   ├── delete-handler.ts
│   │   ├── status-handler.ts
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
│   └── event-handler.ts    ← Member RPC event handler (state machine, dedup, routing)
├── process/          ← Member process lifecycle
│   ├── member-process.ts  ← pi --mode rpc spawn wrapper (write queue, size guard)
│   └── manager.ts    ← Multi-member lifecycle + operational state + auto-restart
├── tools/
│   ├── tl-tools.ts   ← 7 TL process management tools (Deps-based DI)
│   ├── goal-tools.ts  ← Goal system: set_goal/finish_goal tools + agent_end reminder
│   └── tl-tools-add-dynamic.test.ts  ← add_dynamic_member tool tests
├── team/
│   ├── definition.ts ← TeamDefinition / TeamMember types
│   ├── schema.ts     ← YAML field validation
│   └── store.ts      ← Read/write/delete team YAML files
├── session/
│   ├── state.ts      ← TeamSessionState (structuredClone deep copy), addMemberToSession()
│   ├── state.test.ts ← addMemberToSession tests
│   ├── context.ts    ← TeamContext shared mutable state interface (incl. isDynamicSession)
│   └── state-machine.ts  ← Pure function state machine: MemberOperationalState transitions
├── prompts/
│   └── dynamic-mode.ts  ← TL system prompt template for /team dynamic mode
├── setup/            ← Modular extracted setup modules
│   ├── member-lifecycle.ts  ← createAndRegisterMember, buildMemberConfig, getMemberLog
│   └── message-channel.ts   ← createMessageChannel factory (queue+router+waiter wiring)
├── ui/               ← TUI components for team mode
│   ├── team-status-widget.ts  ← Bordered widget: live member status + context %
│   ├── edit-mode-widget.ts   ← Bordered widget: ✏️ EDIT MODE — <team name>
│   └── create-mode-widget.ts ← Bordered widget: 🆕 CREATE MODE
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

6. **Pure function state machine** — `src/session/state-machine.ts` implements `transitionState(current, event)` as a pure function with no side effects. Member operational states (`idle`/`working`/`crashed`/`stopped`) are derived deterministically from events (`task_started`/`task_completed`/`process_exit`/`started`/`stopped`).

7. **Modular extraction** — `index.ts` was reduced from ~800 to ~341 lines by extracting:
   - `setup/member-lifecycle.ts` — member creation, config building, log querying
   - `setup/message-channel.ts` — message channel wiring (queue+router+waiter)
   - `channel/event-handler.ts` — member RPC event processing with dedup
   - `channel/response-waiter.ts` — correlation matching with response buffering
   - `session/state-machine.ts` — pure state transitions

8. **Dynamic team mode (`/team dynamic`)** — A free-form mode where the TL designs the team at runtime. No YAML is written to disk. The TL enters a session with 0 members, discusses requirements with the user, uses `add_dynamic_member` to register member roles, then starts and dispatches them via the standard tool chain. The session guard blocks code file writes from the moment `/team dynamic` is entered. On `/team stop`, the temporary session directory (`sessions/_dynamic_<ts>/`) is cleaned up.

9. **Session isolation via sessionId** — Each team session generates a unique `sessionId` in `TeamSessionState`. `buildMemberConfig` uses this ID to nest session data under `sessions/<team-name>/<sessionId>/` instead of the flat `sessions/<team-name>/`. This prevents conflicts when the same pre-defined team is used across multiple sessions. On `/team stop`, the session subdirectory is cleaned up. Dynamic mode sessions (`_dynamic_<ts>`) use their unique team name for the same purpose — the entire team directory is removed on stop.

10. **Goal system for TL autonomy** — `src/tools/goal-tools.ts` registers `set_goal` and `finish_goal` tools plus an `agent_end` event handler. When the TL sets a goal at session start and later finishes a turn (agent_end), the system checks if the goal is still active and incomplete. If so, it queues a user message (via `setTimeout(0)` to avoid the agent_end lifecycle conflict with `sendUserMessage`) re-triggering the TL with a reminder of the goal and its completion criteria. This prevents the TL from unnecessarily asking the user "should I continue?" mid-task. The goal is stored in module-level memory, has a 10-second cooldown between reminders to prevent loops, checks `ctx.signal?.aborted` to skip reminders when the user pressed Esc or redirected the agent, and is reset on session shutdown.

11. **Two-phase dynamic mode** — `/team dynamic` is split into a **design phase** and an **execution phase**:
   - **Design phase** (entered on `/team dynamic`): TL is blocked from using `bash`/`read`/`code_search`/`fetch_content`/`edit` entirely. `write` is restricted to `.md` files only. This forces TL to focus on discussing requirements and designing the team rather than exploring or modifying code. The only tools available are `add_dynamic_member`, team management tools, and `.md` writes.
   - **Execution phase** (entered when the first `start_member` succeeds): TL regains access to all tools for monitoring and coordination. The standard team session guard still blocks code file writes.
   - Phase transition is automatic: `start_member` tool calls `onDynamicPhaseTransition`, which flips `teamCtx.dynamicPhase` from `"design"` to `"execution"`. The `before_agent_start` handler injects different prompts depending on the current phase.

## Dependency Injection Pattern

The codebase uses an explicit Dependency Injection (DI) pattern to decouple modules and enable testability. Every subsystem receives its dependencies through a typed interface, rather than importing them directly.

| DI Interface | Module | Dependencies |
|-------------|--------|-------------|
| `TlToolsDeps` | `tools/tl-tools.ts` | `pi`, `manager`, `responseWaiter`, `memberOpsStates`, `lastPendingCorrId`, `messageQueue`, `createMember?`, `buildMemberConfig?`, `getMemberLog?`, `isDynamicSession?`, `addMemberToSession?`, `onDynamicMemberAdded?`, `onDynamicPhaseTransition?` |
| `MemberLifecycleDeps` | `setup/member-lifecycle.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages`, `processManager?` |
| `MessageChannelDeps` | `setup/message-channel.ts` | `pi`, `memberOpsStates`, `lastPendingCorrId`, `memberHandles`, `onRouteNotification?` |
| `EventHandlerDeps` | `channel/event-handler.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages`, `processManager?` |
| `SendToMemberDeps` | `channel/event-handler.ts` | `pi`, `memberOpsStates`, `memberHandles` |

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
      ├── to="mover"  → handle.sendCommand({type:"prompt",...}) on Member B's stdin
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

318 tests across 25 files (state-machine, member-process, event-handler, response-waiter, message-channel, member, save-team-definition, config, ui-widget tests included). Tests live alongside source as `*.test.ts`.

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
| `/team stop` | Stop all members, deactivate TL tools (also cleans up dynamic session directories) |
| `/team list` | List all team definitions |
| `/team show <name>` | Display team definition details |
| `/team done`             | Finish and exit current create or edit mode |
| `/team cancel`           | Alias for `/team done` (backward compatibility) |
| `/team delete <name>` | Delete a team definition (with confirmation) |
| `/team status` | Show active session + member process statuses |
| `/team help` | Display usage help for all subcommands |

## TL Tools (active only during team session)

| Tool | Description |
|------|-------------|
| `add_dynamic_member(name, label, systemPrompt, model?)` | Register a member in `/team dynamic` mode. Name is the identifier, label is Chinese display name, systemPrompt is role definition. Only available in dynamic mode. |
| `set_goal(text, criteria)` | Set a session goal with verifiable completion criteria. The system will automatically re-trigger the TL with a reminder if it stops working before the goal is met. Call at the start of a task to prevent unnecessary mid-task interruptions. |
| `finish_goal()` | Mark the current goal as completed and stop the reminder system. Call when all goal criteria are met, or when an unresolvable blocker is encountered. |
| `start_member(name)` | Launch a Member's pi RPC process. In dynamic mode, the first call triggers the design→execution phase transition. |
| `stop_member(name)` | Gracefully terminate a Member process |
| `list_members()` | Show all member statuses |
| `get_member_log(name, lines?, maxContentLength?)` | Query Member's recent session via RPC. `maxContentLength` truncates each message content (default 200 chars). Truncation uses `slice(0, max-3) + "..."` so total length = maxContentLength. |
| `wait_and_get_member_status()` | 等待所有 member 空闲后查看所有 Member 的运行状态 (idle/working/crashed/stopped)。No parameters. 如果任何 member 仍在工作中会阻塞，和 team_send_and_wait 检测 all-idle 的方式相同。 |
| `team_send_and_wait({tasks: [{to, content}], nextSteps})` | Send message(s) to **one or more** team members and wait for ALL responses. tasks 支持批量发送到不同 member 实现并发执行。Waits until all targeted members reply or all become idle. Returns partial results if some members fail. nextSteps 在 wait 结束后随结果返回。
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

### Team Session Guards

During an active team session (including `/team dynamic`), a `tool_call` event handler enforces tool restrictions:

**Standard team session / execution phase:**
- `.md` files (`.shared-context.md`, ADRs, planning docs) — `write`/`edit` allowed
- Code files (`.ts`, `.js`, `.py`, etc.) — `write`/`edit` blocked with reason "请委派给 Member"

**Dynamic mode design phase (stricter):**
- `bash`, `read`, `code_search`, `fetch_content`, `edit` — **all blocked** (TL cannot explore or modify code)
- `write` — only `.md` files allowed (for shared-context.md / ADRs)
- Only management tools + `add_dynamic_member` remain available

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

═══ 设计阶段（TL 被阻断：不能 bash/read/code_search/fetch_content/edit，write 仅限 .md）═══

TL ↔ 用户讨论需求（逐个方面，一次只问一个问题）
  → TL 构思团队角色 + 工作流
  → TL 向用户展示方案 → 用户确认

TL: add_dynamic_member({name, label, systemPrompt, model?})
  → addMemberToSession() 刷新 currentSession
  → router / widget 更新

TL: write .shared-context.md（团队成员、术语、工作流、协作规则）

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

TL: 监控进展、协调异常、更新 shared-context

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

## Design Document

See [DESIGN.md](./DESIGN.md) for the full design specification (16 sections).
