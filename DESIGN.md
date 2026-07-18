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
│   │   ├── team.ts             ← Single /team command (11 subcommands + autocomplete)
│   │   └── status.ts           ← StatusProvider type export
│   ├── tools/
│   │   ├── tl-tools.ts         ← 7 TL process management tools (DI-based dependencies)
│   │   └── goal-tools.ts        ← Goal system: set_goal/finish_goal + agent_end reminder
│   │   (team_send_message is in member.ts directly)
│   ├── channel/
│   │   ├── message-queue.ts    ← Serial FIFO message queue (event-driven drain)
│   │   ├── router.ts           ← Message routing logic
│   │   ├── types.ts            ← Message types
│   │   ├── event-handler.ts    ← Member RPC event processing (dedup, state machine, routing)
│   │   └── response-waiter.ts  ← team_send_and_wait correlation matching + response buffer
│   ├── process/
│   │   ├── manager.ts          ← Member process lifecycle management + operational state
│   │   └── member-process.ts   ← Wrapper around child_process (write queue, size guard)
│   ├── setup/
│   │   ├── member-lifecycle.ts ← Member creation, config building, log querying
│   │   └── message-channel.ts  ← Message channel factory (queue+router+waiter wiring)
│   ├── team/
│   │   ├── definition.ts       ← Team definition YAML types & validation
│   │   ├── store.ts            ← Read/write team definition files
│   │   └── schema.ts           ← YAML schema for validation
│   ├── session/
│   │   ├── state.ts            ← Team session state tracking (structuredClone deep copy)
│   │   ├── context.ts          ← TeamContext shared mutable state interface
│   │   └── state-machine.ts    ← Pure function: MemberOperationalState transitions
│   ├── config.ts               ← getRootDir() env var override
│   ├── test/
│   │   └── fixtures/           ← Test YAMLs + mock-extension-api (with mock Theme)
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
    "@earendil-works/pi-tui": "*"
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
| User's interactive session | `"tui"`, `"rpc"`, `"json"`, `"print"` | **TL** — registers /team command with 11 subcommands, waits for `/team start` or `/team dynamic` to activate tools |
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

Validation is run at `/team create` time via a validation script (`src/team/schema.ts`).

### Workflow (optional)

Teams may define a **default workflow** that the TL references when coordinating members:

```yaml
workflow:
  # Execution mode: "strict" (must follow order) or "reference" (flexible guide)
  strictness: "reference"
  # Optional description
  description: "标准开发流程：设计 → 编码 → 审查 → 循环"
  # Ordered list of stages
  stages:
    - member: "tl"                    # "tl" for TL-operated stages
      name: "需求对齐"
      description: "与用户对齐需求和方案"
      output: "需求文档"
    - member: "architect"
      name: "架构设计"
      description: "架构方案细化设计"
      input: "需求文档"
      output: "详细设计文档"
      constraints: "考虑可扩展性和技术选型"
    - member: "coder"
      name: "编码开发"
      input: "单个任务"
      output: "代码 + 测试"
      constraints: "TDD，单步提交"
      onFailure:
        returnToStage: "编码开发"     # Stage to return to on failure
        condition: "审查不通过"       # Condition that triggers the fallback
    - member: "reviewer"
      name: "代码审查"
      input: "代码实现"
      output: "审查报告"
  # Optional while-loop sections: repeat stages while condition is true
  loops:
    - condition: "还有未完成的任务"
      stages: ["编码开发", "代码审查"]
```

### Workflow Validation Rules

- `workflow`: optional object
- `strictness`: required, one of `"strict"` | `"reference"`
- `stages`: required, non-empty array
- `stages[].member`: required, must match a `TeamMember.name` (or `"tl"`)
- `stages[].name`: required, unique within main flow
- `stages[].description`: required, non-empty
- `stages[].input` / `stages[].output` / `stages[].constraints`: optional strings
- `stages[].onFailure`: optional object with `returnToStage` (string) and `condition` (non-empty string)
- `loops`: optional array
- `loops[].condition`: required, non-empty (natural language while-condition)
- `loops[].stages`: required, string array — each entry must reference a main-flow stage name

## 5. Commands

All subcommands are registered as a single `/team` command via `registerCommand("team", ...)`. The handler dispatches based on the first argument. Tab completion for team names is supported on `/team start`, `/team show`, `/team delete`, and `/team edit` via `getArgumentCompletions` and a custom autocomplete provider that suppresses file path suggestions.

