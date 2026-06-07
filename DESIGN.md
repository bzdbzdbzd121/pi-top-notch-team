# pi-top-notch-team — Design Document

## 1. Overview

pi-top-notch-team is a pi agent extension that enables multi-agent collaboration on complex, long-running tasks. Users define teams of specialized agent roles. When a team session starts, the user's current pi session becomes the **Team Lead (TL)**, which orchestrates **Member** agents — each running as an independent `pi --mode rpc` subprocess.

The TL clarifies requirements with the user, breaks down tasks into a plan, spawns Member processes, and coordinates them via a real-time message channel. Members work independently with their own session context and can communicate with each other through the channel. The user decides when the session ends.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's pi session                      │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │          pi-top-notch-team extension              │    │
│  │                                                    │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  │    │
│  │  │  Commands   │  │  TL Tools    │  │ Message  │  │    │
│  │  │  (8 total)  │  │ (process mgt)│  │ Router   │  │    │
│  │  └─────────────┘  └──────────────┘  └─────┬────┘  │    │
│  │                                            │       │    │
│  │  ┌─────────────────────────────────────────┴───┐   │    │
│  │  │            Member Process Manager           │   │    │
│  │  │  (spawn / monitor / restart / terminate)    │   │    │
│  │  └────┬──────────────┬──────────────┬──────────┘   │    │
│  └───────┼──────────────┼──────────────┼──────────────┘    │
│          │              │              │                    │
└──────────┼──────────────┼──────────────┼────────────────────┘
           │              │              │
    stdin/ │ stdout       │              │
           │              │              │
  ┌────────▼──┐   ┌───────▼───┐   ┌─────▼──────┐
  │ pi --mode │   │ pi --mode │   │ pi --mode  │
  │ rpc       │   │ rpc       │   │ rpc        │
  │ Member A  │   │ Member B  │   │ Member C   │
  │ (analyzer)│   │ (mover)   │   │ (verifier) │
  └───────────┘   └───────────┘   └────────────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
              Message Channel (routed via TL)
