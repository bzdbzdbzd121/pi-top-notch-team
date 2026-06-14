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
  ├── 7 TL tools (start_member, stop_member, list_members, get_member_log, get_member_status, team_send_and_wait, add_dynamic_member)
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
| `index.ts` (~400 lines) | TL extension entry point. Registers `/team` command, wires DI dependencies, `before_agent_start` injection, team-status widget lifecycle, autocomplete provider. Refactored from ~800 lines via modular extraction. |
| `member.ts` | Member extension entry point. Registers `team_send_message` tool, injects team awareness via env vars. Uses `JSON.parse` for TEAM_MEMBERS (no longer comma-delimited). |
| `package.json` | pi package manifest with `pi.extensions` pointing to `["./index.ts", "./member.ts"]` |

## Source Map

```
src/
├── commands/
│   ├── team.ts       ← Single /team command (11 subcommands, incl. `dynamic`)
│   ├── status.ts     ← StatusProvider type for getMemberStatuses
│   ├── team.test.ts
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
│   └── team-status-widget.ts  ← Bordered widget: live member status + context %
├── config.ts         ← getRootDir() via env var or ~/.pi/top-notch-team
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

## Dependency Injection Pattern

The codebase uses an explicit Dependency Injection (DI) pattern to decouple modules and enable testability. Every subsystem receives its dependencies through a typed interface, rather than importing them directly.

| DI Interface | Module | Dependencies |
|-------------|--------|-------------|
| `TlToolsDeps` | `tools/tl-tools.ts` | `pi`, `manager`, `responseWaiter`, `memberOpsStates`, `lastPendingCorrId`, `messageQueue`, `createMember?`, `buildMemberConfig?`, `getMemberLog?`, `isDynamicSession?`, `addMemberToSession?`, `onDynamicMemberAdded?` |
| `MemberLifecycleDeps` | `setup/member-lifecycle.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages`, `processManager?` |
| `MessageChannelDeps` | `setup/message-channel.ts` | `pi`, `memberOpsStates`, `lastPendingCorrId`, `memberHandles` |
| `EventHandlerDeps` | `channel/event-handler.ts` | `pi`, `memberOpsStates`, `messageQueue`, `responseWaiter`, `lastPendingCorrId`, `recentlyProcessedMessages` |
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

Backup path: assistant text outputs matching
  `<team-message to="..." subject="...">...</team-message>`
are also parsed via parseTeamMessageTag() (non-greedy regex, length guard) and enqueued.

team_send_and_wait flow:
  TL calls team_send_and_wait(to, content) →
    → responseWaiter.waitForResponse(corrId, timeout)
    → Message enqueued with <corr:...> tag
    → Member replies → responseWaiter.resolveIfWaiting(corrId, ...) → TL continues
    → On timeout: TL can re-wait with same correlationId (no duplicate message sent)
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

## Testing

```bash
npm test          # Run all tests (vitest)
npm run test:watch  # Watch mode
```

260 tests across 19 files (state-machine, member-process, event-handler, response-waiter, message-channel tests included). Tests live alongside source as `*.test.ts`.

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
| `TEAM_SESSION_DIR` | Member process | Session file storage path |
| `TEAM_SHARED_CONTEXT_PATH` | Member process | Shared context file path |

## Commands Reference

| Command | Description |
|---------|-------------|
| `/team create` | Natural language team creation via TL dialogue |
| `/team dynamic` | Dynamic team mode — TL designs team on the fly based on user requirements |
| `/team edit <name>` | Natural language team modification via TL dialogue |
| `/team start <name>` | Start team session with a pre-defined YAML team, activate TL tools |
| `/team stop` | Stop all members, deactivate TL tools (also cleans up dynamic session directories) |
| `/team list` | List all team definitions |
| `/team show <name>` | Display team definition details |
| `/team cancel`           | Cancel current create or edit operation |
| `/team delete <name>` | Delete a team definition (with confirmation) |
| `/team status` | Show active session + member process statuses |
| `/team help` | Display usage help for all subcommands |

## TL Tools (active only during team session)

| Tool | Description |
|------|-------------|
| `add_dynamic_member(name, label, systemPrompt, model?)` | Register a member in `/team dynamic` mode. Name is the identifier, label is Chinese display name, systemPrompt is role definition. Only available in dynamic mode. |
| `start_member(name)` | Launch a Member's pi RPC process |
| `stop_member(name)` | Gracefully terminate a Member process |
| `list_members()` | Show all member statuses |
| `get_member_log(name, lines?, maxContentLength?)` | Query Member's recent session via RPC. `maxContentLength` truncates each message content (default 200 chars). Truncation uses `slice(0, max-3) + "..."` so total length = maxContentLength. |
| `get_member_status()` | Get operational status (idle/working/crashed/stopped) for all members. No parameters. |
| `team_send_and_wait(to, content?, timeout?, correlationId?)` | Send message and wait for response. On timeout, re-wait with same `correlationId` (no new message sent). Response content returned as tool result. |

## Extension Tools (create/edit team)

These tools are registered by the TL extension (`index.ts` → `team.ts`) and invoked by the TL agent during `/team create` and `/team edit` flows.

| Tool | Description |
|------|-------------|
| `create_team_definition` | Creates a new team YAML. Accepts full member data (name, label, systemPrompt, model) + optional workflow. Validates and writes to disk. |
| `update_team_definition` | Updates an existing team YAML. **Merge mode**: for unchanged members, TL may omit `systemPrompt` — value auto-fills from stored YAML. Omit a member from `members` to delete it. Workflow/defaults not provided preserve existing values. This avoids large payloads that could cause model output truncation. |

### Team Session Guards

During an active team session (including `/team dynamic`), a `tool_call` event handler intercepts `write`/`edit` tools:
- `.md` files (`.shared-context.md`, ADRs, planning docs) — allowed
- Code files (`.ts`, `.js`, `.py`, etc.) — blocked with reason "请委派给 Member"

In dynamic mode, the guard is active from the moment `/team dynamic` is entered — before any members exist.

### Dynamic Mode Flow

```
/team dynamic
  → mkdir sessions/_dynamic_<ts>/
  → startSession({name:"_dynamic_<ts>", members:[]})
  → isDynamicSession = true
  → 激活 TL 工具 + 会话守卫 + widget（显示"设计阶段"）

TL ↔ 用户讨论需求
  → TL 构思成员配置

TL: add_dynamic_member({name, label, systemPrompt, model?})
  → addMemberToSession() 刷新 currentSession
  → router / widget 更新

TL: start_member("coder")
  → buildMemberConfig 从 session 找到成员
  → 创建进程

TL: team_send_and_wait(...)
  → 消息通道正常流转

/team stop
  → stopAll() → rm -rf sessions/_dynamic_<ts>/ → endSession()
```


## ADRs

- `docs/adr/0001-members-as-independent-pi-rpc-processes.md` — Core architecture
- `docs/adr/0002-tl-as-central-message-router.md` — Message channel design

## Design Document

See [DESIGN.md](./DESIGN.md) for the full design specification (16 sections).