### `/team create`

**Flow:**
1. User types `/team create`
2. `teamCtx.isCreatingTeam = true`, installs **create-mode widget** (bordered widget `🆕 CREATE MODE` above editor)
3. Extension injects instructions via `before_agent_start` — includes workflow configuration dialogue prompts
4. TL converses with user, auto-derives name/label
4. After member collection, TL asks if user wants a default workflow
5. If yes: TL asks strictness → collects stages (member/name/description/input/output/constraints/onFailure) → asks about loops → confirms
6. On confirmation, TL calls `create_team_definition` tool with optional `workflow` field
7. Tool validates and saves YAML
8. No team session started

### `/team edit <name>`

**Flow:**
1. User types `/team edit <name>`
2. Reads existing team definition
3. Sets `editingTeamName`, installs **edit-mode widget** (bordered widget `✏️ EDIT MODE — <name>` above editor)
4. Injects instructions via `before_agent_start` — includes workflow modification prompts
5. TL discusses changes with user (member changes, workflow changes: add/remove/modify stages, loops, strictness)
6. On confirmation, TL calls `update_team_definition` tool with optional `workflow` field
7. Tool reads existing YAML, merges changes:
   - Members in params with missing `systemPrompt` auto-fill from stored data
   - Members not in params (existing but omitted) are deleted
   - Omit a member from `members` array to delete it
   - workflow/defaults not in params preserve existing values
   - Merged result validates and overwrites YAML
8. If workflow was removed, the field is simply omitted from the YAML

Widget is removed on: cancel, `/team start`, `/team stop`, session restart.

### `/team done` / `/team cancel`

- Ends current create or edit operation
- Resets `isCreatingTeam` and `editingTeamName` flags
- Removes create-mode widget (if creating) or edit-mode widget (if editing)
- `/team done` is the primary command; `/team cancel` kept as backward-compatible alias

**Flow:**
1. User types `/team create`
2. `teamCtx.isCreatingTeam = true`, installs create-mode widget (🆕 CREATE MODE)
3. `before_agent_start` injects creation instructions: TL auto-infers `name`/`label` from user's role description
4. TL converses with user, collects info, builds team data
5. TL calls `create_team_definition` tool → validates YAML schema → saves to `~/.pi/top-notch-team/teams/<name>.yaml`
6. `isCreatingTeam` set to `false`
7. No team session is started

### `/team dynamic`

The dynamic mode is split into two phases: **design** and **execution**.

**Phase 1: Design phase** — entered on `/team dynamic`
- `teamCtx.dynamicPhase` is set to `"design"`
- A stricter tool guard activates: `bash`/`read`/`code_search`/`fetch_content`/`edit` are **all blocked**; `write` is restricted to `.md` files only
- TL can only discuss with the user, register members with `add_dynamic_member`, and write `.shared-context.md`
- This forces TL to focus on requirements alignment and team design rather than exploring code

**Flow:**
1. Check no active session exists
2. Create temp directory `sessions/_dynamic_<ts>/`
3. Create in-memory `TeamDefinition` with 0 members, name `_dynamic_<ts>`
4. `startSession(emptyTeam)` — start session with empty team
5. `teamCtx.isDynamicSession = true`, `teamCtx.dynamicPhase = "design"`
6. Activate TL tools: `pi.setActiveTools([...current, ...tlToolNames])`
7. Install team status widget (displays "设计阶段" with 0 members)
8. `before_agent_start` handler checks `teamCtx.isDynamicSession` and injects **design phase** dynamic mode prompt (see §10)
9. Notify user that dynamic mode is active

**Lifecycle during design phase**

The TL follows the **Orchestration Playbook** (`src/prompts/orchestration-playbook.md`, injected into the design-phase prompt — see §10), a six-stage methodology with explicit completion criteria per stage:

1. **A. Requirements alignment (grilling)** — TL interviews the user one question at a time (with recommended answers), walking a question tree: goal → scope → acceptance criteria → constraints → non-goals. Cannot read/explore code.
2. **B. Task decomposition** — decompose by deliverables, draw the dependency graph (parallel/sequential/join points). Large workloads must be designed as multi-round batches (pilot batch first, inter-batch verification and adjustment).
3. **C. Workflow orchestration & quality reinforcement** — assumes agents make mistakes by default; high-risk stages get reinforcement patterns (parallel redundancy + cross-validation, adversarial debate, develop-review loop, spike-first, human checkpoints).
4. **D. Team design** — roles derived from the workflow.
5. **E. Plan confirmation gate** — TL presents a full plan document (goal, task DAG, workflow with reinforcement rationale, team roster, risks). **Hard rule: no `add_dynamic_member` / `start_member` calls until the user explicitly confirms** (prompt-enforced, not guard-enforced).
6. **F. Landing** — register members with `add_dynamic_member`, write structured Shared Context (§14) including workflow definition and failure fallback, then call `start_member` → **phase transition**

**Phase 2: Execution phase** — entered automatically on first `start_member` success
- `start_member` tool calls `onDynamicPhaseTransition()` callback → `teamCtx.dynamicPhase = "execution"`
- The design-phase tool guard lifts; standard team session guard applies (block `write`/`edit` on non-`.md` only)
- TL regains access to `bash`/`read`/`code_search`/`fetch_content` for monitoring and coordination
- The `before_agent_start` handler switches to **execution phase** prompt injection
- TL starts remaining Members, dispatches work via `team_send_and_wait`, monitors progress
- Shared Context is updated as needed
- TL reports completion; user runs `/team stop`
- `/team stop` removes `sessions/_dynamic_<ts>/` directory and resets `dynamicPhase` to `"design"`

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
1. `processManager.stopAll()` — stops all Member RPC processes (SIGTERM → SIGKILL, with `Promise.allSettled` for fault tolerance)
2. `teamCtx.clearHandles()` — clear member process handle map
3. `router.updateMembers([])` — clear message channel targets
4. `pi.setActiveTools([...filter out tlToolNames])` — deactivate TL tools
5. If dynamic session: `rmSync(sessions/_dynamic_<ts>/, {recursive:true, force:true})` and `teamCtx.isDynamicSession = false`
6. `endSession()` — clear session state
7. `before_agent_start` handler remains registered but checks `session.active` to skip injection

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

Seven tools are registered when a team session is active. They are **not** available outside a team session.

### `add_dynamic_member` (dynamic mode only)

```typescript
add_dynamic_member({ name: "coder", label: "编码员", systemPrompt: "...", model?: "..." })
```

- Only functional when `teamCtx.isDynamicSession` is `true` (i.e., during `/team dynamic`)
- Adds a `TeamMember` to the in-memory `TeamDefinition` via `addMemberToSession()`
- Refreshes the session state so `buildMemberConfig` can find the member later
- Updates `router.updateMembers()` with the new member list
- Triggers `onDynamicMemberAdded` callback for widget refresh
- Parameters: `name` (identifier), `label` (Chinese display name), `systemPrompt` (role definition), `model` (optional override)
- Error if called outside dynamic mode

### `TlToolsDeps`

```typescript
interface TlToolsDeps {
  pi: ExtensionAPI;
  manager: ProcessManager;
  responseWaiter: ResponseWaiter;
  memberOpsStates: Map<string, MemberOperationalState>;
  lastPendingCorrId: Map<string, string>;
  messageQueue: MessageQueue;
  createMember?: CreateMemberFn;
  buildMemberConfig?: BuildConfigFn;
  getMemberLog?: GetMemberLogFn;
  /** Called after a member is successfully started (for dynamic mode phase transitions). */
  onDynamicPhaseTransition?: () => void;
}
```

- `onDynamicPhaseTransition` is called after each successful `start_member` execution. In `index.ts`, it checks if `isDynamicSession && dynamicPhase === "design"` and flips to `"execution"`.

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
get_member_log({ name: "analyzer", lines: 10, maxContentLength: 200 })
```

- Reads the Member's session file via `get_messages` RPC command
- Returns last N messages from that session
- `maxContentLength` truncates each message (default 200 chars) using `slice(0, max-3) + "..."` so total length = maxContentLength
- Useful for TL to check what a Member has been working on

### `wait_and_get_member_status`

```typescript
wait_and_get_member_status()
```

- Returns the operational status (idle/working/crashed/stopped) of all members
- **Blocks** until all members are idle before returning (same all-idle detection as `team_send_and_wait`: 4 consecutive checks, 3s interval)
- Quick path: if all members are already idle, returns immediately without polling
- If no members have been started, returns immediately
- Use before `get_member_log` to determine if a member is busy or crashed

### `team_send_and_wait`

```typescript
// Single member:
team_send_and_wait({
  tasks: [{ to: "analyzer", content: "分析这段代码" }],
  nextSteps: "收到分析结果后指派 mover 执行重构",
})