```

### Communication Flows

| Direction | Mechanism |
|-----------|-----------|
| TL → Member A | TL writes `prompt` JSONL command to Member A's RPC stdin |
| Member A → TL (result) | Member A's RPC process emits events to stdout; TL reads `tool_execution_end` and other events |
| Member A → Member B | Member A calls `team_send_message` tool → `tool_execution_end` event emitted → TL reads from A's stdout → global queue → TL writes `prompt` to B's stdin |

## 3. Package Structure

This project is a **pi package** installable via `pi install ./pi-top-notch-team` or `pi install git:github.com/user/pi-top-notch-team`. The `package.json` declares a `pi` manifest that points pi to the extension entry points.

### Layout

```
pi-top-notch-team/
├── DESIGN.md
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-members-as-independent-pi-rpc-processes.md
│       └── 0002-tl-as-central-message-router.md
├── package.json              ← pi package manifest (see below)
├── tsconfig.json
├── index.ts                  ← Extension entry point — TL side (auto-discovered via pi manifest)
├── member.ts                 ← Extension entry point — Member side (auto-discovered via pi manifest)
├── src/
│   ├── commands/
│   │   ├── team.ts             ← Single /team command (10 subcommands + autocomplete)
│   │   └── status.ts           ← StatusProvider type export
│   ├── tools/
│   │   └── tl-tools.ts         ← TL process management tool registrations
│   │   (team_send_message is in member.ts directly)
│   ├── channel/
│   │   ├── message-queue.ts    ← Global serial message queue
│   │   ├── router.ts           ← Message routing logic
│   │   └── types.ts            ← Message types
│   ├── process/
│   │   ├── manager.ts          ← Member process lifecycle management
│   │   └── member-process.ts   ← Wrapper around child_process for a single Member
│   ├── team/
│   │   ├── definition.ts       ← Team definition YAML types & validation
│   │   ├── store.ts            ← Read/write team definition files
│   │   └── schema.ts           ← YAML schema for validation
│   ├── session/
│   │   ├── state.ts            ← Team session state tracking
│   │   └── context.ts          ← TeamContext shared mutable state interface
│   ├── config.ts               ← getRootDir() env var override
│   ├── test/
│   │   └── fixtures/           ← Test YAMLs + mock-extension-api
│   └── smoke.test.ts           ← Test infrastructure smoke test
```

### package.json

```json
{
  "name": "pi-top-notch-team",
  "version": "0.1.0",
  "description": "Multi-agent team collaboration for pi agent",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": {
    "extensions": [
      "./index.ts",
      "./member.ts"
    ]
  },
  "dependencies": {
    "yaml": "^2.7.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

- Both `index.ts` (TL extension) and `member.ts` (Member extension) are declared in the `pi.extensions` array. When pi loads the package, both are registered. The TL extension checks whether it is running in RPC mode (via `ctx.mode`) to determine which features to activate — see §3a.
- Runtime dependencies (e.g., `yaml` for YAML parsing) go in `dependencies`.

### §3a: Extension Mode Detection

Since TL and Member are declared as two separate extensions, but both are loaded into every pi session, each must detect its role at runtime:

| Scenario | `ctx.mode` | Role |
|----------|-----------|------|
| User's interactive session | `"tui"`, `"rpc"`, `"json"`, `"print"` | **TL** — registers /team command with 10 subcommands, waits for `/team start` to activate tools |
| Member RPC process | `"rpc"` | **Member** — registers `team_send_message` tool, injects team system prompt via env vars |

**Detection logic:**
- `index.ts` (TL side): always registers commands and tools. TL tools are **deactivated** by default (not in active set) and activated when `/team start` calls `pi.setActiveTools()`. No mode check needed.
- `member.ts` (Member side): checks `process.env.TEAM_ROLE` at startup. If not set, exits early (no tools registered).

**Detection logic in `member.ts`:**

```typescript
export default function (pi: ExtensionAPI) {
  const role = process.env.TEAM_ROLE;
  const teamName = process.env.TEAM_NAME;

  // Only activate if this process was launched as a Member
  if (!role || !teamName) {
    return; // Early exit — no tools registered
  }

  // Register team_send_message tool
  // Inject team system prompt via before_agent_start
}
```

## 4. Team Definition (YAML Schema)

### Location

```
~/.pi/top-notch-team/teams/<team-name>.yaml
```

### Schema

```yaml
# Team name (used as identifier in commands like /team start <name>)
name: "refactoring"

# Human-readable description
description: "负责大型代码重构任务"

# Defaults applied to all Members (optional)
defaults:
  model: "anthropic/claude-sonnet-4"

# Member roles (at least 1)
members:
  - name: "analyzer"            # Unique within team; used as identifier
    label: "代码分析员"            # Human-readable role name (optional)
    systemPrompt: |              # System prompt defining role behavior
      你是一个代码分析专家。你擅长理解代码结构...
    # model: "..."              # Override default model for this Member (optional)
```

### Validation Rules

- `name`: required, lowercase alphanumeric + hyphens, unique per team file, filename-safe
- `description`: required, non-empty
- `defaults.model`: optional, valid model string
- `members`: required, array, at least 1 entry
- `members[].name`: required, same rules as team name, unique within team
- `members[].label`: optional, defaults to `name`
- `members[].systemPrompt`: required, non-empty
- `members[].model`: optional, overrides `defaults.model`

Validation is run at `/team create` time via a validation script.

## 5. Commands

All subcommands are registered as a single `/team` command via `registerCommand("team", ...)`. The handler dispatches based on the first argument. Tab completion for team names is supported on `/team start`, `/team show`, `/team delete`, and `/team edit` via `getArgumentCompletions` and a custom autocomplete provider that suppresses file path suggestions.

### `/team create`

**Flow:**
1. User types `/team create`
2. Extension injects instructions via `before_agent_start`
3. TL converses with user, auto-derives name/label
4. On confirmation, TL calls `create_team_definition` tool
5. Tool validates and saves YAML
6. No team session started

### `/team edit <name>`

**Flow:**
1. User types `/team edit <name>`
2. Reads existing team definition
3. Sets `editingTeamName`, injects instructions via `before_agent_start`
4. TL discusses changes with user
5. On confirmation, TL calls `update_team_definition` tool
6. Tool validates and overwrites YAML

### `/team cancel`

- Cancels current create or edit operation
- Resets `isCreatingTeam` and `editingTeamName` flags

**Flow:**
1. User types `/team create`
2. `teamCtx.isCreatingTeam = true`
3. `before_agent_start` injects creation instructions: TL auto-infers `name`/`label` from user's role description
4. TL converses with user, collects info, builds team data
5. TL calls `create_team_definition` tool → validates YAML schema → saves to `~/.pi/top-notch-team/teams/<name>.yaml`
6. `isCreatingTeam` set to `false`
7. No team session is started

### `/team start <name>`

**Flow:**
1. Read team definition from `~/.pi/top-notch-team/teams/<name>.yaml`
2. Start session state via `startSession(team)`
3. Update router's member list: `router.updateMembers(team.members.map(m => m.name))`
4. Activate TL tools: `pi.setActiveTools([...current, ...tlToolNames])`
5. `before_agent_start` handler checks `session.active` and injects TL system prompt (see §10)
6. Notify user that team is ready

**Lifecycle after `/team start`** (see also: CONTEXT.md):
1. TL clarifies requirements with the user (possibly multiple rounds)
2. TL breaks down tasks, creates a plan, and writes the **Shared Context** (§14)
3. TL calls `start_member` to launch Member RPC processes
4. TL sends Shared Context to Members along with initial task assignments
5. TL and Members communicate via the message channel; TL monitors progress
6. TL updates Shared Context as needed and notifies Members
7. TL reports completion to user when all tasks are done
8. User decides when to run `/team stop`

### `/team stop`

**Flow:**
1. `processManager.stopAll()` — stops all Member RPC processes (SIGTERM → SIGKILL)
2. Clear `memberHandles` map
3. `router.updateMembers([])` — clear message channel targets
4. `pi.setActiveTools([...filter out tlToolNames])` — deactivate TL tools
5. `endSession()` — clear session state
6. `before_agent_start` handler remains registered but checks `session.active` to skip injection

### `/team list`

- Scan `~/.pi/top-notch-team/teams/*.yaml`
- Display each team's name and description

### `/team show <name>`

- Read and parse the YAML file
- Display formatted output: name, description, default model, each member's name, label, and prompt preview

### `/team delete <name>`

- Confirm with user
- Delete the YAML file
- Notify user

### `/team status`

- Check if a team session is currently active
- If active, list each Member's process state with status icons (🟢 running / ⚪ stopped / 🔴 error)
- If not active, display "无活跃团队会话"

### `/team help`

- Display usage help listing all subcommands and their descriptions

## 6. TL Process Management Tools

Four tools are registered when a team session is active. They are **not** available outside a team session.

### `start_member`

```typescript
start_member({ name: "analyzer" })
```

- Reads the team definition for the named Member's config
- Resolves the working directory (same as user's CWD)
- Spawns: `pi --mode rpc -e <member-extension-path> --session-dir <session-dir>`
- Sets environment variables on the subprocess (see §8)
- Connects to RPC stdin/stdout
- Adds the Member to the process manager's tracking
- Registers RPC event listener for `tool_execution_end` to detect `team_send_message`
- Returns status: `{ name: "analyzer", pid: 12345, status: "running" }`

### `stop_member`

```typescript
stop_member({ name: "analyzer" })
```

- Sends SIGTERM to the Member's process
- If process doesn't exit within grace period, sends SIGKILL
- Removes from process manager tracking
- Returns status: `{ name: "analyzer", status: "stopped" }`

### `list_members`

```typescript
list_members()
```

- Returns array of all Member process statuses:
```json
[
  { "name": "analyzer", "pid": 12345, "status": "running" },
  { "name": "mover", "pid": 12346, "status": "running" },
  { "name": "verifier", "pid": null, "status": "stopped" }
]
```

### `get_member_log`

```typescript
get_member_log({ name: "analyzer", lines: 10 })
```

- Reads the Member's session file via `get_messages` RPC command
- Returns last N messages from that session
- Useful for TL to check what a Member has been working on

### `team_send_and_wait`

```typescript
team_send_and_wait({
  to: "analyzer",             // target member name
  content: "分析这段代码",     // message body
  timeout: 120_000            // optional, max wait in ms (default 120000, max 300000)
})
```

- **Enqueues** a message to the target member with a correlation ID embedded
- **Blocks** (returns a Promise that resolves when a matching response arrives)
- **Correlation matching**: scans incoming messages for `<corr:...>` tags matching the original correlation ID. Supports chain workflows: Member A can forward the `<corr:...>` tag to Member B, and B's reply to TL resolves the original wait
- **Auto-injection**: if a member's reply is directed to `"tl"` but lacks a `<corr:...>` tag, the TL extension automatically appends the most recent pending correlation ID for that member. This ensures responses are matched even if the member AI forgets to include the tag
- **Timeout**: if no response within `timeout` ms, returns `{ status: "timeout" }` — TL should check member status and re-wait if needed
- **Cancellation**: on `/team stop`, all pending waits are cancelled

**Difference from `team_send_message`:**

| tool | behavior |
|------|----------|
| `team_send_message` | Fire-and-forget. Message sent, tool returns immediately. |
| `team_send_and_wait` | Message sent, tool blocks until response or timeout. Response content is returned as tool result, NOT injected into TL context via `pi.sendMessage()`. |

## 7. Member Tool: `team_send_message`

Registered by `member.ts` extension loaded in each Member's pi RPC process.

```typescript
team_send_message({
  to: "mover",                    // target member name, or "tl" for Team Lead
  subject: "分析结果",             // optional subject
  content: "依赖分析完成..."        // message body
})
```

- The `execute` function returns the message data as the tool result
- The TL detects this via `tool_execution_end` event where `toolName === "team_send_message"`
- TL extracts `{ from: "<sender>", to, subject, content }` from the event's result
- TL enqueues the message into the message queue for routing

## 8. Message Channel

### Architecture

```
Member A's RPC stdout
  │
  ▼
on('tool_execution_end')
  ├── toolName === "team_send_message"?
  │     YES → extract { from, to, subject, content, correlationId }
  │            → enqueue(Message)
  │
  └── NO → ignore (other tools), pass through
         → also check for <team-message> in text content (backup parse)

Message Queue (FIFO)
  │
  ▼
Router (processes one message at a time)
  │
  ├── to === "tl"
  │     → ResponseWaiter.check(msg.correlationId or scan content for <corr:...>)
  │       ├── MATCH → resolve pending wait (skip pi.sendMessage())
  │       └── NO MATCH → inject into TL's session via pi.sendMessage()
  │
  ├── to === "<member>"     → write prompt to target Member's RPC stdin
  ├── to === "all"          → write prompt to ALL Members' RPC stdin
  └── to === unknown        → log warning, drop
```

### Message Types

```typescript
interface TeamMessage {
  id: string;          // uuid
  from: string;        // sender member name or "tl"
  to: string;          // target member name, "tl", or "all"
  subject?: string;
  content: string;
  timestamp: number;   // Date.now()
  correlationId?: string;  // for send_and_wait matching
}
```

### Routing to TL

The TL is the user's pi session, not an RPC process. Messages addressed to `"tl"` are injected into the TL's session using `pi.sendMessage()` with a custom message type, so the TL sees the incoming message in its conversation context.

### Detecting Member-to-Member Messages

The TL extension listens for `tool_execution_end` events on each Member's RPC stdout stream. When the tool name is `team_send_message`, the TL:

1. Extracts the message from the event's `result.content`
2. Wraps it into a `TeamMessage` with the sender's name
3. Enqueues it

A secondary text-based fallback parse also scans the Member's assistant text output for `<team-message>` tags, to catch cases where the LLM writes out a message instead of calling the tool.

## 9. Member Awareness (Environment Variables)

When TL spawns a Member's pi RPC process, it sets these environment variables:

```bash
TEAM_ROLE=analyzer              # member name from YAML
TEAM_ROLE_LABEL=代码分析员        # human-readable label
TEAM_NAME=refactoring           
TEAM_MEMBERS=analyzer,mover,verifier   # comma-separated list of all member names
TEAM_MEMBER_DESCRIPTION="你负责分析代码依赖关系..."   # system prompt content
TEAM_SESSION_DIR=~/.pi/top-notch-team/sessions/refactoring/analyzer/  # session storage
TEAM_SHARED_CONTEXT_PATH=~/.pi/top-notch-team/sessions/refactoring/.shared-context.md  # shared context file path
```

The `member.ts` extension reads these in `session_start`, then in `before_agent_start` injects a system prompt preamble:

> 你是重构团队（refactoring）的 analyzer（代码分析员）。
> 团队其他成员：analyzer、mover、verifier。
> 你可以使用 `team_send_message` 工具与其他成员或 Team Lead 交流。
> Team Lead 会通过消息通道给你分配任务。

## 10. TL System Prompt Injection

When `/team start` creates a team session, the extension sets up a `before_agent_start` handler that injects:

> 你现在是一个 Team Lead。团队名称：refactoring。
> 团队成员：
>   - analyzer（代码分析员）—— 负责分析代码依赖
>   - mover（代码迁移员） —— 负责执行代码迁移
>   - verifier（验证员） ———— 负责验证和测试
>
> 你拥有 4 个新工具：
> - `start_member` —— 启动一个 Member 进程
> - `stop_member` —— 终止一个 Member 进程
> - `list_members` —— 查看所有 Member 状态
> - `get_member_log` —— 查看 Member 最近的对话
>
> 你也拥有消息通道。你可以通过和 Member 一样的 `team_send_message` 工具（以 "tl" 为发送者）向 Member 发消息。
>
> 流程：
> 1. 先与用户充分讨论需求，直到和用户对齐细节
> 2. 拆解任务，制定计划
> 3. 编写 Shared Context（共享上下文），记录：团队成员、项目背景和目标、协作规则、术语表
> 4. 用 start_member 启动 Member
> 5. 将 Shared Context 随首次任务消息一起发送给各 Member
> 6. 通过消息通道与 Member 交流，监控进展
> 7. 根据需要更新 Shared Context，并通过消息通道通知所有 Member 重新阅读
> 8. 任务完成后向用户汇报结果
> 9. 让用户决定是否 /team stop

The handler stays registered for the entire pi session but checks `session.active` to decide whether to inject TL instructions. When `/team stop` ends the session, `session.active` becomes `false` and no extra prompt is injected.

## 11. Team Session State

```typescript
// src/session/state.ts — lightweight session state
interface TeamSessionState {
  active: boolean;
  teamDefinition: TeamDefinition | null;
  startedAt: number | null;
}

// src/session/context.ts — shared mutable references for the extension
interface TeamContext {
  isCreatingTeam: boolean;
  processManager: ProcessManager | null;
  memberHandles: Map<string, MemberProcessHandle>;
  router: Router;
  messageQueue: MessageQueue;
  tlToolNames: string[];
}
```

Session state (active + team definition) is stored in `session/state.ts` as a module-level variable. Member process handles, message channel, and other runtime objects are in `TeamContext` passed to command handlers. On `/team stop`, all processes are terminated, handles cleared, and state reset.

## 12. Error Handling

### Member process crash

1. The Member's `ChildProcess` emits `"exit"` with non-zero code
2. `MemberProcessManager` detects the unexpected exit
3. Manager logs the crash and notifies TL; no auto-restart (prevents crash loops)
4. TL is notified via a custom message: "Member 'analyzer' 进程异常退出（code: 1），需检查崩溃原因。"
   - Exit code 143 (SIGTERM) is treated as normal stop via `stop_member`, no notification sent
5. TL can use `start_member` to manually restart after investigating

### Member process stuck / unresponsive

- `get_member_status` RPC command times out → status is reported as "error"
- TL can use `stop_member` + `start_member` to restart

### TL crash

- All Member RPC processes become orphaned
- On restart, the team session must be explicitly started again (`/team start`)
- Member session files persist, so Members pick up where they left off

## 13. Session File Storage

```
~/.pi/top-notch-team/
├── teams/
│   └── refactoring.yaml
└── sessions/
    └── refactoring/
        ├── analyzer/
        │   └── session.jsonl
        ├── mover/
        │   └── session.jsonl
        └── verifier/
            └── session.jsonl
```

Member sessions use `pi --mode rpc --session-dir <path>` so session files are persisted and recoverable.

## 14. Shared Context

### Purpose

The Shared Context is a Markdown document maintained by the TL during a team session. It ensures all team members are aligned on goals, terminology, progress, and collaboration rules.

### Storage

```
~/.pi/top-notch-team/sessions/refactoring/.shared-context.md
```

### Contents

When creating or updating the Shared Context, the TL includes:

```markdown
# Team Session: refactoring

## Team Members
- analyzer（代码分析员）— 分析代码结构和依赖关系
- mover（代码迁移员）— 执行代码迁移操作
- verifier（验证员）— 验证迁移后的代码正确性

## Project Background & Goals
项目背景：[TL 撰写的背景说明]
目标：[TL 撰写的具体目标]

## Collaboration Rules
- 所有 Member 通过消息通道交流
- 发现问题先通过消息通道与相关 Member 讨论
- 重大变更需先向 TL 汇报

## Glossary
- "Module" = 按功能划分的代码单元
- "Package" = 可独立发布的 npm 包
- ...

## Current Progress
- [x] 依赖分析完成（analyzer）
- [ ] 代码迁移进行中（mover）
- [ ] 验证待开始（verifier）
```

### Lifecycle

1. **Creation**: After TL clarifies requirements with the user and before spawning Members, the TL writes the Shared Context as a Markdown file
2. **Initial delivery**: When TL sends the first task to a Member, the Shared Context is included as part of the task message
3. **Updates**: When TL determines the Shared Context needs updating (e.g., goal refined, glossary term added, progress checkpoint), TL:
   - Rewrites the file
   - Sends a message to all Members via the message channel: "共享上下文已更新，请重新阅读 .shared-context.md"
4. **Member behavior**: Members are instructed via system prompt to read the Shared Context when starting a new task, and to re-read it upon receiving an update notification

### File path convention

Members receive the Shared Context file path as an environment variable at startup:

```bash
TEAM_SHARED_CONTEXT_PATH=~/.pi/top-notch-team/sessions/refactoring/.shared-context.md
```

## 15. Testing Strategy

### Framework

- **vitest** — TypeScript-native test runner (same as pi core)
- Tests live alongside source: `src/**/*.test.ts`
- `npm run test` — run all tests
- `npm run test:watch` — TDD watch mode

### Test Levels

| Level | What | Mock Strategy | Test Framework |
|-------|------|---------------|----------------|
| **Unit** | Pure logic: YAML validation, message queue, routing, session state, env var helpers | None (pure functions) | vitest |
| **Integration** | pi-dependent: command handlers, tl-tools, member.ts, process manager | Mock `ExtensionAPI`, `ChildProcess`, `WritableStream` via `vi.mock()` or factory injection | vitest + vi |
| **E2E** | Real pi RPC: spawn `pi --mode rpc`, send JSONL, verify events | Real pi binary (no mocking) | vitest + exec |

### Patterns

**Unit TDD cycle** (for each pure module):
1. Write test with expected behavior and known inputs/outputs
2. Implement the module until test passes
3. Refactor

**Integration TDD cycle** (for pi-dependent modules):
1. Write test with mocked `ExtensionAPI`
2. Implement the handler/tool
3. Verify: mock was called with expected arguments, return value is correct

**E2E tests** (for critical paths only):
- Start a Member pi RPC process, send a prompt, assert on events
- Test that `team_send_message` tool is available to the Member LLM
- Test process crash (TL notified without auto-restart)

### Fixtures & Factories

Test helper functions in `src/test/`:

```
src/test/
├── fixtures/
│   ├── valid-team.yaml        ← A valid team definition for YAML tests
│   ├── invalid-team.yaml      ← An invalid one
│   └── mock-extension-api.ts  ← Factory to create a mock ExtensionAPI
```

## 16. Implementation Order (TDD)

Every step follows the TDD cycle: **write test → implement → refactor**.

### Phase 0: Test Infrastructure
1. Set up `package.json`, `tsconfig.json`, `vitest.config.ts`
2. Create `src/test/fixtures/` with test YAML files
3. Write and run the first passing test (smoke test)

### Phase 1: Foundation (unit tests first)
4. `src/team/definition.ts` — types + TDD
5. `src/team/schema.ts` — validation schema + TDD
6. `src/team/store.ts` — file read/write + TDD
7. `src/test/fixtures/mock-extension-api.ts` — mock factory
8. `/team` command with all subcommands + TDD
9. Manual smoke test: `/team create`, `list`, `show`, `delete` work

### Phase 2: TL Tools + Member Process (integration tests first)
10. `src/process/member-process.ts` — spawn pi RPC, connect stdin/stdout + TDD
11. `src/process/manager.ts` — process lifecycle + TDD
12. `src/tools/tl-tools.ts` — 4 process management tools + TDD
13. System prompt injection — inlined in `index.ts` (TL) and `member.ts` (Member)
14. Manual smoke test: `/team start` and `/team stop` work end-to-end

### Phase 3: Message Channel + Shared Context (mix of unit + integration)
15. `src/channel/types.ts` — TeamMessage type (no test needed, just types)
16. `src/channel/message-queue.ts` — serial FIFO queue + TDD (unit)
17. `src/channel/router.ts` — routing logic + TDD (unit)
18. `member.ts` — `team_send_message` tool (inline in member extension)
19. Wire `tool_execution_end` listener in `member-process.ts` + `index.ts` + TDD (integration)
20. Member env var + system prompt injection in `member.ts`
21. Update TL system prompt (§10) for Shared Context
22. E2E test: Member-to-Member and Member-to-TL messaging

### Phase 4: Polish (mix of all levels)
23. `src/session/state.ts` — session state tracking + TDD
24. `get_member_log` — read Member session via RPC + TDD (integration)
25. Auto-restart on Member crash + TDD (integration)
26. `/team status` command — full status display + TDD
27. E2E test: full team session lifecycle
