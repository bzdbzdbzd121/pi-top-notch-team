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
│  │  │  (14 cmds)  │  │ (session +   │  │ Router   │  │    │
│  │  │             │  │ autonomous) │  │          │  │    │
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
│       ├── 0002-tl-as-central-message-router.md
│       ├── 0003-agent-initiated-team-sessions.md
│       ├── 0004-team-session-resume.md
│       ├── 0005-pi-upstream-truncation-marking.md
│       ├── 0006-pi-upstream-abort-compaction-rpc.md
│       └── 0007-pi-upstream-context-usage-reason.md
├── package.json              ← pi package manifest (see below)
├── scripts/
│   └── check-goal-reminder.mjs ← Stage 3 static lifecycle/wording/release guard
├── tsconfig.json
├── index.ts                  ← Extension entry point — TL side (auto-discovered via pi manifest)
├── member.ts                 ← Extension entry point — Member side (auto-discovered via pi manifest)
├── src/
│   ├── commands/
│   │   ├── team.ts             ← Single /team command (14 subcommands + autocomplete)
│   │   └── status.ts           ← StatusProvider type export
│   ├── tools/
│   │   ├── tl-tools.ts         ← 6 TL process management tools (DI-based dependencies)
│   │   ├── goal-tools.ts        ← Goal system: set_goal/finish_goal + settled-boundary reminder delivery
│   │   ├── goal-tools.test.ts   ← Goal lifecycle, rollover, abort, cooldown, failure, and marker unit tests
│   │   └── goal-tools.agent-session.test.ts ← Real pi 0.83.0 AgentSession lifecycle/void-wrapper integration tests
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
│   │   ├── session-tool-visibility.ts ← 会话工具可见性强制（纯函数）：9 个团队会话工具首次会话按需注册、会话期间激活，teardown 后 registry 保留、会话外从 activeTools 移除；before_agent_start 回合边界强制执行
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
| User's interactive session | `"tui"`, `"rpc"`, `"json"`, `"print"` | **TL** — registers /team command with 14 subcommands, waits for `/team start`, `/team dynamic`, or `start_team_session` to activate session tools |
| Member RPC process | `"rpc"` | **Member** — registers `team_send_message` tool, injects team system prompt via env vars |

**Detection logic:**
- `index.ts` (TL side): registers the /team command at load; registers team tools **only on session start** (`onSessionStart` → `ensureSessionToolsRegistered`) and enforces registration+activation at every `before_agent_start` turn boundary (`enforceSessionToolVisibility`). Because pi has no unregister API, tools remain registered after the first session; outside a session they are removed from `activeTools` and therefore not visible or callable. No mode check needed.
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
- A **whitelist-based** tool guard activates: only team management tools + `write` (`.md` only) are allowed. All other tools (including `bash`, `read`, `web_search`, `fetch_content`, `edit`, `ctx_*`, `mcp`, etc.) are blocked at runtime. （user 来源会话路径——agent 来源会话早退旁路白名单，见 §18）
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
- The design-phase tool guard lifts; execution phase whitelist applies (team management + read-only analysis tools + `write`/`edit` on `.md` only)（user 来源会话路径；agent 来源会话早退旁路，见 §18）
- TL regains access to `bash`/`read`/`web_search`/`fetch_content`/`ctx_search`/`true_sight_*` for monitoring and coordination, but tools like `ctx_execute`/`mcp` remain blocked
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
5. `markManifestStopped(team, sessionId)` — mark `session.json` as `stopped`; **the session directory is PRESERVED** (member contexts + shared context stay resumable via `/team resume`; see ADR-0004). Dynamic sessions reset `teamCtx.isDynamicSession = false`
6. `endSession()` + `resetGoal()` + `resetManifestRuntimeContext()` — clear in-memory state. **Before that**, if a session was active, `teamCtx.sessionEndedNotice = true` — a one-shot notice consumed by the next `before_agent_start`
7. `before_agent_start` handler remains registered but checks `session.active` to skip injection — except the **one-shot session-ended banner**: when `sessionEndedNotice` is set and no session is active, the next turn's prompt gets a ⚠️ banner (「团队会话已结束…团队工具已停用…请以普通模式继续」) so the TL stops acting as Team Lead and stops calling deactivated team tools (which would otherwise fail with the cryptic `Tool xxx not found`). It rides the next user-initiated turn — **no new conversation is triggered**. Consumed exactly once; cleared silently if a new session starts first. **Edge-case guards** (stale notice in replaced conversations): `session_start` with `reason: "new"` drops a pending notice (a fresh `/new` conversation has no team history); at consumption, `historyHasTeamTraces()` checks the current entries for durable team traces (assistant `toolCall` named after a team tool, or a `custom_message` entry with `customType: "team-message"`) and skips the banner when none exist — this covers `/resume` of a *different non-team* conversation, while `/fork`/`/resume` of a team conversation copy the traces and keep the banner (exactly what the TL needs there). No session manager → fail-open (inject). **措辞权威化（真实 E2E 复现后修正）**：细粒度检测发现横幅**一直在注入**，但 TL 仍答「仍是我 Team Lead」——被对话历史里成功的团队工具调用干扰、误以为系统提示过时。横幅改为明确「以本提示为准，对话历史中任何团队会话的痕迹均已失效」+ 解释历史工具调用发生在 stop 之前，实测 TL 从「是，仍是我 Team Lead」转为「不是，团队会话已结束」（见 AGENTS.md 决策 #24）

### `/team resume [团队名或sessionId前缀]`

恢复中断（TL 进程退出/被杀、/new、pi 会话切换）或已停止的团队会话（ADR-0004）。

**Prerequisites (persisted at session runtime):**
- Member pi sessions are always persisted (incremental append-only `.jsonl` under `sessions/<team>/<sessionId>/<member>/`); spawn never passes `--no-session`
- `session.json` manifest: roster (the only durable copy for dynamic teams), origin, dynamicPhase, sharedContextWritten, Goal, startedMembers, memberPids, status (`active` = interrupted / `stopped` = clean stop)