// Batch mode — multiple members concurrently:
team_send_and_wait({
  tasks: [
    { to: "security-reviewer", content: "审查 XSS 风险" },
    { to: "perf-reviewer", content: "审查性能瓶颈" },
    { to: "style-reviewer", content: "审查命名规范" },
  ],
  nextSteps: "汇总所有审查意见",
})
```

- **Blocks** the tool until ALL targeted members respond or all members become idle (all-idle early return)
- **Batch mode**: multiple `{to, content}` entries in the `tasks` array are **sent concurrently** via the message queue. The tool waits for ALL to complete before returning combined results
- **Partial results**: if some members become idle without replying (e.g. crash), the tool returns results from completed members with ⚠️ markers for failures
- **Batch vs Sequential decision rule**:
  - **Batch** when tasks are **independent** — no task's output is needed to craft another task's instruction. All members work simultaneously. Wall-clock time ≈ slowest single task.
  - **Sequential** (one call per task) when task B's instructions **depend** on task A's result. Each task waits for the previous one. Wall-clock time = sum of all task durations.
  - **Mixed strategy**: batch independent discovery tasks (A+B), then use combined outputs to craft a dependent task (C). This is often the most efficient pattern.
- **Correlation matching**: each task gets its own `<corr:...>` tag for independent matching. Supports chain workflows: Member A can forward the tag to Member B
- **Auto-injection**: if a member's reply is directed to `"tl"` but lacks a `<corr:...>` tag, the TL extension automatically appends the most recent pending correlation ID for that member. This ensures responses are matched even if the member AI forgets to include the tag
- **No timeout**: waits indefinitely. The only exit paths are: all members respond, all members become idle, or `/team stop` cancels all pending waits
- **Cancellation**: on `/team stop`, all pending waits are cancelled

**Difference from `team_send_message`:**

| tool | behavior |
|------|----------|
| `team_send_message` | Fire-and-forget. Message sent, tool returns immediately. |
| `team_send_and_wait` | Messages sent, tool blocks until all responses or all idle. Combined response content returned as tool result, NOT injected into TL context via `pi.sendMessage()`. |

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
event-handler.ts (createMemberEventHandler)
  ├── agent_start → transitionState("working")
  ├── agent_end   → transitionState("idle")
  ├── tool_execution_end (team_send_message)
  │     → extract msg → dedup (recentlyProcessedMessages)
  │     → auto-populate correlationId → enqueue
  ├── process_exit / process_error
  │     → transitionState("crashed" / "stopped")
  │     → notify TL
  │     → processManager.handleExit() (auto-restart bridge)
  │        ├── Crash tracking (sliding window)
  │        ├── Exponential backoff timer (1s/2s/4s/8s/16s)
  │        └── Crash-loop detection → freeze member
  └── backup: parse <team-message> tags from assistant text

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
TEAM_MEMBERS='["analyzer","mover","verifier"]'   # JSON-serialized array of member names
TEAM_MEMBER_DESCRIPTION="你负责分析代码依赖关系..."   # system prompt content
TEAM_SESSION_DIR=~/.pi/top-notch-team/sessions/refactoring/<sessionId>/analyzer/  # session storage (isolated per session)
TEAM_SHARED_CONTEXT_PATH=~/.pi/top-notch-team/sessions/refactoring/<sessionId>/.shared-context.md  # shared context file path
```

The `member.ts` extension reads these in `session_start`, then in `before_agent_start` injects a system prompt preamble that covers: team identity, member role description, team member list, collaboration rules (including `team_send_message` usage, task completion reply requirement, and file-based deliverable output for reports/plans/designs). Members are also instructed to preserve `<corr:...>` tags when replying to TL, and are given the Shared Context file path when available.

完整的注入提示词代码见 `member.ts` 中的 `before_agent_start` 处理器。提示词涵盖：团队身份、角色描述、成员列表、协作规则（消息通道使用、完成后回复TL、文件式产出物传递、corr 标签保留），以及**沟通风格要求**（简洁精炼、剔除客套、保留术语原样）。

## 10. TL System Prompt Injection

The `before_agent_start` handler injects different prompts depending on the session type and phase:

- **Normal team session** (`/team start <name>`): Full TL prompt with team info, delegation principles, workflow stages
- **Dynamic mode — design phase** (`/team dynamic`, phase="design"): A stripped-down prompt that focuses only on requirements discussion and team design. Explicitly lists forbidden actions. TL is told its "code abilities are in sleep mode". Defines a six-stage design process (A–F) with completion criteria, and appends the full **Orchestration Playbook** loaded from `src/prompts/orchestration-playbook.md` (runtime file read relative to the module, cached, with an inline fallback summary if missing). Includes the plan confirmation gate: TL is forbidden from calling `add_dynamic_member`/`start_member` before explicit user confirmation
- **Dynamic mode — execution phase** (after first `start_member`): Similar to the normal team session prompt, with delegation principles and workflow guidance. Adds batched-dispatch guidance: when the workflow defines batches, TL dispatches batch-by-batch (verify each batch before sending the next) and reports progress as "批次 N/M"

The prompt builder function `buildDynamicModePrompt(team, phase)` in `src/prompts/dynamic-mode.ts` returns different content based on the `phase` parameter.

When `/team start` creates a team session, the extension sets up a `before_agent_start` handler that injects a structured prompt with the following sections:

- **角色定义**: "你现在是一个 Team Lead"
- **团队信息**: 名称、描述、成员列表
- **核心原则：委派优先**: 明确 TL 的职责是委派而非执行，能交给 Member 做的事绝不自己做。成员完成任务后不得主动停止其进程。TL 可以编写 .md 文档（共享上下文、ADR 等）但不得直接写代码文件
- **需求讨论方式**: 逐问确认、挑战模糊语言、用场景检验边界、对照实际代码、术语和决策立即固化到 `.shared-context.md`
- **沟通风格**: 与用户交流简洁精炼，剔除客套话、语气词、多余铺垫
- **可用工具**: 6 个团队管理工具（start_member、stop_member、list_members、get_member_log、wait_and_get_member_status、team_send_and_wait）的介绍和使用指引
- **工作流程**: 从需求讨论→拆解任务→编写共享上下文→启动 Member→分配任务（注明完成后必须回复TL）→监控进展→汇报结果的 9 个步骤
- **默认工作流（可选）**: 如果团队配置了 `workflow` 字段，注入工作流阶段序列和循环段。Strict 模式注入强制顺序执行规则（"严格按照以下步骤执行，不得跳过或调序"），Reference 模式注入参考指引（"作为工作流程参考，尽可能遵循步骤顺序"）

完整的注入提示词代码见 `index.ts` 中的 `before_agent_start` 处理器。

### 工作流注入示例（Reference 模式）

当团队配置了 workflow 时，`before_agent_start` 会在团队信息之后注入如下内容：

```markdown
### 默认工作流（参考模式 📋）
作为工作流程参考，尽可能遵循步骤顺序。

**描述：** 标准开发流程：设计 → 编码 → 审查 → 循环

**步骤序列：**
  【需求对齐】与用户对齐需求和方案 (tl)
    输出：需求文档

  【架构设计】架构方案细化设计 (architect)
    输入：需求文档
    输出：详细设计文档
    约束：考虑可扩展性和技术选型

  【编码开发】实现功能模块 (coder)
    输入：设计文档
    输出：代码 + 测试
    约束：TDD，单步提交
    失败处理：如「审查不通过」→ 回退至「编码开发」

  【代码审查】审查代码实现 (reviewer)
    输入：代码实现
    输出：审查报告

**循环段：**
  🔁 条件「还有未完成的任务」→ 重复步骤：编码开发、代码审查
```

Strict 模式的注入类似，但文案强调"严格按照以下步骤执行，不得跳过或调序"，并在末尾追加规则："完成上一个 stage 前不得开始下一个。Stage 失败时按 onFailure 策略处理。"

此外，扩展注册了一个 `tool_call` 事件拦截器，在不同阶段有不同的限制规则：

**标准团队会话 / 执行阶段：**
- TL 的 `write`/`edit` 工具调用会被检查目标文件路径。仅 `.md` 文件允许直接写入，代码文件（`.ts`、`.js`、`.py` 等）会被拦截并提示委派给 Member。