**Flow:**
1. Scan `sessions/*/*/session.json` (incl. `_dynamic_*`), sort by `lastActiveAt` desc; **filter to the current working directory by default** (manifest records the creating TL's cwd — mirrors `pi --resume` project scoping; `--all` lists every directory with cwd shown in labels); arg filters by team name or sessionId prefix; multiple matches → `scrollSelect` picker (label = `teamName (sessionId)`, description = 类型/状态/成员数/时间[/cwd]) — the scrollable+filterable component with a `maxVisible` window, since the built-in `ctx.ui.select` renders ALL options without scrolling and overflows the screen when many sessions are resumable
2. Orphan cleanup: for each `memberPids` entry, verify via `/proc/<pid>/environ` (TEAM_NAME + session path) and SIGTERM survivors (Linux-only, best-effort)
3. Rehydrate: `startSession(teamFromManifest, {sessionId, origin})` — manifest roster is authoritative (YAML supplies description/workflow only); restore `sharedContextWritten`, Goal, `isDynamicSession`/`dynamicPhase`/`agentInitiatedTask`
4. `onSessionStart`（widget + 会话工具注册 + 重注册 team-mode 编辑器工厂——`onSessionEnd` 曾用 `setEditorComponent(undefined)` 将其清除，不重新注册则输入框边框不变色）+ 激活工具（动态团队 + `add_dynamic_member`，agent 来源 + `stop_team_session`）
5. Restart every `startedMembers` entry with `--continue` (full context restore); failures reported, TL may retry via `start_member`
6. Re-stamp manifest `active` with fresh pids; set `teamCtx.resumedFrom` for a one-shot TL prompt banner (next `before_agent_start`): context preserved, in-flight tasks NOT replayed, pending corrIds invalid — TL re-checks member status and re-dispatches

**Resume semantics:** members restore to the last completed entry of their persisted session; work in flight at interruption time is lost (the process died mid-turn) and members come back idle. Task orchestration is rebuilt by the TL, matching pi's own resume model.

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

### `/team setting`

- Interactive settings menu (via `ctx.ui.select`) for global team-session settings. Also available during an active session (affects only subsequently started members).
- Currently supports: **成员默认模型** (default model for members)
  - `跟随当前配置` (follow) — a member spawned later uses the TL's current model at spawn time (tracked via `session_start` + `model_select` events in `index.ts`)
  - `指定模型` (fixed) — pick one of pi's available (logged-in) models from `ctx.modelRegistry.getAvailable()`
- Also supports: **自动压缩** (Auto-Compaction, see §8 Message Channel → Auto-Compaction on dispatch)
  - Second-level menu: `开关切换` / `设置百分比阈值` / `设置 token 阈值` / `清除百分比阈值` / `清除 token 阈值` / `设置超时（分钟）`; loops until Esc
  - The top-level menu label shows the effective configuration summary (e.g. `开启 · 阈值 80%（默认）· 超时 10 分钟`); clearing all thresholds while enabled triggers a one-time notice that the 80% default fallback applies
- Persisted to `<rootDir>/settings.yaml` (`src/settings/settings.ts`), e.g. `memberModel: { mode: fixed, model: "anthropic/claude-sonnet-4-5" }`. Missing/corrupt file falls back to `{ mode: follow }`; `fixed` without a model auto-falls back to `follow`.
- **Model resolution precedence** (`src/settings/resolve-model.ts`, pure function): member YAML `model` > team YAML `defaults.model` > global fixed > global follow (TL current model) > no override (member pi uses its own default).
- The resolved model is passed to the member process as the `--model provider/id` CLI flag at spawn (`MemberProcessConfig.model` in `member-process.ts`). This also wires up the previously inert team-YAML `defaults.model` / `member.model` fields. Already-running members keep the model they were spawned with.
- The model picker uses `src/ui/scroll-select.ts` — a reusable `ctx.ui.custom` component with a `maxVisible` scroll window (default 10, same as pi's `/model` selector), `(n/total)` scroll indicator, PgUp/PgDn support, and a fuzzy-search input (`fuzzyFilter` from pi-tui). pi's built-in `ctx.ui.select` renders ALL options without scrolling, which is unusable for 100+ available models. Small menus (top-level, mode picker) still use `ctx.ui.select`. The `/team resume` session picker also uses `scrollSelect` for the same reason (many resumable sessions would overflow the screen).
- Also supports: **成员思考强度** (`memberThinkingLevel?` in settings.yaml; `src/settings/resolve-thinking.ts`)
  - Second-level menu: `默认（不指定）` + `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`; current level marked with `●`
  - **Semantics (支持则用，不支持保持现状)**：配置后，成员启动时若其生效模型支持该级别 → spawn 参数加 `--thinking <level>`；不支持（或无法判定支持集）→ 不传 flag，member pi 使用自己的默认思考级别链（per-model 覆盖 > 全局默认 > 模型自身默认）。**刻意不做就近 clamp**——pi 自身的 `setThinkingLevel` 会 clamp 到最近支持级别，与「保持现状」语义不符，因此支持性检测在 TL 侧完成，不支持时根本不传 flag。
  - **Support-set semantics**（逐字复刻 pi-ai `getSupportedThinkingLevels`，版本锚定 pi 0.83.x dist bundle；不 import pi-ai——非本包依赖且 jiti alias 深导入有拼坏前科，见 §17）：非 reasoning 模型仅 `off`；reasoning 模型 `off/minimal/low/medium/high` 默认支持（`thinkingLevelMap` 映射为 `null` 者除外），`xhigh/max` 仅当 `thinkingLevelMap` 存在对应条目。
  - **Wiring**: `index.ts` 在 `session_start` 缓存 `ctx.modelRegistry`；`buildMemberConfig` 新增 `lookupSupportedThinkingLevels?(modelRef)` 选项——按 `provider/modelId` 在 `getAvailable()` 查模型后返回支持集（查不到/注册表不可用 fail-open）。两个调用点均传入：`start_member` 工具与 `/team resume` 的 `startResumedMember`；崩溃 auto-restart 复用已存 config，flag 自然保留。无生效模型覆盖（source=none）时不检测；团队 YAML `model: "provider/id:high"` 后缀逃生口不受影响（含后缀的 id 匹配不到注册表 → fail-open）。
  - `start_member` 结果文本在指定成功时附「思考强度：<level>（模型支持该级别，已显式指定）」便于观测；仅影响之后启动的成员。

## 6. TL Process Management Tools

Nine session-scoped TL tools are registered while a team session is active (six process tools, `write_shared_context`, `set_goal`, and `finish_goal`). They are active and visible only during a team session; because pi has no unregister API, once registered they remain in the registry after teardown and are removed from `activeTools` outside the session, so they are not visible or callable. `add_dynamic_member` is additionally available in dynamic mode; `start_team_session` is the deliberate load-time exception described in §18.

### `write_shared_context`

```typescript
write_shared_context({ content: "# Shared Context\n..." })
```

- **The only sanctioned way to write the team shared context** (`.shared-context.md`)
- Writes `content` (full Markdown, overwrite semantics) to the session's shared-context path via `src/tools/shared-context-tool.ts`
- On success calls `markSharedContextWritten()` — the session flag that **gates `start_member`**: until this tool has been called at least once, every `start_member` call returns an error telling the TL to write the shared context first
- fs write failure → error returned, flag **not** set (fail-open, gate stays closed)
- Direct `write`/`edit` calls targeting `.shared-context.md` are intercepted by the `tool_call` guard and redirected here (keeps the flag accurate)
- Registered on-demand at session start (`ensureSessionToolsRegistered`), activated during team sessions via `teamCtx.tlToolNames`; on both phase whitelists

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

- Returns the operational status (idle/working/compacting/crashed/stopped) of all members
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

- **Blocks** the tool until ALL members are idle (mandatory all-idle gate, same detection as `wait_and_get_member_status`: 4 consecutive checks, 3s interval). Replies arriving early do NOT end the wait — a member that replied may still be finishing its turn, and non-targeted members may still be processing earlier dispatches
- **Batch mode**: multiple `{to, content}` entries in the `tasks` array are **sent concurrently** via the message queue. Replies are collected as they arrive and returned together when the gate opens
- **Partial results**: if some members become idle without replying (e.g. crash), the tool returns results from completed members with ⚠️ markers for failures
- **Batch vs Sequential decision rule**:
  - **Batch** when tasks are **independent** — no task's output is needed to craft another task's instruction. All members work simultaneously. Wall-clock time ≈ slowest single task.
  - **Sequential** (one call per task) when task B's instructions **depend** on task A's result. Each task waits for the previous one. Wall-clock time = sum of all task durations.
  - **Mixed strategy**: batch independent discovery tasks (A+B), then use combined outputs to craft a dependent task (C). This is often the most efficient pattern.
- **Correlation matching**: each task gets its own `<corr:...>` tag for independent matching. Supports chain workflows: Member A can forward the tag to Member B
- **Auto-injection**: if a member's reply is directed to `"tl"` but lacks a `<corr:...>` tag, the TL extension automatically appends the most recent pending correlation ID for that member. This ensures responses are matched even if the member AI forgets to include the tag
- **Wait budget**: by default the all-idle gate has a 15-minute diagnostic deadline (`waitTimeoutMinutes`; `0` restores unlimited waiting). On expiry it returns partial results plus suspected stuck members and recovery guidance instead of hanging forever. `/team stop` also cancels all pending waits
- **Cancellation**: on `/team stop`, all pending waits are cancelled

**防截断协议（P3）**：promptGuidelines 内置 5 条，从源头降低截断概率（长 content 是校验失败首要诱因）。P1/P2 已保证截断形态不再以误导性框架错误出现（schema 放宽 + prepareArguments 规范化 + 截断语义提示），本协议在此基础上降低**截断发生的概率**：

1. **长 content 拆分** — content 超 ~800 字符时拆分为多次调用，或指示成员读取文件路径。**任务详情不写入 `.shared-context.md`**：该文件全员共享且 `write_shared_context` 全量覆盖，一次性任务详情写入会污染其他成员上下文，批处理并发覆盖存在竞态（D6 裁决）——引用成员私有或独立文件路径。
2. **键序** — tasks 条目**先写 to 再写 content**：键序决定截断后幸存字段（输出被截断时靠后的字段丢失，γ 独立实证）。
3. **tool call 数量** — 每回合控制在 1-2 个：同批多个 tool call 挤占输出预算，后面的 tool call 更容易被截断（β 场景）。
4. **短重试** — 收到 Validation failed（缺 to/content）→ 立即用更短的 content 重试，**不要原样重发**（原样重发 → 再截断 → 再失败的死循环，β）。
5. **未知成员疑截断** — 收到"未知成员"错误 → 先怀疑 to 被截断（常见截半形态如 `"c"`），重发完整成员名。

定位为引导性 best practice 而非强制架构（γ）：截断 vs 模型漏生成无法从落盘参数区分，两条路径修复手段相同。

**Difference from `team_send_message`:**

| tool | behavior |
|------|----------|
| `team_send_message` | Fire-and-forget. Message sent, tool returns immediately. |
| `team_send_and_wait` | Messages sent, tool blocks until ALL members are idle (replies collected as they arrive). Combined response content returned as tool result, NOT injected into TL context via `pi.sendMessage()`. |

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
  │       └── NO MATCH → team_send_and_wait 等待在飞（S3，决策 #39）：
  │                     入 tlWaitGate 扩展侧缓冲，all-idle 门控打开时经
  │                     pi.sendMessage（无 deliverAs → 工具执行期 = steer 分支）
  │                     注入——工具结果之后、同一回合内（不等 TL 回合结束）
  │                     否则 → inject into TL's session via pi.sendMessage(msg, {deliverAs:"nextTurn"})
  │                     (S2 阶段 1：进 _pendingNextTurnMessages，下一次任意回合统一注入，零 steer)
  │
  ├── to === "<member>"     → S1 coalescer (阶段 2): 无 corrId ∧ 非 "all" ∧ 接收方
  │                           working/桶非空 → 入 per-receiver 桶（agent_end 回合
  │                           边界合并派发，单次 working 周期）；否则立即派发 prompt
  │                           （含 corrId 到达且桶非空时先 flush 合并包再派发，FIFO 保序）
  ├── to === "all"          → write prompt to ALL Members' RPC stdin (不合并)
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

### Routing to a Member

Messages addressed to a member are written to the member's RPC stdin as a `prompt` command carrying `streamingBehavior: "followUp"`. The TL-side operational state (`memberOpsStates`) is derived from `agent_start`/`agent_end` events and cannot exactly track pi's streaming window: pi keeps `isStreaming` true through the post-`agent_end` settlement phase (listener drain, auto-retry, auto-compaction continuation — potentially tens of seconds), while the state machine already shows `idle`. With `followUp`, a prompt that arrives while the member is still streaming is queued by pi itself (the ground truth) and delivered when the current run finishes, instead of being rejected with `Agent is already processing` and silently lost. When the member is idle the flag has no effect.

Channel prompts are sent fire-and-forget (`sendCommand`, no RPC id attached). If the member's RPC layer still rejects a prompt (e.g. member model/auth failure), the error response arrives as a plain event with no id. `createMemberEventHandler` matches `{type:"response", command:"prompt", success:false, id:undefined}`: it resolves any pending `team_send_and_wait` for that member with a `[消息未送达]` reason and notifies the TL via a `team-route` message. Responses carrying an id belong to `sendCommandAndWait` callers (stats / compact / Member Inspector), which consume their own errors and are skipped.

### S1 message coalescing (消息合并, 阶段 2)

Member→member messages WITHOUT a wait chain (no `correlationId` ∧ not `to:"all"` ∧ not an Inspector direct message — direct messages bypass the channel entirely) are merged per receiver at the dispatch layer (`src/channel/message-coalescer.ts`, pure state + flusher hook; `createSendToMember` registers the flusher, the event handler flushes/drains the SAME shared instance):

- **Bucket** (`Map<receiver, CoalescedEntry[]>`): cross-sender, per-message sender annotation preserved. Enqueue only when the receiver is `working` or the bucket is already non-empty — an idle receiver with an empty bucket still gets immediate dispatch (zero added latency).
- **Flush points**: ① receiver `agent_end` (the turn boundary — the batch concept: busy-arriving messages were going to wait for the current turn anyway, so merging adds zero delay); ② a corrId message arriving while the bucket is non-empty (flush the merged package FIRST, then dispatch the corrId message — both go into pi's followUp queue, FIFO preserved, gamma D6); ③ after `compaction_end` close+flush (defensive, idempotent); ④ process_exit / process_error / teardown → drain + notify the TL with the dropped count (no retry — no wait chain, no retry contract; also eliminates any idle+bucket stall state).
- **Merged package format**: `[消息通道 - 来自 <sender>]（合并包：共 N 条未处理消息，请在一个回合内全部处理）` + numbered per-message lines `【消息 i/N｜来自 <sender>】<content>` (subject preserved) + `处理要求：逐条处理；如需分别回复，请在回复中注明对应消息编号`. One merge = one working cycle — state machine / wait tools / widget / inspector need zero changes.
- **Limits & degradation**: `takePrefixForFlush` (pure) takes the longest prefix ≤ `maxBatchSize` (default 5) messages AND ≤ `maxBatchChars` (default 4000) chars; leftovers stay in the bucket for the next flush point; a single oversized message is taken alone (dispatched unmerged); the char budget is capped below the hard `MAX_COMMAND_SIZE` (1MB) guard.
- **corrId red line (structural)**: corrId messages never enter the bucket — a wait chain merged into a batch would deadlock (the wait never closes) and multi-corrId batches break the single `lastPendingCorrId`. `skipAutoCompact` messages always carry a corrId, so they bypass too.
- **Compaction interaction**: two orthogonal buckets — during `compacting` messages go through the EXISTING `queueDuringCompaction`/`flushPending` path (per-message, all locked invariants untouched); a merged package goes through the FULL dispatch path (`dispatchWithAutoCompact`: compacting branch + ONE auto-compaction check + pending drain + dispatch), so a package that triggers compaction enters the compaction pending as a single message and dispatches whole afterwards.
- **Settlement window** (agent_end → TL sees idle, pi still streaming): messages arriving then match "idle + empty bucket" → immediate followUp dispatch (queued by pi, FIFO). Correct and accepted (alpha B-3).
- **Settings**: `TeamSettings.messageCoalescing { enabled?, maxBatchSize?, maxBatchChars? }` (default enabled), `/team setting` menu entry; disabled → the pre-S1 per-message path (fail-open, 场景 I).

### Routing to TL

The TL is the user's pi session, not an RPC process. Messages addressed to `"tl"` are delivered with `pi.sendMessage(msg, { deliverAs: "nextTurn" })` (S2 阶段 1, 决策 #36): the message goes into pi's `_pendingNextTurnMessages` and is injected into the TL's context at the start of the **next arbitrary turn** — never steering a streaming TL turn, never spawning a turn while idle. Version-verified against peerDep 0.83.0 (dist/core/agent-session.js `sendCustomMessage` nextTurn branch at ~1075-1077, injection at prompt() ~876-880; `SendMessageHandler` type includes `"nextTurn"`). Wait replies are consumed by `resolveIfWaiting` before this path (zero impact); system notifications (crash/rejection/compaction/teardown) and `team-route` routing errors stay immediate. Consequence (accepted semantics): while the TL is idle, member messages are held until the next turn instead of appearing instantly.

**S3 amendment (阶段 3, 决策 #39 — wait-gate buffered flush)**: while a `team_send_and_wait` wait is in flight, non-reply member→TL messages buffer in the extension-side `tlWaitGate` (`src/channel/tl-wait-gate.ts`) instead of pi's nextTurn queue (which has no public drain API — the buffering decision must be made at message-arrival time). The moment the mandatory all-idle gate opens (decision #38), `waitWithAllIdleCheck` drains the gate and re-delivers everything via a plain `pi.sendMessage` **without** `deliverAs`: during tool execution the agent run is active (`_isAgentRunActive` spans the whole run), so pi takes the **steer branch**, and the agent loop drains the steering queue **after tool results are appended and before the next assistant completion** (pi-agent-core agent-loop.js `runLoop`) — the TL sees the messages in the SAME turn, right after the tool result, with zero streaming interruption (nothing streams during tool execution). If the run was aborted just before the flush, pi's not-streaming/no-triggerTurn branch appends the message to history without a turn — no loss. Injection format (user ruling: keep the TL context clean): each buffered message is delivered as its OWN custom message in the exact S2 format (`[消息通道 - 来自 X]` + subject + content) — byte-identical to the nextTurn path's message appearance, no merge headers or index annotations; multiple messages land in the same steering batch, still right after the tool result. Verified end-to-end against the real AgentSession in `src/tools/tl-wait-gate.agent-session.test.ts` (custom message lands after toolResult, before the final assistant message). No-wait periods keep pure S2 semantics; the batch-barrier window (before `beginWait`) also stays S2.

### Auto-Compaction on dispatch

When the router delivers a message to a member (`createSendToMember` in `channel/event-handler.ts`) and the member is currently `idle`, Auto-Compaction runs before the prompt is sent:

```
dispatch to idle member
  → transitionState(compaction_started)          [synchronous — closes double-dispatch race]
  → get_session_stats (3s timeout)
  → shouldCompact(usage, cfg)?                   [percent OR tokens, either configured one triggers]
      → yes: compact RPC (await up to timeoutMinutes, default 10)
  → transitionState(compaction_completed) → send prompt → working
  → flush messages queued during compaction
```

- **Fail-open**: stats query failure, compaction failure, or timeout all end with the prompt dispatched anyway + a TL notification. Success is silent — the TL is only notified when a configured compaction did *not* happen.
- **At most one compaction per dispatch** — no post-compaction re-check loop.
- **`compacting` operational state** (`idle`/`working`/`compacting`/`crashed`/`stopped`): the compaction turn's own RPC `agent_start`/`agent_end` events are shielded in the state machine (`task_started`/`task_completed` on `compacting` are no-ops), so the all-idle wait logic treats compacting as busy with no changes to the wait code. Shown as 🗜️ in the team status widget and Member Inspector (with a `（压缩中）` footer hint); the widget polls context usage at the active interval while any member is compacting.
- **Queueing**: messages routed to a member while it is compacting are held in a per-member pending list and flushed (in order, via the normal prompt path) after compaction completes. Member Inspector direct input during compaction is sent as `follow_up`/`steer` (busy semantics).
- **Scope**: only the message-channel dispatch path is covered — Member Inspector direct `prompt` messages bypass Auto-Compaction (the user can compact manually via the inspector's compact control).
- **Configuration** (global `/team setting`, no team-YAML override): `autoCompact: { enabled (default true), thresholdPercent? (1–100), thresholdTokens? (positive int), timeoutMinutes (default 10, ≥1) }`；顶层通用等待预算 `waitTimeoutMinutes?`（default 15, 0 = unlimited，独立于自动压缩——wait 工具 all-idle deadline 与批屏障共享，见 §1.3） in `<rootDir>/settings.yaml`. Enabled-but-no-thresholds falls back to 80% (flagged `percentIsDefaultFallback` so the settings menu shows `80%（默认）`). Resolution + threshold check are pure functions in `src/settings/resolve-auto-compact.ts` (`resolveAutoCompact` / `shouldCompact` / `describeAutoCompactSetting`); the config is re-read from disk on every dispatch so mid-session changes take effect immediately.

### Shared runtime + skipAutoCompact + batch barrier (阶段 1–3)

**Shared runtime** (`src/channel/auto-compact.ts`): all compaction primitives (`queryStats`/`shouldCompact`/`beginCompaction`/`compactNow`/`endCompaction`/`queueDuringCompaction`/`flushPending`) and the per-member pending queue live in ONE `AutoCompactRuntime` instance created by `createMessageChannel` and injected into both the inline dispatch path (`SendToMemberDeps.autoCompact`) and the batch barrier (`TlToolsDeps.autoCompact`). Results are discriminated unions (`{ ok: true, stats? } | { ok: false, error }`) carrying the real RPC failure reason. `queueDuringCompaction` refuses (returns false) when the member is not `compacting` — a defensive invariant against orphaned messages.

**skipAutoCompact** (`TeamMessage.skipAutoCompact?: boolean`, phase 2): the ONLY signal that the compaction decision was already made elsewhere. When set, the inline path skips its stats/compact check entirely and dispatches directly — prevents a second compaction when usage is still over threshold after a compact (E12) and enforces at most one compaction per dispatch. Only the batch barrier produces marked messages; member inter-sends / Inspector direct / unbatched TL messages never carry the marker.

**Batch barrier** (`sendAndWaitExecute`, phase 3) — unified start for parallel batches: when `tasks.length > 1` and auto-compaction is enabled, ALL prompts of the batch are dispatched only after the LAST needed compaction completes — none may start early. Architecture invariant E1: the whole barrier runs BEFORE corrId registration and enqueue, so no wait detection can fire early (test-locked: messageQueue stays empty until all compactions end).

```
sendAndWaitExecute(tasks)  [tasks.length > 1 && autoCompact enabled && DI wired]
  → planBatchCompaction(deduped explicit targets)   [pure: idle→query / compacting→wait / other→skip]
  → WAIT: compacting members polled to idle (1s; within batch budget)   [E3: never re-compact]
  → PREPARE: parallel get_session_stats (3s each, per-member fail-open)
  → S: members over threshold
  → WAIT (toWait): polled out of compacting — SILENT (the barrier is internal;
      the TL only experiences a longer wait); releases when
      every toWait member is OUT of compacting (idle/crashed/stopped — a crashed
      or stopped member never reaches idle and must not hang the poll)
  → COMPACT: S serial — beginCompaction (sync) → compactNow → endCompaction (finally reset)
      per-member fail-open: failure → continue (silent); member still marked (skip)
      maxWait budget exceeded → stop the NOT-YET-STARTED compactions, dispatch batch as-is (silent)
      (a compaction already in flight runs to its own timeout — expected)
  → COMMIT: register all corrIds → enqueue all messages
      skipAutoCompact: true ONLY on members that got a compaction attempt
      (success or failure); budget-skipped / non-S members carry no marker
      → inline path gives them a natural second chance
  → waitWithAllIdleCheck (unchanged)
```

- **Serial compactions**: at most one compact RPC at a time — without PD separation, concurrent compactions are concurrent prefill bursts, the exact problem this feature solves.
- **Compacting members** (inline-path compaction already in flight, or a previous batch left running after Esc): counted into the wait set, polled out of compacting (idle/crashed/stopped all release — a dead compaction cannot be aligned), never re-compacted (D3 — replaces any lock-based approach).
- **Silent by design**: the barrier is FULLY silent to the TL — no `[批屏障]` notices are sent (wait start, compaction start, per-member failure, and budget overrun are all invisible; the TL only experiences a longer wait inside `team_send_and_wait`, and the batch dispatches as-is in every case). Fail-open behavior is unchanged; the inline dispatch path keeps its own existing failure notification.
- **maxWait budget** (顶层 `waitTimeoutMinutes`, default 15 min, 0 = unlimited — 通用等待预算，与 wait 工具 all-idle deadline 共享): total budget shared by the WAIT phase and all compactions. On exhaustion: the not-yet-started compactions are skipped, the batch is dispatched as-is (silent). Members not yet attempted carry no marker.
- **Scope**: barrier covers only the tasks[] explicit targets; `to:"all"` is rejected by the existing unknown-target validation (broadcasts are not batch semantics); member inter-sends and Inspector direct messages never participate (manual intervention wins). Single-task batches and disabled auto-compaction take the legacy path with zero pre-check.

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
- **默认工作流（可选）**: 如果团队配置了 `workflow` 字段，由 `src/prompts/workflow-prompt.ts` 的 `buildWorkflowPrompt()` 注入**操作型**工作流提示词（非纯描述性）：包含激活条件、逐 stage 派发协议、执行者醒目标注、串行/并行语义、失败回退与循环处理、进度汇报要求。Strict 模式强调"不得跳过/调序/合并 stage、TL 不得亲自执行"；Reference 模式默认按序执行、偏离须向用户说明理由。团队有 workflow 时还会在第一动作协议下方注入 `WORKFLOW_ACTIVATION_BANNER` 横幅指针，防止工作流段在长提示词中部被稀释

完整的注入提示词代码见 `index.ts` 中的 `before_agent_start` 处理器。

### 工作流注入示例（Reference 模式）

当团队配置了 workflow 时，`before_agent_start` 会先注入激活横幅（第一动作协议下方），再在团队信息之后注入操作型工作流段：

```markdown
> 🚨 本团队定义了「团队工作流」（见下方）：收到任务型诉求时，先检查是否命中工作流激活条件；命中则严格按「工作流执行协议」逐 stage 派发，不得自己开工分析。

### 团队工作流（参考模式 📋）
默认按以下步骤顺序执行；确需偏离（跳过/调序/并行化）时，必须先向用户说明理由再执行。

**流程描述：** 标准开发流程：设计 → 编码 → 审查 → 循环

**步骤序列：**
  【需求对齐】→ 执行者：`tl`
    与用户对齐需求和方案
    输出：需求文档

  【架构设计】→ 执行者：`architect`
    架构方案细化设计
    输入：需求文档
    输出：详细设计文档
    约束：考虑可扩展性和技术选型

  【编码开发】→ 执行者：`coder`
    实现功能模块
    输入：设计文档
    输出：代码 + 测试
    约束：TDD，单步提交
    失败处理：如「审查不通过」→ 回退至「编码开发」

**循环段：**
  🔁 条件「还有未完成的任务」→ 重复步骤：编码开发、代码审查

**🔄 工作流执行协议（命中即必须遵守）：**
1. **激活条件** — 用户提到「团队流程 / 按流程 / 按工作流」，或任务与上方流程描述匹配时，激活本工作流。激活后的第一个动作是派发第 1 个 stage —— 禁止先自己 read/bash 分析。
2. **逐 stage 派发** — 每个 stage 用 team_send_and_wait 派给其「执行者」……TL 绝不亲自执行 stage 的工作。
3. **串行等待** — 当前 stage 回复并确认产出后才派发下一个；上游产出作为下游输入传递。
4. **独立 stage 可并行** — 无输入依赖的多个 stage 放入同一个 team_send_and_wait 的 tasks 批量派发。
5. **失败与循环** — 按 onFailure 回退重派；loops 条件成立时重复对应 stage 组。
6. **进度可见** — 每完成一个 stage 向用户汇报「stage N/M【名称】已完成」。
```

Strict 模式的注入结构相同，但标题为「严格模式 ⚡ — 必须遵守」，强调"不得跳过、调序、合并 stage"，并在末尾追加："完成上一个 stage 前不得开始下一个；所有 stage 必须按序全部执行。"

> 背景：旧版注入是纯描述性的（"尽可能遵循步骤顺序"、执行者以行尾括号标注），无激活规则与执行协议，导致 TL 收到"根据团队流程进行 xxx 分析"时仍自由发挥、自己分析。修复见 `src/prompts/workflow-prompt.ts` 头部注释。

此外，扩展注册了一个 `tool_call` 事件拦截器，使用**白名单**机制限制工具调用。不在白名单上的工具会被直接阻断，不存在黑名单遗漏的风险。

> **白名单仅约束 `origin: "user"` 会话**（ADR-0003 修订）：`origin: "agent"`（start_team_session）在 `tool_call` 守卫中早退旁路白名单与扩展名检查（设计+执行两阶段同权，工具面与普通模式一致），唯一保留 `.shared-context.md` → `write_shared_context` 重定向（机制契约，所有 origin 生效）。user 来源会话（`/team start`、`/team dynamic`）行为不变。

**设计阶段白名单（`DESIGN_PHASE_WHITELIST`）：**
- 仅允许：`add_dynamic_member`、`start_member`、`stop_member`、`list_members`、`get_member_log`、`wait_and_get_member_status`、`team_send_and_wait`、`set_goal`、`finish_goal`、`write_shared_context`、`read`（不受限）、`write`（仅 `.md` 文件）
- 其他工具全部被阻断（包括 `bash`、`edit`、`web_search` 等），TL 只能讨论方案、有限度读取文件、写入共享上下文。
- **设计阶段 read 软限制**（`src/session/tl-read-guard.ts` 的 `createDesignReadGuard`）：read 是允许的（了解项目以设计方案是合法设计工作），但非 `.md` 读取每 4 次会被**拦截一次并提醒**「是否真的需要 read」——若确实需要，再次调用 read 即可放行（单次提醒、不持续拦截，与执行阶段的 sticky 拦截不同：设计阶段没有可派发的 Member）。`.md` 读取不计数、不拦截；首次拦截带 `firstBlock` 标记触发用户可见通知与状态栏警示；`agent_start` 重置每轮计数。

**执行阶段白名单（`EXECUTION_PHASE_WHITELIST`）：**
- 团队管理工具 + 只读分析工具（`read`、`bash`、`web_search`、`fetch_content`、`ctx_search`、`true_sight_*` 等）+ `write`/`edit`（仅 `.md` 文件）
- `ctx_execute`、`ctx_execute_file`、`ctx_batch_execute`、`mcp` 等具有文件写入能力的工具不在白名单中，自动被阻断。
- 设计阶段的阻断在首次 `start_member` 成功后自动解除（同时 `dynamicPhase` 切换至 `"execution"`）

**TL 亲自分析的运行时软纠偏（`src/session/tl-read-guard.ts`）：**
- 问题：执行阶段白名单放行了 `read`/`bash`（TL 监控协调所需），提示词中的"铁律"是纯软约束，TL 仍可能亲自埋头分析代码而不派发任务。
- 机制：以 `agent_start` 为 turn 边界重置计数；每个 turn 内未发生 `team_send_and_wait` 派发时，TL 对**所有非管理工具**（read、bash、web_search、ctx_execute 等——不只 `read`，否则可用 bash grep/rg/cat 绕过）的调用计数，超过阈值（默认 3）即进入**持续拦截模式**：派发前每次非管理工具调用都会被 block，reason 中包含纠偏指引。
- 设计属性：
  - **持续拦截（sticky）**：阈值触发后不是 block 一次就放行——一次性的软提醒实测可被模型无视（看到一次错误后继续用下一个工具分析）。现在派发前所有非管理工具调用持续被拦截，TL 唯一出路是 `team_send_and_wait` 派发任务或直接回复用户。首次拦截带 `firstBlock` 标记，供 UI 弹通知/状态栏警示；派发（`team_send_and_wait`）后立即解锁，后续工具调用全部放行。
  - **fail-open**：`.md` 读取不计数（文档工作是 TL 本职）；管理工具（start/stop/list_members、team_send_and_wait、write/edit 等）永不拦截（解锁通道永远畅通）；派发后不再拦截（派发后的 read 视为协调/审阅）；设计阶段不启用本守卫（无 Member 可派发），取而代之的是**设计阶段 read 软限制**（`createDesignReadGuard`，见上）：非 `.md` read 每 4 次拦截一次提醒，确需读取时再次调用即放行。
  - 提示词层（`src/prompts/tl-first-action.ts` 的"第一动作协议"，注入预定义团队与动态模式执行阶段提示词顶部）与运行时层（本守卫）配对，模型能预知规则被强制执行。

The handler stays registered for the entire pi session but checks `session.active` to decide whether to inject regular TL instructions. When `/team stop` ends the session, `session.active` becomes `false` and no regular TL instructions are injected; a one-shot session-ended banner may be injected on the next turn and is then consumed.

## 11. Team Session State

```typescript
// src/session/state.ts — lightweight session state
interface TeamSessionState {
  active: boolean;
  teamDefinition: TeamDefinition | null;
  startedAt: number | null;
  sessionId: string | null;
  sharedContextWritten: boolean;  // set by write_shared_context; gates start_member
  origin: "user" | "agent";      // session origin (ADR-0003); defaults to "user"
}

// src/session/context.ts — shared mutable references for the extension
interface TeamContext {
  isCreatingTeam: boolean;
  editingTeamName: string | null;
  isDynamicSession: boolean;  // true during /team dynamic or agent-initiated sessions
  dynamicPhase: "design" | "execution";  // dynamic mode phase (only relevant when isDynamicSession is true)
  agentInitiatedTask: string | null;      // mission statement of an agent-initiated session (ADR-0003); null otherwise
  resumedFrom?: {...} | null;              // one-shot /team resume banner (consumed by next before_agent_start)
  sessionEndedNotice: boolean;             // one-shot "session ended" banner (set by teardown, consumed by next before_agent_start)
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
- `"design"`: TL is restricted by the design-phase whitelist (only team management + .md write allowed), all other tools blocked
- `"execution"`: Execution-phase whitelist applied (team management + read-only analysis tools + .md write/edit); tools like `ctx_execute`/`mcp` remain blocked
- Transition from `"design"` → `"execution"` happens automatically on first `start_member` success, via the `onDynamicPhaseTransition` callback wired in `index.ts`

Session state (active + team definition) is stored in `session/state.ts` as a module-level variable, mirrored to disk as `session/manifest.ts`'s `session.json` (the /team resume anchor, ADR-0004). Member process handles, message channel, and other runtime objects are in `TeamContext` passed to command handlers. On `/team stop`, all processes are terminated, handles cleared, in-memory state reset — the session directory is kept (manifest marked `stopped`) so `/team resume` can restore it.

**`addMemberToSession(member: TeamMember): TeamDefinition`** — Adds a member to the active session's team definition and refreshes the session state. Used by the `add_dynamic_member` tool during `/team dynamic`. Throws if no active session.

**`sharedContextWritten` + `markSharedContextWritten()`** — The session flag backing the shared-context gate. Starts `false` on `startSession`, reset to `false` on `endSession`/new session. Only the `write_shared_context` tool sets it (successful fs write only). `start_member` refuses to launch any member while it is `false`.

**`origin` (Session Origin)** — Records how the session was started: `"user"` (`/team start` / `/team dynamic`) or `"agent"` (the `start_team_session` tool, ADR-0003). Drives guard strength (dispatch-policing guards apply only to user-initiated sessions), prompt selection (autonomous vs. playbook prompts), `stop_team_session` visibility, and the widget origin marker (🤖/👤). See §18.

## 12. Error Handling

### Member process crash

1. The Member's `ChildProcess` emits `"exit"` with non-zero code
2. `MemberProcessManager` detects the unexpected exit
3. Manager logs the crash, notifies TL, and applies bounded auto-restart with exponential backoff; crash-loop detection freezes repeated failures
4. TL is notified via a custom message: "Member 'analyzer' 进程异常退出（code: 1），需检查崩溃原因。"
   - Exit code 143 (SIGTERM) is treated as normal stop via `stop_member`, no notification sent
5. TL can use `stop_member` + `start_member` to intervene manually; a restarted Member resumes its persisted session when available

### Member process stuck / unresponsive

- `wait_and_get_member_status` waits for the all-idle condition until the configured diagnostic deadline (`waitTimeoutMinutes`, default 15 minutes; `0` means unlimited); expiry returns the current statuses and stuck-member recovery guidance
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
On `/team stop` and `session_shutdown`, the session subdirectory (`<sessionId>`) is preserved and its manifest is marked `stopped` (or left `active` for an interrupted shutdown); use `/team resume` to restore it and `/team delete` for explicit disk cleanup.

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

1. **Creation**: The system guarantees the file always exists — `ensureSharedContextFile()` (`src/session/shared-context.ts`) auto-creates a minimal stub at session start (`/team start`, `/team dynamic`) and defensively inside `buildMemberConfig` (in case it was deleted mid-session). The stub contains the team roster and placeholder sections, and is never overwritten once it exists. The TL is still expected to enrich it with real content after clarifying requirements with the user; this removes the old failure mode where starting a Member before the TL wrote the file emitted "Shared context file not found" and spawned the Member with a dangling `TEAM_SHARED_CONTEXT_PATH`.
2. **Gate (start_member 硬门控)**: The TL must write the real shared context via the **`write_shared_context` tool** before the first `start_member` — until the tool has been called successfully (session flag `sharedContextWritten`), `start_member` refuses to launch. Direct `write`/`edit` of `.shared-context.md` is intercepted by the tool_call guard and redirected to the tool. The stub alone never satisfies the gate; it exists only so a started member can always read a valid file.
3. **Initial delivery**: When TL sends the first task to a Member, the Shared Context is included as part of the task message
4. **Updates**: When TL determines the Shared Context needs updating (e.g., goal refined, glossary term added, progress checkpoint), TL:
   - Calls `write_shared_context` again (overwrite semantics)
   - Sends a message to all Members via the message channel: "共享上下文已更新，请重新阅读 .shared-context.md"
5. **Member behavior**: Members are instructed via system prompt to read the Shared Context when starting a new task, and to re-read it upon receiving an update notification

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
| **E2E** | `src/tools/goal-tools.agent-session.test.ts` uses the installed pi 0.83.0 AgentSession with a deterministic in-process provider; CLI smoke loads `./index.ts` with no tools | Real pi 0.83.0 host lifecycle; provider transport only is faked | vitest + `./node_modules/.bin/pi --mode json --no-tools -e ./index.ts` |

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

## 17. Member Inspector (成员检视浮窗)

A full-keyboard overlay that lets the **user** inspect each Member's live conversation and directly intervene during an active Team Session. Summoned with `alt+t` (registered via `pi.registerShortcut`; `ctrl+shift+<letter>` is unusable because legacy terminals without the Kitty keyboard protocol send the same bytes as `ctrl+<letter>`, colliding with pi's `ctrl+t` thinking toggle); no reaction outside a team session. See the `Member Inspector` term in CONTEXT.md.

### Layout

```
╭─ Member Inspector ─────────────────────────╮
│ ❰分析员❱  编码员  测试员                    │  ← horizontal member tabs
├────────────────────────────────────────────┤
│  ● user                                    │
│  任务内容...                                │
│  ● assistant                               │
│  回复内容...                                │
│  🔧 read src/index.ts                       │  ← tool call one-line summary
│  ✓ read file contents...                   │  ← tool result one-line summary
│  💭 思考（默认隐藏，t 切换）                 │  ← thinking block (toggled with `t`)
├────────────────────────────────────────────┤
│  ✅ 分析员 12%  │  🔧 编码员 45%            │  ← ops state + context %
│  ←→ 切换成员 ↑↓ 滚动会话 End 跳至底部 …    │  ← navigation hints / input box
│  ctrl+a 中断 ctrl+shift+a 全中断 ctrl+o 压缩 │  ← action hints / input hints
╰────────────────────────────────────────────┘
```

Overlay: `ctx.ui.custom(component, { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } })`.

### Key Map

| Key | Action |
|-----|--------|
| `←` / `→` | Switch member tab (wraps around) |
| `↑` / `↓` / `PgUp` / `PgDn` | Scroll conversation |
| `End` | Jump to bottom + resume tail-following |
| `i` / `Enter` | Open input box |
| `Enter` (in input) | Send: `prompt` when idle, `follow_up` when busy（含字面 `\n` 兜底——kitty 协议激活时 pi-tui 不再将 `\n` 识别为 enter，LF 编码混合终端靠此放行；兜底必须位于任何未来 ctrl+j 分支之后） |
| `Ctrl+Enter` / `Alt+Enter` (in input) | Send `steer` (immediate redirect). **Ctrl+Enter 依赖终端协议**（kitty CSI-u `\x1b[13;5u` / modifyOtherKeys `\x1b[27;5;13~`）；legacy 终端两者同字节 `\r` 无法区分，**Alt+Enter 是协议无关的 steer 路径**（legacy `\x1b\r` / kitty `\x1b[13;3u`）。空文本或无成员时显式 notice，不再静默 |
| `e` | Toggle tool call/result detail expansion — **GLOBAL**: flips ALL member tabs (P3-①: 全 tab 本地重建零 RPC——running/stopped/crashed 同样适用，lastMessages 为空的 tab 保留 refetch 兜底) |
| `t` | Toggle thinking block visibility (hidden by default) — **GLOBAL**: flips ALL member tabs (P3-①: 同 `e`——本地重建零 RPC) |
| `ctrl+a` | `abort` the active tab's member |
| `ctrl+b` / `ctrl+shift+a` | `abort` ALL executing members (working/compacting) in one shot; idle/stopped/crashed are skipped. `ctrl+shift+a` requires Kitty keyboard protocol — legacy terminals send the same byte as `ctrl+a` (single abort), so `ctrl+b` remains the all-terminal key |
| `ctrl+o` | `compact` the active tab's member (NOT ctrl+m — indistinguishable from Enter in terminals) |
| `Esc` | Layered exit: input box → overlay |

### Rendering Granularity

- user/assistant text rendered in full (wrapped)
- thinking blocks hidden by default, **globally** toggleable with `t` (rendered as dim `💭 思考` + wrapped content); **with `t` on, streaming thinking renders line-by-line as deltas arrive** (coalesced local rebuilds at an adaptive 100ms→1s cadence, no RPC; each flush wraps only the new delta via the append-only wrap cache — cost stays flat as thinking grows)
- tool calls collapsed to one-line summaries (`🔧 name arg-summary`), expandable with `e`; the arg summary is **sized to the actual frame width** (`textWidth - 14`, matching the streaming `调用中` variant and the tool-result lines) instead of a fixed 60-char cap — wide frames show more of the argument, narrow frames truncate with `…` (visible-width aware, CJK-safe)
- expanded tool call arguments: pretty-printed JSON, **every line wrapped to the frame width** — long `content`/`command`/`path` values wrap across multiple lines instead of being hard-truncated (the summary line wraps too); total display lines capped at a 40-line budget per call (`EXPANDED_ARGS_MAX_LINES`), overflow collapsed to a `…` marker
- tool results collapsed to `✓/✗ toolName first-line`, expandable with `e`
- virtual scroll: full message history kept in memory, only the visible slice is rendered
- unknown/custom AgentMessage roles fall back to a truncated `[role] json` line

### Data Flow (event-driven refresh)

Two independent refresh paths:

**1. Streaming path (live tail — thinking/text/toolcall stream in as they happen):**

```
Member RPC event message_start / message_update (deltas) / message_end
  → event-handler.ts onMemberActivity(memberName, event) hook   (full event)
  → inspectorHandle.onMemberEvent(memberName, event)
  → MemberInspectorState: assemble the live partial assistant message
      (message_start seeds content; contentIndex-keyed deltas grow blocks:
       text/thinking accumulate, toolcall accumulates raw partialArgs JSON
       and is finalized by toolcall_end)
  → coalesced local rebuild + render (adaptive cadence 100ms→1s, STREAM_FLUSH_MS
      baseline; backs off when a rebuild eats over half the interval, recovers
      when cheap — nextStreamFlushDelay hysteresis)
      — ZERO RPC traffic per delta: the live tail is appended to the last
      fetched history and rebuilt via the incremental cache's streaming-tail
      rule (INCREMENTAL_TAIL) + the P2 append-only wrap cache
      (wrapAppendOnly: WeakMap per block object, wraps only the new delta —
      O(Δ) per flush instead of re-wrapping the whole thinking/text block;
      byte-identical to wrapText incl. grapheme clusters split across deltas).
      Only the ACTIVE tab's tail is rebuilt per flush — N concurrently
      streaming members no longer multiply the cost; inactive tabs catch up
      on tab switch or via the refetch path (markDirty → flushDirty).
```

RPC-mode `message_update` events carry deltas only (the cumulative `partial`
is stripped on the wire) and `get_messages` does NOT include the in-progress
message — it lands in history only at `message_end`. Without the live tail the
inspector showed nothing until the whole thinking block completed; now the
💭 block grows line by line (followTail auto-scrolls; scrolled-up users get
`↓ 有更新`). `message_end` keeps the authoritative message as a **pending
completion** (rendered after the fetched history) until the refetch confirms
it — a message never vanishes between `message_end` and the refetch, and
`reconcilePending` drops it exactly once (content equality; tolerates
interleaved toolResult messages between completions). `agent_end` clears the
live tail.

**2. Refetch path (completed content — P3-③ 只急切刷活跃 tab + P4 游标增量拉取):**

```
Member RPC event (tool_execution_end / message_end / ...)
  → event-handler.ts onMemberActivity hook
  → inspectorHandle.onMemberEvent(memberName, event)   (non-stream events)
  → tab.dirty → throttled flush (500ms): RPC get_entries {since?}  ← P4
  → 首次全量：祖先链 message 过滤 → lastMessages + 建立游标
  → 增量：since 之后 entries 祖先链过滤 → 追加 lastMessages 尾部
  → buildBodyLines([...messages, ...pendingCompletions, live?], opts)  (pure)
  → setTabLines (tail-follow or scroll-preserve + "↓ 有更新")
  → tui.requestRender()

Context usage (footer %): separate 5s poll via RPC get_session_stats.
```

**P4 游标增量拉取（阶段 4，spike: docs/spike-get-entries-incremental.md）**：
- **稳态 refetch 载荷 O(history) → O(new)**：每 tab 持久化 since 游标
  （= 最后已见 entry id）+ seen parentId 映射；`get_entries {since}` 只拉
  新 entries → 祖先链过滤（leafId 沿 parentId 回溯，旁支/compaction/
  model_change 剔除）→ 追加 `[...prev, ...fresh]`。磁盘 entry id 跨成员
  进程重启稳定（TL 存活期间游标一直有效）；TL 重启后自然全量重建。
- **显示语义变化**：数据源从 agent 运行时上下文（get_messages，压缩后为
  摘要链）切到磁盘原文（get_entries）——压缩前历史仍可见（更完整）；
  compaction 是额外 entry（磁盘 append-only），**游标不受压缩影响**。
- **失效回退链（fail-open）**：since 不匹配 / 分支重写（since 不在新祖先
  链）/ 断链 → 删游标 + 全量重拉；get_entries 连续两次失败（老版本 pi
  无此命令）→ 该 tab 永久回退 get_messages 全量路径（legacyFetch）。
- **R5: reconcilePending 哈希化**——内容键（role + content 序列化）预计算
  Map<key, 升序下标>，O(p×m) 次 stringify → O(p+m)；语义与逐对比较完全
  等价（取 < scanBound 的最大下标 = 旧向后扫描首个匹配）。

**P3 刷新调度收敛（阶段 3）**：
- **e/t 全局切换 = 全 tab 本地重建（零 RPC）**（P3-①）：running 成员同样适用——
  `lastMessages` 是权威缓存，与 stopped/crashed 路径同款 `rebuildTabFromCache`；
  无缓存的 tab 保留 dirty → refetch 兜底；在途 refetch 拥有该 tab（fetching set）
  → 跳过本地重建（B1/T5 契约：dirty 保留由在途 pending 捕获触发补刷）。
  切换前已 dirty（未落地消息）→ 本地重建后必补一次 flush（P3-②，消息不丢）。
  同宽度 full refit 复用 fitMemo（逐行 memo 化，字节一致）+ user/toolResult
  消息 wrap/提取结果缓存 → 4 成员 × 3000 条 toggle 首帧 < 50ms（N6 护栏锁定）。
- **flushDirty 只急切刷活跃 tab**（P3-③）：非活跃 tab 仅置 dirty，switchTab 时
  补刷（单路串行）；在途 refetch 并发上限 1–2（MAX_IN_FLIGHT_REFETCH）。
- **窗口关闭补偿串行化**（P3-④）：交互窗口关闭后的补偿 flush 只刷活跃 tab，
  不并行齐发——滚动停止后不再有 N 路并行全量 refetch 风暴。

### Direct Intervention Semantics

Messages typed into the input box bypass the TL. To keep the team consistent:

- Non-slash text is prefixed with `[用户直接指令（非 TL）]:` so the Member can distinguish the source
- `/...` text is sent raw — the member's agent-session resolves it as an extension command / skill / prompt-template expansion (verified in pi `dist/core/agent-session.js` `prompt()`)
- **User interventions are NOT mirrored into the TL session** — no `pi.sendMessage` notification is generated for direct messages, aborts, or compacts. The TL only learns about them indirectly (member replies, `get_member_log`). This keeps the user's direct control channel private from the TL's turn flow.
- crashed/stopped members reject sends with a footer notice

### 输入键位协议（场景 K/L 双根因）

inspector 输入框曾有两个独立的按键故障根因，修复互补、全量覆盖不同终端类型：

**场景 K（kitty 键盘协议激活，`flags=7` 含 disambiguate）**：所有按键均编码为 CSI-u（按 `a` → `\x1b[97u`）。字符插入分支曾用 `isControlSequence` 拦截一切 ESC 前缀且未解码 → 文字进不去、inputBuffer 恒空 → Ctrl+Enter 读空文本静默关闭、零发送（用户症状"打字不显示 + 发不出去"）。修复：插入分支先经 `decodePrintableKey` 解码（见下方解码纪律）。

**场景 L（legacy 无协议终端）**：Ctrl+Enter 与 Enter 同字节 `\r`，`matchesKey("ctrl+enter")` 零 legacy 回退（原理上不可能——任何回退都会让普通 Enter 误触发 steer）→ 落入 Enter 分支按 auto 发送（steer 语义丢失）；kitty 激活 + LF 编码混合终端下 `\n` 被吞键（pi-tui 的 enter 匹配为 `data==="\r" || (!_kittyProtocolActive && data==="\n")`——kitty 激活后 `\n` 被视为 shift+enter 映射）。修复：alt+enter 双绑定 + `\n` 字面单字节兜底。

#### CSI-u 解码纪律（防再犯硬性约定）

**任何字符插入路径必须经 `decodePrintableKey`（或等价解码）**——inspector 与 pi 主输入框（editor.js）的不一致是本轮 bug 温床：主输入框解码了、inspector 没有。实现注记：**本地实现 `src/ui/pi-key-decode.ts`**——`decodeKittyPrintable` 从主入口 `@earendil-works/pi-tui` 导入（loader 可别名/虚拟模块映射的裸包名），`decodeModifyOtherKeysPrintable` 回退按上游 `dist/keys.js` 原样复刻（0.83.0 与 0.84.2 逐字节一致，diff 验证）。⚠️ 不能深导入 `@earendil-works/pi-tui/dist/keys.js`：pi 扩展加载器（`dist/core/extensions/loader.js`）用 jiti alias 前缀替换解析依赖（`@earendil-works/pi-tui` → 包 main `dist/index.js`），子路径导入被拼接到 main 后 → `<...>/pi-tui/dist/index.js/dist/keys.js` → Cannot find module → 整个扩展 Failed to load extension（2025-08 实测复现：Node 模式 `pi --mode json -e ./index.ts` 报错，本地实现后零错误）。安全性（实测）：仅纯字符/Shift 字符的 CSI-u 被解码；ctrl/alt 修饰序列与 legacy 原字符返回 undefined → 走原兜底路径；解码分支位于 ctrl+enter/enter 键匹配分支之后（顺序双保险）。

#### 键位协议约束表

| 按键 | kitty CSI-u 终端 | modifyOtherKeys 终端 | legacy 终端 | 备注 |
|------|-----------------|---------------------|-------------|------|
| `Ctrl+Enter` | steer（`\x1b[13;5u`） | steer（`\x1b[27;5;13~`） | **不可用**（与 Enter 同字节） | 请用 Alt+Enter |
| `Alt+Enter` | steer（`\x1b[13;3u`） | steer（`\x1b[27;3;13~`，CSI 27;mod;key~） | steer（`\x1b\r`） | 协议无关，全终端可用 |
| `Enter` | auto | auto | auto（`\r`） | 永远可发送（fail-safe） |

已知失效窗口（均 fail-safe，消息仍可经 Enter 发送）：macOS Option 未设 Meta（alt 修饰不上报）、Windows 系统级 Alt+Enter 全屏拦截、kitty 激活但 alt 走 legacy 前缀的混合终端（`\x1b\r` 在 kitty 激活时被识别为 shift+enter、不匹配 alt+enter——此类终端请用 Ctrl+Enter）。

残留限制（显式声明）：kitty 激活 + LF 编码混合终端下 Enter 发送 `\n` 由兜底按 auto 处理（消息发出、非 steer）；Ctrl+Enter 在 legacy 终端按 auto（消息发出、非 steer），需立即转向请用 Alt+Enter。

#### 防误修复说明

**不要为 `ctrl+enter` 添加 legacy 字节回退**（如把 `\r` 也匹配为 ctrl+enter）——legacy 终端下 Ctrl+Enter 与 Enter 同字节，任何回退都会让普通 Enter 误触发 steer。原理不可能，只能依赖终端协议或 Alt+Enter。

#### 用户说明（一次性保守提示）

- 忙碌成员：Enter = 排队（follow_up）、Ctrl+Enter/Alt+Enter = 立即转向（steer）；**空闲成员两者相同**（都是 prompt）——不要在空闲时测试按键差异。
- 裁定方法（10 秒判定所属场景）：① 按 `i` 后打字**是否显示**——不显示 = 场景 K（kitty 激活未解码）；② `od -An -tx1` 观察按 Ctrl+Enter 的字节——`1b 5b 31 33 3b 35 75` = kitty 协议（K）、`0d` = legacy（L）；③ 按发送后**以 footer notice 文本为准**：「输入为空」= 未发出（打字没进 buffer，K 场景空文本路径）；「✓ 已发送/已排队/已 steer」= 已发出（L 降级——注意 K 场景空文本时输入框同样会关闭，不能只看输入框状态）；无 notice 且输入框未关闭 = 吞键。
- 保守建议：不确定终端类型时，**Alt+Enter 或 Enter 永远可用**（steer 或 auto 都保证消息发出）。

### Files

| File | Role |
|------|------|
| `src/ui/member-inspector-state.ts` | Pure display state + line building (no TUI deps, fully unit-tested) |
| `src/ui/member-inspector.ts` | TUI glue: overlay component, key dispatch, refresh engine, send/control logic |
| `src/channel/event-handler.ts` | `onMemberActivity` hook in `EventHandlerDeps` |
| `index.ts` | `registerShortcut("alt+t")`, hook wiring, `/team stop` auto-close |

### Auto-close

`/team stop` (via `teamCtx.onSessionEnd`) closes the overlay if open.

### Shortcut hint

On session start (`teamCtx.onSessionStart` + the `before_agent_start` safety net), a persistent footer status is set via `ctx.ui.setStatus("team-inspector-hint", "alt+t 打开成员检视浮窗")` — same footer area as the "团队成员运行中" status but a separate key, so the two coexist. Cleared on session end.

## 18. Agent-initiated Team Sessions (自主会话, ADR-0003)

The agent can start a team session **itself** — without the user typing `/team dynamic` — to delegate a complex task to Members.

### Entry & lifecycle

```
TL calls start_team_session(task)          ← registered at extension LOAD (the single
  │                                           deliberate exception to session-scoped
  │                                           registration, decision #21)
  ├─ guard: session already active → error (re-entry)
  ├─ bootstrapDynamicSession(origin "agent")   src/setup/dynamic-session-bootstrap.ts
  │    ├─ mkdir sessions/_dynamic_<ts>/
  │    ├─ startSession(emptyTeam, { origin: "agent" })
  │    ├─ ensureSharedContextFile (stub)
  │    ├─ teamCtx: isDynamicSession=true, dynamicPhase="design"
  │    ├─ ensureAddDynamicMemberTool
  │    └─ onSessionStart → activate session tools + add_dynamic_member + stop_team_session
  ├─ teamCtx.agentInitiatedTask = task
  ├─ setGoalInternal(task, derived criteria)   ← Goal reminders keep the TL on track
  └─ notify: "🤖 Agent 已自主启动团队会话：<task>"

… autonomous design → add_dynamic_member → write_shared_context → start_member …
… (phase flips to execution as usual) dispatch → monitor → report …

TL calls stop_team_session()               ← session-scoped; ACTIVATED only in
  ├─ guard: origin !== "agent" → refuse        agent-initiated sessions
  │          (user-initiated lifecycle stays user-owned, /team stop)
  └─ teardownTeamSession()                   src/session/teardown.ts — shared with
                                               /team stop: stop members, deactivate
                                               tools, widgets off, preserve resumable
                                               dir; disk cleanup via /team delete;
                                               endSession + resetGoal
```

### Session Origin drives three behaviors

| Behavior | `origin: "user"` | `origin: "agent"` |
|----------|------------------|-------------------|
| TL prompt | Playbook dynamic-mode prompt (grilling + confirmation gate + first-action protocol) | Autonomous prompt (`src/prompts/agent-initiated-mode.ts`) — no grilling, no gate, no first-action protocol; mission = `agentInitiatedTask` |
| Dispatch-policing guards | tl-read-guard (execution) + design read soft limit (design) — enforced | Both skipped in the `tool_call` handler (early exit); **write guards lifted too (ADR-0003 revision)**: full tool surface in both phases, only the `.shared-context.md` → `write_shared_context` redirect remains |
| `stop_team_session` | Registered but never activated (removed from active set by `enforceSessionToolVisibility`) | Activated at bootstrap; teardown available to the TL |

Rationale (the core design philosophy): in a user-initiated session the user's expectation is "do this *as a team*", so guards enforce the team workflow; in an agent-initiated session the team is the agent's own chosen means — the user only cares about the result, so the agent gets process freedom. **Write guards are user-origin-only (ADR-0003 revision)**: agent sessions lift them in both phases — the write guard is a policy, not a hard invariant (member↔member concurrent writes were never restricted); it never eliminated the overwrite hazard, only narrowed it; and it was already bypassable via `bash` (`cat > file`) in agent sessions, so lifting write/edit converges the bypass back into sanctioned tools. The escape hatch always exists: don't start a session, or `stop_team_session` and edit directly.

### Boundaries

- **Nesting is structurally impossible** — `index.ts` returns early when `TEAM_ROLE` is set, so member processes never see `start_team_session`.
- **Re-entry** returns an error while any session is active.
- **Visibility** — bootstrap fires a `🤖` notify with the task summary, and the team status widget carries a persistent origin marker (🤖 agent / 👤 user) in its title.
- **User oversight is unchanged** — widget, Member Inspector (`alt+t`), Esc, `/team stop` all work regardless of origin.

### Files

| File | Role |
|------|------|
| `src/tools/agent-session-tools.ts` | `start_team_session` (load-time) + `stop_team_session` (session-scoped, agent-only activation) |
| `src/tools/agent-session-tool-names.ts` | Tool name constants (leaf module — avoids import cycles) |
| `src/setup/dynamic-session-bootstrap.ts` | Shared bootstrap behind `/team dynamic` and `start_team_session` (+ `ensureAddDynamicMemberTool`) |
| `src/session/teardown.ts` | Shared teardown behind `/team stop` and `stop_team_session` |
| `src/prompts/agent-initiated-mode.ts` | Autonomous design/execution phase prompts (mission-anchored) |
| `src/session/state.ts` | `SessionOrigin` + `origin` field on `TeamSessionState` |
| `src/session/session-tool-visibility.ts` | `AGENT_SESSION_TOOL_NAMES` + `agentInitiated` dep — origin-conditional activation |
| `index.ts` | Load-time registration, origin-branched guards/prompt, whitelist additions |

## 19. 细粒度活动状态显示层（Activity Tracker + 事件驱动渲染）

### 背景与根因

团队会话中输入框上方的 member 状态栏原先只能显示回合级粗粒度状态（`working` 是 agent_start→agent_end 全程一个 🔧），刷新靠 5s/30s 轮询搭车——状态变化最多滞后 5~30s。**问题是"数据通路没接到 widget"，不是"没有数据"**：成员 RPC 的流式增量事件（thinking/toolcall/text delta + tool_execution_*，含 toolName）已实时到达 TL 进程（Member Inspector 已在消费），只需新增一个独立于粗粒度逻辑状态机的**细粒度显示层**（纯函数 + per-member Map），把 `onMemberActivity` 改为多播喂给 widget。

### 双状态机职责划分（控制面 vs 显示面）

| | 控制面（既有） | 显示面（新增） |
|---|---|---|
| 模块 | `memberOpsStates` / `state-machine.ts` | `src/channel/activity-tracker.ts` |
| 职责 | wait/all-idle 门控、批屏障、auto-compact | 仅喂 widget 的阶段 |
| 状态 | idle/working/compacting/crashed/stopped | thinking/tool-calling/executing/output/working/idle |
| 事件源 | 逻辑事件（task_started…） | 成员 RPC 流式事件（agent_*/message_*/tool_execution_*） |
| 权威关系 | **进程级（crashed/stopped）与压缩态（compacting）以逻辑层为权威**，widget 渲染时 overlay | 其余阶段以显示面为准 |

两状态机并行、互不写入（红线：`memberOpsStates` / `state-machine.ts` / `tl-tools.ts` 零改动）；"两个状态机不一致"不是 bug——控制面驱动门控，显示面驱动展示。

### 数据来源（全部已存在，零新增通道）

| 事件 | 用途 |
|------|------|
| `agent_start` / `agent_end` | 回合边界：置 thinking（初始态）/ 权威归零 idle |
| `message_update`（`assistantMessageEvent.type`: thinking/text/toolcall 的 start/delta/end） | 阶段切换主信号源 |
| `message_end` | 清除全部流式标志（防卡死第一保险，落 working 非 idle） |
| `tool_execution_start/update/end` | executing 阶段（v2：start/update 合并，无 toolName——纯减法简化后两事件同构） |
| `process_exit` / `process_error` | 由逻辑层 overlay 呈现 crashed/stopped；集成层 P3 清理 tracker 条目 |
| `get_session_stats`（保留轮询） | 仅上下文百分比（降频：活跃 15s / 空闲 30s） |

### 状态规则（applyActivityEvent，纯函数）

| 事件 | 动作 |
|------|------|
| `agent_start` | 清空 streams（防上回合残留污染）→ 置 thinking（D1：默认起点，无思考模型由工作态兜底） |
| `message_update` delta | 置对应流标志（thinking/text/toolcall） |
| `message_update` *_end | 清对应流标志（D6：不写死降级，由优先级推导自然落位） |
| `tool_execution_start` / `tool_execution_update`（合并 case） | streams.executing = true（v2：无名字逻辑后同构——start/update 一视同仁，per-activity update 绝不清理任何状态；P1/P2/A1 与 D10 随名字逻辑删除） |
| `tool_execution_end` | 清 executing → 自然回到仍活跃的流（D5）或落 working（D3） |
| `message_end` | 清全部流标志 → working，**绝不落 idle**（D4：回合内多消息间隙不得误报空闲） |
| `agent_end` | 权威归零 idle（D9：直接归零不延迟——节流窗口自然掩盖瞬闪） |
| 未知事件 | 幂等忽略（process_* 由逻辑层负责） |

**阶段推导 `derivePhase(state, now)`（惰性，渲染时计算）**：
1. 回合外（agent_end 后）→ idle
2. 回合内按优先级取活跃流：`executing > tool-calling > output > thinking`；无活跃流 → working（流标志全部为假时以存储 phase 为权威——agent_start 的初始 thinking 无法由流标志表达）
3. 陈旧判定（D7）：thinking/tool-calling/output 的 `lastDeltaAt` 超过 30s 且无新事件 → 降级 working；**executing 豁免**（长工具执行合法无 delta）；惰性化——判定只在读取时发生，无 Timer、无扫描

**多流优先级理由（D5）**：现代模型多块并行流式是常态，简单"最近事件定阶段"每秒抖动数次；工具执行是外部副作用（最重）、thinking 是内部过程（最轻）。流活跃标志结构（start 置位 / end 清位 / message_end 全清）是优先级的基础（乙指出的实现缺口）。

### agent_end 后旧 delta 丢弃门

agent_end 是权威归零点；之后到达的流事件属于已结束回合（延迟投递），一律丢弃直到下一次 agent_start。实现为状态内 `ended` 标记（agent_end 置位 / agent_start 复位）——**未启动成员（fresh 条目）不受门控**（漏 agent_start 时首个事件仍能建立状态，不卡死）。

### 接线（index.ts）

```
成员 RPC 事件 → event-handler（N4 调用点 try/catch 兜底）
  → onMemberActivity 多播（每消费者独立 try/catch，N4）
      ├── Member Inspector（现状，不动）
      ├── activityTracker.onEvent（O(1) Map 更新）
      ├── P3：process_exit/process_error → tracker.delete(memberName)
      └── teamStatusWidget.onMemberEvent（N1 签名过滤 + 节流调度）
  → 逻辑层状态机更新（不受 observer 异常影响）
```

tracker 生命周期随 widget install/uninstall（onSessionStart / onSessionEnd / before_agent_start 安全网双处），无泄漏。

### 显示方案（team-status-widget）——v2 最终矩阵（用户确认）

每成员段 = `图标 + label + 百分比`，**无任何文字细节**（无耗时、无工具名、无省略号）。

```
│ 💭 分析员甲 45% │ 🔧 编码员 30% │ ✏️ 审查员 12% │ ✅ 汇总员 8% │
```

| 显示态 | 图标 | 文案 | 颜色 |
|--------|------|------|------|
| thinking | 💭 | `label 百分比` | accent |
| tool-calling | 🔧 | `label 百分比`（参数生成，ms 级） | warning |
| executing | 🔧 | `label 百分比`（v2：与 tool-calling 同图标同色——靠阶段语义区分，视觉不区分） | warning |
| output | ✏️ | `label 百分比`（v2.2：💬 → ✏️，U+270F+U+FE0F emoji 变体，success 不变） | success |
| working | 💭 | `label 百分比`（中性兜底，不误报；无 tracker 数据时也显示 💭 而非 ✅——dispatch→agent_start 窗口；v2.2：💦 → 💭，默认色；**与 thinking 同 💭 靠颜色区分——默认 vs accent，styled 闸门捕获双向切换**） | 默认 |
| idle | ✅ | `label 百分比` | muted |
| compacting / crashed / stopped | 🗜️ / 💥 / ⏹️ | 维持现状（逻辑层权威 overlay） | 维持现状 |

- **渲染优先级**：`compacting > crashed/stopped > 细粒度 phase > working 兜底 > idle`
- 不显示思考/输出内容与工具参数（隐私 + 单行放不下；内容查看走 alt+t Inspector）
- 整行重建（O(N) μs 级，N≤8），不做段级局部重绘（D8）
- **v2 同图标同色语义**：tool-calling ↔ executing 切换 styled 输出完全相同 → 渲染闸门正确跳过 setWidget（视觉无差异 = 无需重绘，恰是 N1 语义）；两 phase 保持结构独立（多流优先级 D5 与签名区分），未来恢复显示差异时结构无需重建
- **v2.2 同图标异色语义**：working 💭（默认色）与 thinking 💭（accent）同图标——颜色是唯一区分；渲染闸门键为 styled 行（含颜色），正确捕获 working↔thinking 双向切换（B1 颜色盲区守卫测试锁定，见 §20 N1 行）
- **浮窗同步（R3）**：Member Inspector `stateIcon()` working → 💭（footer 消费点，v2.2 同步；与 thinking 同 💭 靠颜色区分）；toolCall 摘要行 🔧 与 thinking 💭 标签语义一致不改
- **list_members（D5 用户裁决）**：文本输出 working 图标 💦——**独立保持不改**（v2.1/v2.2 均未点名，状态栏兜底与浮窗已两次变更为 💭）

### 防卡死三层兜底

1. `message_end` 清全部流标志（落 working 不落 idle——误报空闲违背核心诉求，故不采纳 message_end→idle）
2. `agent_end` 权威归零 idle（双保险）
3. 30s 陈旧判定（豁免 executing/compacting，回退 working 非 idle）——经 N2 轮询 refresh 闭环执行

### 事件驱动刷新（N1 双层去重 + 节流）

- **调度侧签名过滤**：每事件计算该成员的显示签名 `logical|phase`（v2：耗时/工具名已删，签名即逻辑层 overlay 状态 + 细粒度 phase）；未变不调度渲染（流式期间 phase 窗口间几乎不变，消除"节流器被持续踢醒"）
- **合并节流**：120ms 合并窗口 + `nextStreamFlushDelay` 自适应退避（上限 1s；复用 Inspector 模式），~10 次/s 仅为安全上限
- **渲染侧闸门**：flush 时比较 styled 行（raw+颜色）与上次输出，未变跳过 setWidget（setWidget 是无状态快照全量重建 + 无条件 requestRender，上游实证为最大成本项；**B1**：比较必须含颜色——raw 比较有颜色盲区；v2 图标矩阵下各 phase 图标互异，颜色盲区场景结构性消失，styled 比较仍是稳健超集且正确去重 tool-calling↔executing 同图标同色对）

### 显示层关键边界（审查沉淀）

- **P3**：process_exit/process_error 必须 `tracker.delete(memberName)`——executing 豁免 stale 的成员崩溃后若不清理会永久显示 🔧（executing）；auto-restart 由下一次 agent_start 重建条目
- **S1**：进程死亡事件**强制调度**渲染（绕过签名闸门）——idle 成员（无 tracker 条目）崩溃时 P3 delete 是 no-op、签名不变不调度，若不强制则崩溃显示滞后至 30s 轮询；flush ≥120ms 后逻辑层已更新，显示正确
- **B1**：渲染闸门比较必须含颜色（styled 行）——同图标不同色对（working 💭 默认 vs thinking 💭 accent，v2.2 起为活跃场景；pre-v2 的 working 🔧 vs tool-calling 🔧 同属此型）raw 完全相同但 styled 不同；同图标同色对（tool-calling ↔ executing，均 🔧 warning）styled 相同被正确去重
- working 兜底色为"默认"（不调 theme.fg）；`ThemeColor` 无 "default" token，直接输出原始文本

### v2 简化与决策演变（用户确认最终方案）

| 项 | 阶段 2 状态 | v2 状态 |
|----|------------|---------|
| 耗时微文案（增强 A） | thinking/output 显示 `12s`、executing 显示 `1m20s`（phaseSince 派生，零 Timer） | **撤销**：显示只保留 icon+label+百分比；`phaseSince` 字段与 `formatDuration` 删除；签名秒取整维度删除 |
| 工具名显示（D10） | executing 显示截断 toolName + 省略号（`bash -…`） | **撤销**：`toolName`/`toolNameTruncated`/`TOOL_NAME_MAX_CHARS`/`truncateToolName` 删除；P1/P2/A1 审查修复随名字逻辑一并删除；start/update 分支合并 |
| working 兜底图标 | 🔧（默认色，与 tool-calling 同图标不同色） | **🧱（默认色）**——🔧 让位给工具阶段；与 tool-calling 的区分从"同图标不同色"变为"不同图标不同色"（更清晰） |
| executing 图标 | ⚙️（warning） | **🔧（warning，与 tool-calling 同）**——视觉不区分、结构仍独立；快速工具 <120ms 窗口吞没场景信息损失降为零（R1 次生症状消解） |
| output 图标 | 📤（success） | **✍️（success）** |
| 签名（N1 调度侧） | `logical\|phase\|toolName\|秒取整时长` | **`logical\|phase`**——事件路径不再读时钟 |
| 浮窗（Member Inspector） | footer working 🔧 | **🧱**（stateIcon 消费点；toolCall 摘要行 🔧 / thinking 💭 标签语义一致不改） |
| list_members 文本 | working 🔧 | **💦**（D5 用户裁决——文本消息与状态栏区分） |
| bugfix 方案（耗时/工具名修复、sticky） | 未实施（git 实证），零回滚 | **废弃**：仅文档记录决策演变；R1 次生症状（快速工具 executing 不渲染）在 v2 下信息损失降为零 |
| 保留不动 | 节流/渲染闸门/轮询（N2/N3）/防卡死三层兜底/N6 护栏/overlay 优先级/百分比 | 全部保留 |
| **v2.1 图标微调（用户二次确认）** | v2 状态：working 兜底 🧱、output ✍️ | **output 💬（success 不变）、working 兜底 💦（默认色）——状态栏/浮窗 stateIcon/list_members 三处统一 💦**；仅字符替换，颜色/结构/闸门语义零变化 |
| **v2.2 图标微调（用户三次确认）** | v2.1 状态：working 兜底 💦、output 💬 | **working 兜底 💦→💭（默认色）——与 thinking 💭 同图标靠颜色区分（默认 vs accent），渲染闸门（styled 含颜色）正确捕获 working↔thinking 双向切换（B1 颜色盲区守卫测试）；output 💬→✏️（U+270F+U+FE0F，success 不变）；浮窗 stateIcon 同步 💭；list_members 保持 💦 不改**；仅字符替换，颜色/结构/闸门语义零变化 |

测试影响（v2 落实）：删除 D10（5 例）/P1/P2/A1（4 例）/phaseSince（2 例）/耗时格式（1 例）/秒边界（1 例）共 13 例；新增 start/update 等价断言、tool-calling↔executing 同视觉闸门去重断言、显示纯净断言（无 `\d+`/省略号/工具名）；N6 风暴护栏保持（setWidget 有界且非零）。

## 20. 性能评估与优化（N1–N6 / P1–P13 / O1–O4）

> 本方案（成员状态栏实时化）的配套性能评估结论：**方案本身性能安全，无架构级优化需求**——事件侧每事件 O(1)（μs 级）、内存 KB 级零累积、对现有通道（消息队列/路由/批屏障/auto-compact/派发）零叠加、轮询 RPC 净减 2/3（活跃期 5s→15s）。全部新增成本量化后 <1% CPU + ~2KB 内存。

### 四维度成本模型与量化

| 维度 | 结论 | 量化依据 |
|------|------|----------|
| 事件处理 | 每事件 ~0.5–1μs（Map.get + 字段写，无字符串构建） | 8 成员并发风暴 400–800 事件/s ≈ 4ms/s CPU（<0.5%）；tracker 接入点在 onMemberActivity 回调，**不在 notifyHandlers 数组内**——每事件 handler 遍历 O(H) 不变；JSON.parse 是现状成本（Inspector 已承受），方案不增加解析次数。**集成测试实测：4000 事件 1.2ms（0.30μs/事件）** |
| 渲染 | **唯一主要成本项**：setWidget →（无条件）requestRender → doRender 全屏重绘 | 上游实证：setWidget 全量销毁重建组件 + 无条件 requestRender + pi-tui doRender（16ms 节流合并）。**组件侧实测：buildDisplay+setWidget 7.3μs/帧（v2 简化后，N=500）**；真实 doRender 全屏遍历为 pi-tui 内部实现（依赖真实 TUI 环境，未直接实测），N1 收益论证不依赖精确帧成本（D4：真实值在百 μs–ms 级，方向共识成立） |
| 内存 | MemberActivity ~200B/成员，20 成员 <5KB；零累积（不存 delta 内容/历史），uninstall 清空 | 与 Inspector 的 MB 级缓存本质不同 |
| 轮询 | 净收益：活跃期 5s→15s，RPC 往返减 2/3；连带 sendCommandAndWait 临时 handler 匹配次数减 67% | N3 并行化后单次轮询最坏 ≤3s（max 语义），不再有 3N s 串行漂移 |

### 稳态认知（最坏 vs 稳态双口径）

- **最坏口径**：10 次/s（120ms 节流窗口的安全上限）——仅作预算上限
- **稳态口径（认知修正，v2 更新）**：正确实现渲染去重后，渲染频率由**阶段切换**驱动，而非 delta 频率——稳态约 **1–3 次/s**（阶段切换 5–10 次/回合 + 15s 轮询百分比变化）；v2 删耗时/工具名后签名进一步简化为 `logical|phase`，tool-calling↔executing 同图标同色对的 setWidget 也消失（渲染频率只降不升）；N6 风暴实测 setWidget 有界（4000 事件仅 1 次，且 ≥1 非零）

### N1–N6 决策与依据

| # | 优化 | 做法 | 依据 | 预期收益 |
|---|------|------|------|----------|
| **N1** | 渲染去重双层闸门（收益最大） | ① 调度侧签名过滤（`logical|phase`，v2 删耗时/工具名维度，未变不调度）；② 渲染侧 **styled 行比较**（raw+颜色，未变跳过 setWidget） | 流式期间签名几乎不变；setWidget 是"无状态快照"全量重建 + 无条件 requestRender（实证）；B1 修正：raw 比较颜色盲区；v2 下 tool-calling↔executing 同图标同色 styled 相同被正确去重 | TUI 重绘从 ~10 次/s 降至 1–3 次/s（doRender 次数降 ~70–90%），唯一达"可感知 CPU/I/O"量级的成本项 |
| **N2** | 轮询完成后保留 refresh()（表述修正） | `pollContextUsage` 完成（无论百分比是否变化）仍调用 refresh()；是否 setWidget 由 N1 渲染侧闸门把关 | 长无事件期百分比冻结（v2 删耗时后百分比是唯一轮询驱动内容）；陈旧判定需渲染闭环；轮询是唯一时间驱动兜底源 | 正确性：百分比规律刷新、第三层防卡死生效；零成本 |
| **N3** | 轮询并行化 | 串行 for-await 改 `Promise.allSettled` 并行（各自 try/catch） | 实证串行 + 3s 超时 = 最坏 3N s（N=8 → 24s）；降频后周期 < 耗时 → 调度漂移；顺带修复 abort 后仍重排的定时器泄漏 | 单次轮询最坏 3N s → ≤3s（max 语义）；周期确定化 |
| **N4** | 多播异常隔离 | onMemberActivity 多播中每个消费者独立 try/catch + event-handler 调用点兜底 | onMemberActivity 调用点在 if 链**之前**，observer 抛错会中断后续状态机更新 | 状态机更新不被显示层异常中断（单测锁定：throw 后 agent_start/end 仍推进） |
| **N5** | tracker 事件路径硬性 O(1)（验收硬标准） | onEvent 只写 streams 布尔 + 时间戳 + toolName + Map set；不构建字符串（D10 截断为唯一有界例外）、不调 theme/visibleWidth/UI、不拷贝大对象；模块零 import（不 import pi-tui/pi） | 事件风暴 400–800/s 下任何非 O(1) 操作线性放大 | 每事件成本锁定 ~1μs（实测 0.30μs）；防回归由静态扫描测试 + 代码审查双锁 |
| **N6** | 性能护栏测试（CI 硬断言） | 集成测试注入 mock 高频事件（8 成员 × 500 事件），断言：① setWidget 调用有界（≤100）且非零（B1 修复后 S3 互补断言）；② 内容未变不触发 / 内容变化必触发双向断言（语义化避开时长进位歧义）；③ tracker 处理总耗时 < 50ms（实测 1.2ms）；④ performance.now() 实测单帧成本留档（buildDisplay+setWidget 8.5μs/帧；真实 doRender 为上游全屏遍历，依赖真实 TUI，记录实证链：setWidget→requestRender→doRender 16ms 节流）；⑤ uninstall 无定时器泄漏（vi.getTimerCount() === 0） | delta 频率未实测（依赖真实模型不稳定），CI 断言把"事件驱动不退化"锁进可验证硬约束 | 事件风暴下不退化成为回归护栏；消除 doRender 量化缺口 |

### P1–P13 伪优化排除清单

| # | 伪优化 | 排除依据 |
|---|--------|----------|
| P1 | 段级局部重绘（仅重绘变化段） | 单行段宽联动（toolName 截断推移后续段），段级宽度跟踪复杂度远超 O(N) 整行重建（N≤8 μs 级）；与 TUI 行级模型冲突 |
| P2 | 事件批处理/队列化消费 | tracker 每事件 O(1)，批处理只增延迟与复杂度；异步化破坏 FIFO 顺序与 Inspector 实时性；合并职责已由渲染节流承担 |
| P3 | worker/异步渲染 | widget 渲染 μs 级，移出主线程的通信成本 > 渲染成本本身 |
| P4 | JSONL 解析微优化 / 缓冲合并 JSON.parse | 现状瓶颈不在 TL 侧解析（1–5ms/s）；改动共享热路径影响 Inspector；收益 <1ms/s，回归风险大 |
| P5 | visibleWidth/宽度缓存 | 每段 2 次 × 8 段 × 10 次/s <0.4ms/s；文本内容变化导致命中率极低；引入失效管理 |
| P6 | per-member 独立节流器/渲染队列 | 全局单合并窗口已天然批处理；分队列增加 N 个定时器，零收益 |
| P7 | **delta 抽样（跳过部分事件降频）** | 破坏流标志 start/end 配对语义 → 阶段错误/卡死；正确性换不存在的性能问题（最容易被人捡回去的伪优化） |
| P8 | 二进制协议替换 JSONL | 单事件 μs 级零收益；破坏顺序语义，协议复杂度爆炸 |
| P9 | 轮询期间暂停 tracker | 职责错误：tracker 是显示层唯一事件源，暂停即显示冻结 |
| P10 | 陈旧阈值调低（30s→5s） | thinking_delta 正常持续到达，5s 无 delta 基本不可能；调低只扩大误伤面（executing 已豁免） |
| P11 | 节流窗口降到 <100ms | 终端 60fps（16ms 帧），100ms 已远超视觉需求；N1 后窗口大小几乎无关 |
| P12 | 打字机/动画效果 | 需求未要求；直接放大渲染量（每帧 setWidget） |
| P13 | derivePhase 记忆化缓存 | 几个 boolean 判断 O(1)，缓存 + 失效追踪复杂度 > 收益 |

### O1–O4 可选优化定位

| # | 优化 | 状态 |
|---|------|------|
| O1 | 1s 时长实时 tick | **随 v2 撤销**（耗时显示已删，此优化失去载体）；如需恢复耗时显示，1s tick 仍默认不做（违背"无定时器"纪律） |
| O2 | 增强 B（agent_end 惰性百分比查询，取消活跃期轮询） | **保留可选**——RPC 再省 ~98%（活跃期），非用户可见价值；若实施须保留 30s 空闲轮询兜底（long-idle 不刷新 + resume 首查延迟两个失效条件） |
| O3 | 合并窗口参数一次性实测校准 | 阶段 2 落地后按真实流式频率采样校准一次（一次性测量非持续监控）；120ms 起始窗口 + `nextStreamFlushDelay` 退避为 Inspector 先例估计值 |
| O4 | 超宽缓解（成员 >8–10 时 toolName 截断更激进） | **需用户反馈**——UX 非性能问题；单行溢出导致 TUI 换行/布局成本，截断参数调优零风险 |

### 修订变更摘要（原方案 → 性能修订版）

| 变更 | 原方案 | 修订版 |
|------|--------|--------|
| 「轮询不再承担刷新职责」表述 | 易误读为不 refresh | **明确：轮询完成后保留 refresh()**（N2，三方独立确认的必要修正；时长/百分比/陈旧判定闭环） |
| 渲染刷新 | 合并节流 100–150ms（10 次/s 封顶即稳态） | **双层去重（N1）**：稳态 1–3 次/s（阶段切换 + 15s 轮询），10/s 仅为安全上限；v2 后 tool-calling↔executing 重绘亦消失 |
| 轮询实现 | 串行 for-await（既有缺陷未触及） | **并行化 Promise.allSettled（N3）**：单次最坏 3N s → ≤3s |
| onMemberActivity 多播 | 顺序分发，无隔离 | **消费者级异常隔离（N4）**：tracker 抛错不中断状态机更新 |
| tracker 纪律 | O(1) 目标 | **验收硬标准（N5）**：无字符串构建/不碰 UI/不 import pi-tui；toolName 截断预计算（D10） |
| 性能验证 | 无专项断言 | **N6 性能护栏**：事件风暴断言 + 双向去重断言 + 单帧成本实测 + 无泄漏 |
| 其余（数据来源、状态设计、显示方案、D1–D13 裁决、阶段边界） | — | 全部不变（D1–D13 裁决记录见 §19 与上表；N 系列为实现细节与验收标准，不构成新裁决、不与之冲突） |
| 可选增强 | O1 时长 tick / 增强 B | 维持可选（**O1 随 v2 撤销**——耗时显示删除后失去载体；增强 B 保留 30s 兜底；O3 窗口参数一次性校准；O4 超宽缓解） |
| **v2 纯减法简化（用户确认）** | 状态栏含耗时 + 工具名（D10 截断） | **只保留图标+label+百分比**：tracker 删 3 字段（toolName/toolNameTruncated/phaseSince）+ D10/P1/P2/A1 + start/update 合并；widget 删 formatDuration/时长/工具名渲染，签名 `logical|phase`；图标矩阵最终态（working 💭 默认 / tool-calling+executing 🔧 warning / output ✏️ success，v2.2 微调后）；浮窗 stateIcon 💭；list_members 💦（D5，独立保持）；节流/闸门/轮询/防卡死/N6 全部保留；bugfix 方案废弃零回滚（仅文档记录，见 §19 决策演变表） |
| 输入键位协议修复（场景 K/L，§17） | 字符插入无 CSI-u 解码；Ctrl+Enter 无 legacy 回退 | 插入路径经 `decodePrintableKey`（O(1) 单次正则，每键一次，性能零影响、无渲染路径变更）；alt+enter 双绑定 + `\n` 兜底；完整键位约束表/解码纪律/防误修复说明见 §17 |

### 风险与对策（性能视角）

| 风险 | 对策 |
|------|------|
| 渲染去重引入"内容变了但未重绘"正确性缺陷 | 渲染侧 **styled 行比较**（B1 修正后含颜色，免键集遗漏风险）+ N6 "内容变化必触发"反向断言锁定 |
| 时长显示在去重后冻结 | 秒取整进调度侧签名 + N2 轮询 refresh 提供时间驱动触发（**v2：耗时已删，此项消除**；百分比由 N2 轮询 + 渲染闸门驱动） |
| 事件风暴下节流器被持续"踢醒" | N1 调度侧签名过滤（不变化不调度），消除"调度频率=事件频率"风险 |
| 多播异常中断状态机更新 | N4 消费者级 try/catch + event-handler 调用点兜底 |
| 轮询周期漂移导致百分比刷新不规律 | N3 并行化 + N2 完成后 refresh，周期确定化 |
| 崩溃成员永久显示 executing | P3 tracker.delete + S1 进程死亡强制调度渲染（≤120ms 显示 💥/⏹️） |
| 单行超宽（成员 >8–10）导致 TUI 换行/布局成本 | 已知 UX 边界（非性能问题），toolName 截断缓解；O4 需用户反馈 |
| doRender 单帧成本量化缺口（三方均未实测） | N6 中 performance.now() 实测组件侧留档（7.3μs/帧，v2 简化后）；N1 收益论证不依赖精确帧成本 |

## 21. 自动压缩超时事件驱动出口（Phase 1 止血）

> 背景：member 触发自动压缩后压缩超时 → TL 端 fail-open 立即派发 → 成员端同步拒收（`"Cannot submit a prompt while compaction is in progress"`，压缩检查位于 followUp 排队逻辑之前）→ 拒收分支只 resolve corrId 不纠正状态 → `working` 成为无清算事件的黑洞状态 → `wait_and_get_member_status` 无限卡死。根因：**TL 用本地倒计时（租约）判断压缩结束，但真实状态只有成员端知道（心跳）**。Phase 1 为止血 + 防御纵深（独立可交付）；Phase 2 根治（超时后不派发、事件驱动补发、批路径接线）按方案另行实施。

### 设计原则

1. **权威信号回归**：压缩生命周期由成员端 `compaction_end` 事件（心跳）权威驱动；TL 端 `timeoutMinutes` 仅作「停止主动等待」的租约，到期 ≠ 压缩失败。
2. **状态诚实**：压缩真实进行中 → 状态恒为 `compacting`，绝不预置虚假 `working`；拒收后按 `get_state` 实际结果恢复（compacting/idle 二选一）。
3. **防御纵深**：wait 工具 deadline 兜底——无论根因修不修，用户永不无限卡。
4. **诚实通信**：通知与实际结果一致（删除「已直接派发任务」假陈述）；不依赖 LLM 听从引导性文案。

### 1.1 compaction_end 消费分支（F7 盲区修复，事件驱动支点）

- 收到 `compaction_end` → `autoCompact.endCompaction(name)`（compacting→idle）→ `flushPending(name)` 派发积压消息（→working→agent_end→idle 全链路）。working 成员不受影响（提示词正在处理，绝不可被事件重置）。
- **在飞租约守卫（审查修订，重要）**：上游事实——成员端**先 emit `compaction_end`、后写 compact 响应**（agent-session.js 发射事件 → rpc-mode.js 写响应），事件流对 toJsonEvent 透传。因此每次租约内成功的压缩，TL 都会在 compactNow 响应到达之前处理事件。runtime 新增在飞跟踪：`compactNow` 入口登记、settle（成功/失败/超时）后清除（`hasInFlightCompaction`）；分支开头 `if (hasInFlightCompaction(name)) return`（并 `markCompactionEndDuringLease` 记录心跳）——在飞期间由持有流程（内联 finally / 批屏障）负责退出与**按序**补发。
  - (a) 顺序反转：无守卫时分支先 flush 派发 pending B、finally 才派发触发压缩的当前消息 A → 成员端收到 B 先于 A，违反「reset → 派发当前消息 → FIFO 补发积压」锁定顺序（内联场景必然触发，批屏障恰好正确）。
  - (b) 双重压缩窗口：事件与响应若跨 chunk 到达，分支提前复位 compacting→idle，亚毫秒窗口内新派发重新 beginCompaction → 第二个 compact RPC，结构上破坏「at most one compaction per dispatch」。
  - 仅「无在飞租约」（超时后心跳，finally 已结束）才执行 endCompaction+flush+通知。超时路径语义不受影响。
- **near-miss 陈旧 mark 抑制（审查建议 1）**：compaction_end 在租约在飞期间到达（压缩实际已完成、响应因大结果延迟晚于租约）→ 超时 catch 检查 `compactionEndDuringLease`（按租约起始时间戳）→ 不记录 mark。否则 mark 残留到下一次正常压缩的 compaction_end，误报「压缩已于 N 分钟后结束」（分钟数还基于旧时间戳）。记录与读取均按租约作用域（settle 清除 + leaseStart 双保险）。
- **超时痕迹桥接**：runtime 新原语 `markCompactionTimeout(name)` / `takeCompactionTimeout(name)`（per-member Map）。`compactNow` 在本地租约超时（sendCommandAndWait reject 消息含 `timed out`）时记录时间戳；非超时失败（RPC 错误响应/其他 reject——成员端压缩已结算）不记录。`compaction_end` 分支消费一次即清 → 超时场景通知 TL「压缩已于 N 分钟后结束，积压消息已自动补发」；正常路径保持静默（成功静默原则）。
- **时序收敛性**（单管道 FIFO）：拒收→get_state 查询与 compaction_end 到达顺序无论先后均收敛——get_state 先到：compaction_confirmed→compacting→compaction_end→idle ✓；compaction_end 先到：endCompaction（working 不动）→get_state false→task_completed→idle ✓。**true 恒先于事件**（查询时仍在压缩 → 响应在成员端先于 compaction_end 写出），陈旧 true 晚于事件在管道上不可能；**false 可后至**（查询时已结束）——后至 false 是正常闭合路径（working→idle）。

### 1.2 拒收分支状态纠正（get_state 判定，beta 形态）

- prompt 拒收分支（`success===false && id===undefined`）在 resolve + 通知后追加 `get_state` 查询（3s 超时 fail-open，runtime 新原语 `queryCompactionState`，复用 queryStats 模式）：
  - `isCompacting === true` → 置 `compacting`（状态机新事件 `compaction_confirmed`：working→compacting 纠正黑洞；crashed/stopped 不动）。出口由 1.1 提供；后续新消息经 sendToMember 的 compacting 分支自动入 pending → **双重压缩循环从结构上消灭**（拒收时压缩大概率仍在跑，拉回 idle 会让 TL 重派触发第二个并行 compact）。
  - `isCompacting === false` → 置 `idle`（`task_completed` 事件，保持纯函数纪律；重派安全）。
  - 查询失败 → `idle` + 通知（保守选择）。
  - handle/runtime 未接线 → no-op（legacy 最小配置行为不变）。
- **陈旧答案不覆盖新状态（审查建议 2）**：查询窗口（≤3s）内若真实回合开始（agent_start/agent_end）或进程退出（process_exit/process_error），handler 内 per-member `stateGeneration` 递增；纠正应用前校验「状态仍为拒收快照 + 代际未变」，否则整体跳过（含保守通知）。否则陈旧 `isCompacting=false` 会把 running turn 覆盖为假 idle（wait 工具提前释放），陈旧 true 会把新 prompt 覆盖为假 compacting（无出口）。`compaction_end` 刻意不计入代际：单管道 FIFO 下 **true 答案恒先于事件到达**（成员查询时仍在压缩 → 响应先写出；陈旧 true 晚于事件在管道上不可能），**false 答案可能后至**（查询时压缩已结束）——后至 false 恰好是正常闭合路径（working→idle），计入代际会误杀它；且计入会让已结算租约的心跳流程困死在 working（endCompaction 对 working 是 no-op，只有查询答案能闭合）。
- 通知文案诚实化：「消息未送达（已丢失，请稍后重试）…已查询成员实际状态并按实际恢复」。

### 1.3 waitForAllIdle deadline + 诊断（beta C，防御纵深）

- `waitForAllIdle(memberOpsStates, deadlineMs?)` 返回 `{ timedOut, stuckMembers }`；deadline 默认 15 分钟（`DEFAULT_WAIT_TIMEOUT_MINUTES`，`src/settings/resolve-wait-timeout.ts`），`resolveWaitIdleDeadlineMs(getSettings?)` 解析顶层 `waitTimeoutMinutes`（0 = 不限保持现状），无配置时用默认（deadline 是防御纵深，与 auto-compact 开关正交）。
- 到期返回诊断：疑似卡死成员（working/compacting）+ 建议操作（`stop_member` / `/team stop` 后 `/team resume`）。`wait_and_get_member_status` 与 `team_send_and_wait` 的 all-idle 等待门控同时受益（后者 partial 结果追加诊断块）。
- `setInterval` 加 `unref`（与批屏障 `waitForMembersIdle` 一致——Esc 中断后无轮询泄漏）。
- wait 结束后**重读状态**输出（不再用 pre-wait 快照——成员可能在等待期间完成转换，状态栏必须反映 post-wait 现实）。

### 接线与测试

- DI：`EventHandlerDeps` 新增 `autoCompact?`（共享 runtime）与 `memberHandles?`（get_state 查询 + flush 派发）；`MemberLifecycleDeps` 同步新增并转发；`index.ts` 注入。
- 共享派发提取为模块级 `dispatchPromptToMember`（`PromptDispatchDeps`：pi/memberOpsStates/memberHandles/lastPendingCorrId/responseWaiter）——内联路径与 compaction_end flush 路径同一套发送语义（working 标记 + followUp + sendCommand 异常 fail-open）。
- 测试（37 个新用例，含审查修订 7 个）：拒收状态恢复四态（compacting/idle/查询失败+通知/无接线 no-op）、诚实文案断言、compaction_end 分支（正常静默+flush/超时通知+单次消费/无 runtime no-op/working 不动）、双重压缩防护（compacting 成员新消息→入 pending→compaction_end→自动派发，期间零 RPC）、状态机 `compaction_confirmed` 转换表（working/idle→compacting、compacting 幂等、crashed/stopped 不动）、runtime 新原语（超时标记/非超时不标记/单次消费）、wait deadline（诊断内容/0=不限/unref 存在性/工具级回归）、team_send_and_wait deadline 诊断；**审查修订用例**：在飞租约守卫集成用例（compaction_end 先于 compact 响应到达→不提前复位/不提前补发→响应 settle 后 A→B→C 顺序锁定 + 窗口内新派发零二次压缩）、在飞租约生命周期（true/false）、near-miss 陈旧 mark 抑制、陈旧答案不覆盖（agent_start 窗口内 skip / 保守回退 skip）。

## 22. 自动压缩超时根治（Phase 2：事件驱动派发，三出口闭合）

> 依赖 Phase 1（§21：compaction_end 消费分支 + 拒收 get_state 判定 + wait deadline）。Phase 1 止血：拒收后状态纠正 + wait 兜底；Phase 2 根治：**超时后不派发**，由成员端心跳权威驱动补发，消息零丢失。核心抽象延续「租约 vs 心跳」——TL 本地计时器只是租约，`compaction_end` 才是心跳。

### 2.1 内联路径超时语义重定义（runAutoCompactAndDispatch）

- `compactNow` 结果增加 `timedOut` 判别（`CompactResult`）：本地租约超时 = 压缩可能仍在成员端运行 → **不再 fail-open 派发**（Phase 1 证明：派发必被拒收 → 消息丢失 + working 黑洞）；保持 `compacting`，消息经 `queueDuringStuckCompaction` 入 pending，由心跳 flush。
- 非超时失败（RPC error 响应）＝成员端已结算 → endCompaction → 直接派发（安全）。
- 成功路径不变：endCompaction → 派发当前消息 → FIFO 补发 pending（锁定顺序，正常时序零回归）。
- 超时通知：`压缩超过 N 分钟未完成，任务已排队，将在压缩结束后自动派发`。
- **入队竞态闭合**（alpha）：入队前检查状态——已非 compacting（close 已先跑并 flush 空队列）→ 直接派发，杜绝孤儿。

### 2.2 二次超时兜底 + 轮询兜底（三出口之②）

- runtime 新原语 `waitCompactionIdle(name, handle, budgetMs)`：每 30s 轮询 `get_state.isCompacting`（3s 单次超时，fail-open 按已结束），释放条件 = 操作状态离开 compacting（进程退出，2.3 已接管 pending）或查询 false/失败；预算耗尽 → `{ok:false}`。定时器 unref。
- 兜底 watcher（`startFallbackWatcher`，per-channel dedupe）：仅在**无在飞租约**的 compacting（＝租约已超时的卡住压缩）启动——入口：内联超时分支 + sendToMember compacting 分支（覆盖批屏障消息/Inspector 直发/成员互发）。释放 → `closeCompactionAndFlush`（消费 mark + endCompaction + flush + 超时场景通知）；预算耗尽 → `abandonPendingMessages`（清空 pending + resolve 各 corrId [已放弃] + 通知「请 stop_member 或 /team stop 后 /team resume」）。
- **新租约守卫**：watcher 结算时若 `hasInFlightCompaction`（成员已回 idle 并开始了新压缩周期）→ 不 close 不 abandon——新周期的持有流程接管。
- 预算 = `timeoutMinutes` 一个租约周期（与批屏障等待预算 waitTimeoutMinutes 语义统一）。
- 四场景闭合：正常结束（心跳）✓ / 事件丢失（轮询）✓ / 进程退出（2.3 + 状态释放）✓ / 永不结束（预算放弃）✓。

### 2.3 process_exit/process_error 清 pending（三出口之③）

- 退出/崩溃/主动停止分支统一 `drainPendingOnProcessExit`：清空 pending + resolve 各 corrId（[消息未送达]）+ 静默消费超时 mark（新进程的心跳不误报）+ 通知 TL 消息概要（重启后重派）。

### 2.4 批屏障接线 + attempted 语义修正（alpha P2）

- 屏障 compact 超时：**保持 compacting、不 endCompaction、不计 attempt**——批消息在 commit 阶段经 sendToMember 的 compacting 分支入 pending（自动触发兜底 watcher），心跳/轮询 flush。等待计入 `waitTimeoutMinutes` 预算（compact 已从预算中消耗自身 timeout）。
- **attempted 语义修正**：`skipAutoCompact` 仅绑定「压缩已结清」——compact 响应（成功/非超时失败）**或** compaction_end 事件（runtime 心跳计数 `markCompactionEnd`/`getCompactionEndCount`，屏障按 toWait 等待期/compact 循环期计数增量判定）→ 打标；超时未结清 → 不打标（由等待流程接管，消息不再跳过压缩检查）。
- 事件结清打标同时闭合 E12 竞态：超时成员的 compaction_end 在屏障期间到达（在飞守卫延迟处理）→ 成员被打标 → commit 时消息带 marker 直接派发，杜绝第二个压缩。
- 正常成功路径时序零回归（压缩 2 分钟成功 → compaction_end 在飞守卫记录 → 响应 settle → endCompaction → A→B FIFO）。

### 2.5 测试与不变式核对

- 新增 17 用例：超时→保持 compacting→compaction_end→flush→派发成功不被拒（F11 补齐，全程仅 1 个 compact RPC = E12）；事件丢失→30s 轮询兜底补发；二次超时→放弃+corrId resolve+人工干预通知；进程崩溃/主动停止/process_error→pending 清空+resolve+mark 静默消费；批屏障超时（不打标+状态保持+E1 enqueue 顺序）、屏障期事件结清（打标）、toWait 事件结清（打标）；waitCompactionIdle 全形态（状态释放零 RPC/查询 false/30s 节奏/失败 fail-open/预算耗尽）；心跳计数。
- **E1**：屏障整体仍在 corrId 注册与 enqueue 之前（含超时变体，enqueue 恒在 compact settle 后）；corrId 注册先于 enqueue（commit 阶段既有顺序）；压缩期 pending FIFO；成功路径时序不回归（A→B 顺序锁定测试保持绿色）。
- **E12**：at most one compaction per dispatch——超时链全程 1 个 compact RPC；事件结清打标杜绝 commit 后第二次压缩检查。
- **E15**：gap race 重检保留（stats 与 compact 间成员离开 idle → 跳过不打标，inline 自然接管）。
- 既有「超时→fail-open→继续派发」用例按新语义更新（不再派发）。

### 验收对照

压缩超时后成员状态恒为 compacting（诚实）✓；wait 类工具 deadline 诊断 + 压缩结束自动恢复 ✓（Phase 1）；四场景（成功/失败/事件丢失/进程重启）积压消息零丢失补发 ✓；压缩永不结束 → 放弃+通知+无永久孤儿+无工具无限卡 ✓；批路径与内联一致（同一 queue/watcher 机制）✓；E1/E12/E15 核对通过 ✓；全量测试绿色 ✓。

## 23. Phase 3：上游 abort_compaction ADR + 审查建议三修

### 23.1 交付物（ADR-0006，无本地代码）

`docs/adr/0006-pi-upstream-abort-compaction-rpc.md` — 上游 `abort_compaction` RPC 提案。核心证据（pi 0.84.2 dist 实读）：`agent-session.abortCompaction()` 已存在（~1488），在飞压缩响应 abort（~1429 抛 "Compaction cancelled"），`abort` RPC 不触碰压缩 controller，`compact`/`get_state` 命令入口已具——成本 ~3 行接线。abort 后 compaction_end 照常发出，扩展侧心跳分支零改动消费。二次超时通知文案的升级路径（「请 stop_member」→「可先 abort_compaction」）记录在 ADR 中，依赖上游合入后另行评估。

### 23.2 审查建议 1：waitCompactionIdle 重排 unref

`pollOnce` 内 `timer = setTimeout(...)` 重排处未 unref——初始定时器 unref 了，重排的没有；Esc 中断后卡死压缩的轮询链持有事件循环至预算耗尽。修复：提取 `schedulePoll()` 辅助（`setTimeout` + `typeof unref === "function"` 守卫），初始与每次重排统一走它。测试：fake-clock 包装 globalThis.setTimeout 记录每次创建的 timer 的 unref 调用，断言 3 次调度（初始 + 30s/60s 两次重排）全部 unref（90s 预算耗尽轮不重排）。

### 23.3 审查建议 2：超时路径消息顺序反转（front 插队）

场景：触发消息 A 触发压缩检查 → B、C 在压缩期间到达（compacting 分支 queueDuringCompaction push → [B, C]）→ A 的租约超时 → queueDuringStuckCompaction 追加 → [B, C, A]，flush 顺序 B、C、A，与成功路径「A 先、pending FIFO 后」不一致。修复：`queueDuringCompaction(name, msg, front?)` 增加 front 参数（unshift）；内联超时分支传 `front=true`（A 插队头部 → [A, B, C]）；压缩期间新到达消息（compacting 分支/屏障 commit 后经 sendToMember）保持默认尾部——**只有触发消息插队，其余仍 FIFO**，与成功路径顺序完全对齐。测试：runtime 级 front/false 两向 + 全链路 sendCommand 顺序断言。

### 23.4 审查建议 3：near-miss ~30s 有界延迟（settledByHeartbeat）

场景：心跳（compaction_end）在租约内到达（in-flight 守卫仅记录、分支不复位）→ 租约随后超时 → 消息入 pending + watcher 启动 → 需等首轮轮询（30s）才 close+flush——但心跳已证明压缩结束，30s 纯延迟。修复：`compactNow` 超时 catch 中 near-miss（`heartbeatSeen`）时返回 `settledByHeartbeat: true`（仅此分支置位；timeout mark 依旧抑制）：

- **内联路径**：`!ok && timedOut && !settledByHeartbeat` 才是超时排队分支；settledByHeartbeat 落入静默 settled 路径（endCompaction → 派发 A → flush），零 notify、零 pending、零 watcher；
- **批屏障**：in-loop 结算判定改为 `ok || !timedOut || settledByHeartbeat` → endCompaction + 打标——commit 时成员已 idle，批消息直接派发，零 watcher 轮询；
- 非近失超时（无心跳）行为完全不变（保持 compacting + 入队 + watcher）。

测试：runtime 置位/缺位两向、内联近失全链（零通知/零 pending/立即派发）、批屏障近失断言更新（状态 compacting→idle）。既有 near-miss mark 抑制测试更新为同时断言 settledByHeartbeat。

### 验收对照

超时触发消息在积压队列中的位置与成功路径一致（A 先、FIFO 后）✓；near-miss 场景取消 30s watcher 延迟（内联与批路径均即时结算）✓；非近失超时行为零回归（F11 全链/事件丢失轮询/二次超时放弃测试保持绿色）✓；轮询定时器全链 unref（Esc 中断零泄漏）✓；ADR-0006 交付（上游事实带行号证据）✓；全量测试绿色（1114 通过）✓。

## 24. 压缩后 get_session_stats percent:null 语义分流（问题二 Phase 1）

### 24.1 根因（上游契约 vs 本地误判）

pi 上游 `getContextUsage()`（0.83.x/0.84.x dist 实读，agent-session.js ~2542）：模型/contextWindow 缺失 → `undefined`；存在最新压缩条目且其后无有效 assistant usage（stopReason 非 aborted/error 且 `calculateContextTokens(usage) > 0`）→ **刻意返回 `{ tokens: null, contextWindow, percent: null }`**（注释原文："context token count is unknown until the next LLM response"——压缩前 usage 反映压缩前大上下文、不可信）；否则 → 估算数值。压缩失败不写 compaction 条目（appendCompaction 仅在成功路径，~1432 行），故 **null ⟺ 最近压缩成功且无后续有效回复**，绝非异常。

本地误判：`queryStats` 的 `typeof usage.percent !== "number"` 把合法「未知」与真失败（RPC 超时/断连、undefined）混为一谈 → 误导性「无法查询成员上下文用量」fail-open 通知。功能零损失（fail-open 下消息照常派发；压缩后上下文必然低），伤害 100% 在感知层。

### 24.2 修复（语义三分，仅感知层）

```
usage.percent === null        → { ok: true, stats: { percent: 0, tokens: 0 } }  // 合法未知 → 已知低，静默跳过
!usage || typeof percent !== number → { ok: false, error: "成员未返回上下文用量数据" }  // 真异常，保留通知
正常                            → { ok: true, stats: { percent, tokens: usage.tokens ?? 0 } }
```

- percent:0 是语义化猜测而非事实——防御性注释写明上游契约、版本、字段粒度边界（当前 percent/tokens 同时 null；混合形态需字段级判别，勿锁死假设）。
- `shouldCompact` 与调用点零改动（0 < 任何阈值 → false）；批屏障共享 runtime 自动受益（预检 ok:true → needs=false → 消息不带 skipAutoCompact → 内联再查一次 → 仍静默；双查询为两次本地管道 RPC，无害保留）。
- 通知文案诚实化：stats 失败分支改为「（原因：<RPC 原因或"成员未返回上下文用量数据">）」。
- 恢复窗口 = 压缩完成到首个有效 assistant 回复之间，窗口内每笔查询命中 null；主来源 = pi 自动压缩（agent_end 后 _checkCompaction）/ resume（--continue 最新条目为压缩边界）/ abort / 无 usage 提供商。

### 24.3 测试矩阵（7 条，TDD）

| # | 场景 | 断言 |
|---|------|------|
| 1 | `{tokens:null, contextWindow:200000, percent:null}` | `{ok:true, stats:{percent:0, tokens:0}}` + shouldCompact false |
| 2 | `contextUsage: undefined`（无模型/无 contextWindow） | 仍 `{ok:false}`（真异常保留） |
| 3 | percent 其他非 number 形态（undefined/字符串） | 仍 `{ok:false}`（锁定不放宽） |
| 4 | 端到端：压缩后窗口下一笔任务 | 零通知 + 正常派发 + 仅一次 stats 查询 + 无 compact RPC |
| 5 | 窗口闭合回归：成员处理任务后 percent 正常 92% | 超阈值仍触发压缩（compact RPC 恰 1 次） |
| 6 | resume 场景：--continue 恢复（压缩边界）首笔任务 | 零通知 + 正常派发 + 零 compact RPC |
| 7 | 既有「percent 非 number → 失败」用例 | 保持绿色（锁定） |

全量测试通过（本阶段新增 6 用例 + 1 更新）；压缩决策行为与修复前完全一致（fail-open 语义、批屏障路径、跳过语义均不变）。

### 未采纳（记录，属 Phase 2 或永久否决）

- 冷却标记跳过查询 / 重试 / tokens 历史累计兜底 / 批屏障双查询优化——见方案「未采纳说明」。
- 显示层 percent null 显示"?"（widget/inspector `Math.round(null)===0`）与 ADR-0007（上游 reason 字段为主、估算值为备选）属 **Phase 2**，本阶段未实施。

## 25. 显示层 percent null 判空 + ADR-0007（问题二 Phase 2）

### 25.1 显示层同根症状（gamma 发现）

`Math.round(null) === 0`：widget 与 inspector footer 对 `contextUsage.percent === null`（压缩后合法「未知」，§24）未判空 → 状态栏/浮窗持久显示误导性 "0%"。修复（两处渲染点 + 两处类型定义）：

```ts
// team-status-widget.ts ~204（widget 成员行）
extraRaw += info.percent === null ? " ?" : ` ${Math.round(info.percent)}%`;
// member-inspector-state.ts ~1482（inspector footer）
seg += t.contextInfo.percent === null ? " ?" : ` ${Math.round(t.contextInfo.percent)}%`;
```

- `MemberContextInfo.percent` 类型 `number` → `number | null`（两处定义同步；tokens 同放宽——上游同时 null）。
- 测试：widget 集成用例（get_session_stats 返回 percent:null → 行含 "?" 且不含 "0%"）；inspector-state 纯函数用例（footer 行 "💭 分析员 ?" 且不含 "0%"）；既有数值渲染用例（42% / 45%→47% 轮询）保持绿色锁定。

### 25.2 ADR-0007（上游提案，非阻塞）

`docs/adr/0007-pi-upstream-context-usage-reason.md` — 上游 `getContextUsage()` 的 null 形态（压缩后未知，合法）与 undefined 形态（模型/contextWindow 缺失，配置异常）在 RPC 层无类型标注，消费者只能 `typeof percent !== "number"` 一刀切 → 误报或依赖对上游实现细节的推测。提案：

- **主推 reason 字段**：null 分支返回 `{ tokens: null, contextWindow, percent: null, reason: "post-compaction" }`——一行成本、RPC 层零改动、显式语义、全体消费者通用；null 字段保持保守（不提供可能不准确的估算值）。
- **备选估算值**：null 分支改用 `estimateContextTokens(this.messages)`（compaction.js:131，无 usage 时退化逐条 chars/4 估算）——下游零判别，但与上游「only trust usage」保守原则冲突（需论证估算用于阈值决策的误差可接受）。
- 两者非互斥，并列提交上游裁决；本仓库 Phase 1/2 已正确工作，ADR 仅作文档提案。

### 验收对照

显示层 percent null 显示 "?"（无 0% 误导）✓（widget + inspector 两处）；数值仍原样百分比 ✓（既有用例锁定）；ADR-0007 记录完成（含实现位置与成本说明）✓；未引入其他本地功能变更 ✓（严格 Phase 2 范围）；全量测试绿色 ✓。

## 26. Goal Reminder Lifecycle（阶段 1–3 收口）

本节是 Goal reminder 的实现契约。Goal reminder 只约束 TL 自己的 outer `AgentSession` 生命周期，不等待 Member idle，也不改变消息路由、Member 状态机或自动压缩算法。当前高保真夹具固定使用安装的 pi `0.83.0`；`sendUserMessage` 的 API 形态和事件时序以该版本为准，不能把其他版本的实现细节当作本地保证。

### 26.1 核心不变式

- `agent_end` 是低层回合的中间结束点，只记录本 outer run 的最新 candidate，**绝不发送提醒**。
- `agent_settled` 是唯一提醒投递边界。retry、native compaction、queued continuation 等 post-run 工作结束前，任何回调都不能进入提醒 API。settled listener 内仅使用一次 `setTimeout(0)` 隔离 listener 重入，不把 timer 当作生命周期判断或重试机制。
- 只有 session active、Goal 存在且未完成、candidate 身份仍匹配、run 未 abort、settled context 可读且未 abort、`ctx.isIdle() === true` 时才调用普通 `pi.sendUserMessage(prompt)`；不传 `deliverAs: "followUp"`。忙态保留单 candidate，等待下一次合法 settled，而不是向忙碌 TL 排队。
- `finish_goal` 是完成状态的权威来源；完成、reset、teardown、session/Goal rollover 或取消都会使旧 candidate 失效。

### 26.2 RunState 与身份令牌

`goal-tools.ts` 的模块级状态分成 Goal、outer run、candidate 和投递确认四层：

| 层 | 关键字段 | 作用 |
|---|---|---|
| Goal | `activeGoal`, `goalGeneration` | 目标文本、可验证条件、完成状态；替换 Goal 时递增 generation |
| Session | `sessionId`, `sessionEpoch` | 防止旧团队会话的 late event 污染新会话 |
| RunState | `runId`, `signals`, `sawAgentEnd`, `settled`, `aborted`, `candidate`, `sessionActivatedMidRun`/`activatedSessionId`/`activatedSessionEpoch` | 将 retry/compaction/queued continuation 归并到同一个 outer run，并在 reset barrier 解除前拒绝旧 continuation；后三字段记录会话在 run 中途激活（`start_team_session` 工具调用），豁免发起会话的那一轮的身份守卫，active→active 会话切换不置位 |
| Marker association | `suppressReminderCandidate`, `stalePromptPending`, `sawUserPrompt` | 关联已确认 reminder continuation；stale marker 只在首个用户 prompt 上判定 |
| Submission | `pendingSubmission`, `acknowledgedSubmission`, `uncertainSubmissions` | 区分待 ACK、已关联下一 run、void 无 ACK 的不确定投递 |

`resetGoal()`、session 变化和 `finish_goal` 先捕获仍可能在宿主中继续的旧 run/marker，再清除当前 candidate；reset barrier 在旧 run 的 `agent_settled` 到达前关闭新 run 接纳。旧 signal 以 `WeakSet` tombstone 保存，避免无界保留 signal 对象。

### 26.3 从 `agent_end` 到唯一投递出口

```mermaid
sequenceDiagram
    participant Host as pi 0.83.0 AgentSession
    participant Goal as goal-tools
    participant TL as TL run

    TL->>Host: prompt / queued continuation / retry
    Host-->>Goal: agent_start（建立或复用 outer RunState）
    Host-->>Goal: agent_end（只记录 candidate）
    Note over Host,Goal: post-run retry、compaction、queued continuation 仍可能继续
    Host-->>Goal: agent_settled（唯一 delivery boundary）
    Goal->>Goal: setTimeout(0) + identity/abort/idle re-check
    alt valid settled idle run
        Goal->>Host: sendUserMessage(prompt + hidden marker)
        Host-->>Goal: before_agent_start(prompt)（marker ACK，可延迟）
        Host-->>Goal: agent_start / message_start / agent_end / agent_settled
        Goal->>Goal: suppress this confirmed reminder continuation once
    else busy, aborted, stale, completed, or invalid identity
        Goal-->>Goal: retain or discard candidate; no follow-up enqueue
    end
```

`agent_settled` 的上下文再次读取 signal 与 `isIdle`。`isIdle` 返回 false 时 candidate 留在单槽 pending，后续 settled 才重试；如果 callback 期间发生 Goal/session 变化或新的 run，则发送前再次校验，避免 check→send race。post-run completion 与 Member idle 无关，成员继续运行不会阻止 TL reminder 的合法投递。

### 26.4 API-only cooldown 与失败语义

冷却窗口为 10 秒，`lastReminder.at` 只在所有 guard 通过、即将调用 `sendUserMessage` 的同步点写入一次。`before_agent_start` ACK、延迟 ACK、1 秒 no-ACK watchdog 都不刷新 cooldown。这样 cooldown 锚定唯一可观察的 API submission 点，不受 native preflight 或 provider 延迟影响。

`sendReminderSafely` 兼容三类适配器结果：

1. 安装 pi 0.83.0 的 `sendUserMessage` 返回 `void`：启动 1000ms 有界诊断 watchdog；无 ACK 仅转入 `uncertainSubmissions` 并通知用户，**不恢复 candidate、不自动重发**。在 marker 被确认或 Goal/session reset 前，新的 reminder submission 被阻止。
2. 测试/适配器返回 Promise：resolve 视为接受，reject 恢复仍有效 candidate、清除本次 cooldown 并发出失败诊断。
3. 同步抛错：同样恢复 candidate 并诊断；任何失败路径都不使用 `followUp` 规避生命周期边界。

### 26.5 Marker ACK、stale rollover 与消息角色

每个 reminder prompt 追加 HTML 注释 marker `<!-- top-notch-team:goal-reminder:<id> -->`。marker 不显示给用户，但用于关联 fire-and-forget 请求：只有携带完整 prompt 的 `before_agent_start` 能确认 `pendingSubmission` 或 `uncertainSubmissions`；没有 prompt 的 `agent_start` 不是 ACK。

Goal/session rollover 会把仍可能被宿主接受的 pending、uncertain、acknowledged marker 放入精确 `staleRolloverMarkers` Map。Map key 是真实 marker ID，value 只保存 `markerSeen`、来源 `goalGeneration` 与 `sessionEpoch`，最多保留 64 个未解决 marker；达到上限时暂缓新的 reminder submission，`session_shutdown` 清理所有 marker、timer 和 submission。这里的上限是资源保护，不是 marker 过期或自动重试策略。

`before_agent_start` 看到本次 rollover 捕获的完整 marker 后只标记该 marker；`agent_start` 设置 provisional stale association，但不直接 abort。`message_start` 只检查当前 outer run 的**首个 `role === "user"` message**：

- 首个用户 prompt 是该 captured marker → consume 该 marker、抑制 stale run 并 abort 当前 stale prompt；
- 首个用户 prompt 是普通文本 → 清除 provisional association，fresh run 正常完成；
- assistant、toolResult、后续 user message、未被本次 rollover 捕获的历史 marker 或已 consume ID → 不参与 stale 判定，不会 abort fresh run。

这一区分是必要的：AgentCore 会为 assistant response、tool/result 发送 `message_start`，模型或工具可能原样回显 HTML 注释；不能把 response-side 文本当作用户 prompt。marker 协议只负责 ACK、stale 隔离和重复提交防护，不是独立 watchdog，也不提供 outbox 或跨 session 持久提醒。

### 26.6 用户可见契约与工具文案

`set_goal` description、prompt guideline、tool result 及 TL 注入均使用同一语义：

> 系统只会在 TL 的一次运行完全结算（不会再自动重试、自动压缩或处理排队续跑）且 Goal 仍处于激活状态（尚未关闭）时提醒你检查进度；`agent_end` 只是中间结束点，不会触发提醒。完成目标后请调用 `finish_goal` 工具。

英文 description 使用等价表述：`The system reminds you only after the TL run is fully settled (without automatic retry, compaction, or queued continuation) and the goal remains active (not yet closed).` 不得写成“TL 停止时提醒”或把 `agent_end` 描述成发送边界。`finish_goal` 只标记完成并停止当前 Goal reminder；它不会隐式停止 Team Session 或 Member 进程。

### 26.6a 提醒正文决策结构与强制关闭协议

`buildReminderText` 不以“实际工作尚未完成”为前提——系统只陈述 Goal 仍处于激活状态（尚未调用 `finish_goal`），要求 TL 逐条核对完成条件后，**执行下列唯一匹配的分支**：

1. **全部完成条件已满足** → 调用 `finish_goal` 关闭目标、不再派发任务；
2. **不可解决的阻塞** → 调用 `finish_goal` 并向用户说明；
3. **需要用户提供关键信息或做决策才能继续** → 向用户提出一个具体问题并等待回复，不要调用 `finish_goal`；
4. **仅当确有未满足的完成条件且可继续推进** → 才调用 `team_send_and_wait` 派发下一轮。

分支 3 为“目标尚未过时但需要用户输入”提供出口，避免弱模型在不确定时误选继续派发或误关闭。

三种 TL 提示词变体（预定义团队 index.ts、dynamic-mode.ts 的 design/execution 两阶段、agent-initiated-mode.ts）的收尾流程统一注入共享片段 `GOAL_CLOSING_PROTOCOL_PROMPT`（`src/prompts/goal-closing-protocol.ts`，单一事实来源防漂移，调用处直接注入、不重复“若已设定目标”前缀），且**收尾顺序统一为「汇总并验证（不结束回合）→ 立即 finish_goal → 向用户最终汇报」**——finish_goal 必须置于最终汇报之前，封堵弱模型“汇报后直接结束回合、永不关闭 Goal”的路径。`finish_goal` 的 promptSnippet（`Finish the active goal — call when all criteria met or an unresolvable blocker`）与 promptGuidelines（仅条件满足/阻塞时调用、**仅当条件未满足且仍可推进时不得调用**、文字宣称不算关闭）均区分于 `set_goal`。

### 26.7 Verification and release boundary

高保真测试 `src/tools/goal-tools.agent-session.test.ts` 使用真实 `AgentSession`、`ExtensionRunner`、`ExtensionAPI.sendUserMessage` void wrapper 与 `VERSION === "0.83.0"` 断言，仅 provider transport 使用进程内 deterministic fake。覆盖正常 settled、queued continuation、native auto-compaction、post-run retry、延迟 marker ACK、无 ACK/孤立 `agent_start`、abort、Goal replacement 与 session rollover。

单元测试 `src/tools/goal-tools.test.ts` 覆盖 run/session/Goal 代际、reset barrier、busy/idle、finish、cooldown、sync/Promise/void failure、精确 marker quarantine 上限，以及 assistant/toolResult/后续 user 回显旧 marker的角色过滤。

发布前执行：

```bash
npx tsc --noEmit
npm test
npm run check:goal-reminder
printf '' | timeout 10 ./node_modules/.bin/pi --mode json --no-tools -e ./index.ts
```

最后一条命令必须以状态码 0 结束、stderr 为空，并输出一个 `{"type":"session", ...}` JSON 行；CLI 与高保真测试均应使用安装的 pi 0.83.0（不要用系统 PATH 中的其他 pi 版本）。静态检查只扫描 Goal reminder source/docs；Member channel 的 `followUp` 仍是有意保留的独立语义。阶段 3 不引入 outbox、完整 watchdog、Member idle gate、消息路由或新的 ADR。