**动态模式设计阶段（更严格）：**
- `bash`、`read`、`code_search`、`fetch_content`、`edit` 全部被阻断，TL 无法探索代码或修改任何文件
- `write` 仅允许 `.md` 文件（用于编写 shared-context.md 和 ADR）
- 设计阶段的阻断在首次 `start_member` 成功后自动解除（同时 `dynamicPhase` 切换至 `"execution"`）

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
  editingTeamName: string | null;
  isDynamicSession: boolean;  // true during /team dynamic
  dynamicPhase: "design" | "execution";  // dynamic mode phase (only relevant when isDynamicSession is true)
  processManager: ProcessManager | null;
  memberHandles: ReadonlyMap<string, MemberProcessHandle>; // use getHandle()/setHandle()/clearHandles()
  router: Router;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
  tlToolNames: string[];
  memberOperationalStates: Map<string, MemberOperationalState> | null;
  onSessionStart?: (ui: any) => void;
  onSessionEnd?: () => void;
  onEditStart?: (ui: any) => void;   // called by /team edit to install edit-mode widget
  onEditEnd?: () => void;            // called on cancel/save/start/stop to remove widget
  onCreateStart?: (ui: any) => void; // called by /team create to install create-mode widget
  onCreateEnd?: () => void;          // called on cancel/save/start/stop to remove widget
}
```

**`dynamicPhase`** tracks which phase a dynamic session is in:
- `"design"`: TL is restricted from exploratory tools (bash/read/code_search/fetch_content/edit), can only discuss and design
- `"execution"`: Full tool access restored (standard team session guard still blocks non-.md write/edit)
- Transition from `"design"` → `"execution"` happens automatically on first `start_member` success, via the `onDynamicPhaseTransition` callback wired in `index.ts`

Session state (active + team definition) is stored in `session/state.ts` as a module-level variable. Member process handles, message channel, and other runtime objects are in `TeamContext` passed to command handlers. On `/team stop`, all processes are terminated, handles cleared, and state reset.

**`addMemberToSession(member: TeamMember): TeamDefinition`** — Adds a member to the active session's team definition and refreshes the session state. Used by the `add_dynamic_member` tool during `/team dynamic`. Throws if no active session.

## 12. Error Handling

### Member process crash

1. The Member's `ChildProcess` emits `"exit"` with non-zero code
2. `MemberProcessManager` detects the unexpected exit
3. Manager logs the crash and notifies TL; no auto-restart (prevents crash loops)
4. TL is notified via a custom message: "Member 'analyzer' 进程异常退出（code: 1），需检查崩溃原因。"
   - Exit code 143 (SIGTERM) is treated as normal stop via `stop_member`, no notification sent
5. TL can use `start_member` to manually restart after investigating

### Member process stuck / unresponsive

- `wait_and_get_member_status` RPC command times out → status is reported as "error"
- TL can use `stop_member` + `start_member` to restart

### TL crash

- All Member RPC processes become orphaned
- On restart, the team session must be explicitly started again (`/team start`)
- Member session files persist, so Members pick up where they left off

## 13. Session File Storage

Each team session gets a unique `sessionId` (timestamp + random suffix) to isolate session data across multiple uses of the same pre-defined team:

```
~/.pi/top-notch-team/
├── teams/
│   └── refactoring.yaml
└── sessions/
    └── refactoring/
        └── <sessionId>/            ← unique per session
            ├── .shared-context.md   ← shared context (session-scoped)
            ├── analyzer/
            │   └── session.jsonl
            ├── mover/
            │   └── session.jsonl
            └── verifier/
                └── session.jsonl
```

Dynamic sessions (`_dynamic_<ts>`) use their unique team name for isolation:

```
~/.pi/top-notch-team/
└── sessions/
    └── _dynamic_1719200000000/     ← timestamp-based, unique per session
        ├── .shared-context.md
        └── coder/
            └── session.jsonl
```

Member sessions use `pi --mode rpc --session-dir <path>` so session files are persisted and recoverable.
On `/team stop`, the session subdirectory (`<sessionId>`) is removed entirely.

## 14. Shared Context

### Purpose

The Shared Context is a Markdown document maintained by the TL during a team session. It ensures all team members are aligned on goals, terminology, progress, and collaboration rules.

### Storage

```
~/.pi/top-notch-team/sessions/refactoring/<sessionId>/.shared-context.md
```

Where `<sessionId>` is generated at session start (e.g. `m0xvk-j3kl`). This ensures repeated sessions of the same team don't conflict.

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
