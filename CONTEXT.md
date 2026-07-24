# pi-top-notch-team

Multi-agent team collaboration system for pi agent. Allows users to define teams of agent roles that work together on complex, long-running tasks.

See [DESIGN.md](DESIGN.md) for the full design specification and [docs/adr/](docs/adr/) for architecture decisions.

## Language

**Team Lead (TL)**:
The primary agent that directly interacts with the user. Responsible for clarifying requirements through iterative questioning, breaking down tasks, creating execution plans, and monitoring member progress.
_Avoid_: Main agent, primary agent, orchestrator agent

**Member**:
A background agent that executes subtasks assigned by the Team Lead. Members do not interact with the user directly. They can communicate with other members via the real-time message channel.
_Avoid_: Worker, sub-agent, child agent, slave agent

**Team Definition File**:
A YAML file at `~/.pi/top-notch-team/teams/<team-name>.yaml` describing a team's members and their configurations. Created interactively via `/team create`. Validated at creation time.
_Avoid_: Hardcoded team config, JSON config

**Member Role Definition**:
The fixed configuration (name, label, systemPrompt, optional model) stored in the Team Definition File for each member. Defines the member's inherent role and expertise scope — e.g. "代码分析员" who analyzes code structure and dependencies. Does not include task-specific instructions or session-level constraints.
_Avoid_: Per-task role config

**Task-Specific Instructions**:
The per-session behavior and constraints that the TL communicates to a Member during the team session (via Shared Context or message channel). These are not part of the Member Role Definition. The TL is responsible for providing context-specific guidance on what to do, what patterns to follow, what constraints apply, etc.
_Avoid_: Baking session tasks into YAML definition

**Process Management Tools**:
A set of nine tools registered only during an active Team Session: `start_member`, `stop_member`, `list_members`, `get_member_log`, `wait_and_get_member_status`, `team_send_and_wait`, `add_dynamic_member` (dynamic mode only), `set_goal`, and `finish_goal`. These tools manage the lifecycle of Member `pi --mode rpc` processes, enable TL-to-Member communication, and provide a goal-tracking system to keep the TL on task. Not available outside a Team Session.

**Real-time Message Channel**:
The communication medium through which agents (Team Lead and Members) exchange information during a Team Session. Implementation is separate from the team orchestration logic.

**Shared Context**:
A Markdown document (`.shared-context.md`) maintained by the TL during a team session. Contains project background, goals, team member overview, terminology glossary, collaboration rules, and current progress. Created by the TL before spawning Members, and updated as needed. Members receive the Shared Context via the message channel on their first task assignment, and are notified of updates thereafter.
_Avoid_: Mission brief, team doc, session context

**Session Isolation**:
Each team session gets a unique `sessionId` (timestamp + random suffix). Session data is isolated under `sessions/<team-name>/<sessionId>/` to prevent conflicts when the same pre-defined team is used across multiple sessions. Dynamic mode sessions use timestamp-based team names (`_dynamic_<ts>`) for the same purpose. All session directories are cleaned up on `/team stop`.

**Dynamic Team Mode** (`/team dynamic`):
A free-form session mode where the Team Definition is built at runtime rather than loaded from YAML. The TL enters a session with 0 members, discusses requirements with the user, and uses `add_dynamic_member` to register each role. Session data lives in `sessions/_dynamic_<ts>/` and is cleaned up on `/team stop`. The session guard blocks code file writes from the moment of entry. During the design phase, the TL follows the **Orchestration Playbook** (below).
_Avoid_: Ad-hoc team, on-the-fly team, temporary team

**Orchestration Playbook**:
A methodology document (`src/prompts/orchestration-playbook.md`) injected into the Dynamic Team Mode design-phase TL prompt. Guides the TL through six stages: (A) requirements alignment via relentless one-at-a-time questioning (grilling), (B) task decomposition by deliverables with dependency graphs — large workloads split into multi-round batches, (C) workflow orchestration with quality reinforcement patterns for high-risk stages (parallel redundancy + cross-validation, adversarial debate, develop-review loop, spike-first, human checkpoints), (D) team design derived from the workflow, (E) a plan confirmation gate — the TL must not register or start members before the user explicitly approves the full plan, (F) landing via `add_dynamic_member`, Shared Context, and `start_member`.
_Avoid_: Workflow guide, design checklist

**Goal**:
A session-scoped objective set by the TL at the start of a task using the `set_goal` tool. Consists of a summary text and verifiable completion criteria. When the TL finishes a turn (`agent_end`) with an active, incomplete goal, the system automatically sends a user message reminding the TL to continue working rather than asking the user for permission. The TL calls `finish_goal` when the goal is met or an unresolvable blocker prevents completion.
_Avoid_: Task objective, milestone, checkpoint

**Member Inspector** (成员检视浮窗):
A full-keyboard overlay summoned by the user with `alt+t` during an active Team Session. Displays a horizontal tab per Member (including crashed/stopped ones, marked with status icons), the selected Member's conversation content (user/assistant messages rendered in full, tool calls collapsed to one-line summaries with an `e` key toggle, thinking hidden), and a footer with each Member's operational state, context usage %, and key hints. The user can send messages directly to a Member via an input box (`i`/`Enter` to open; Enter sends `prompt` when idle or `follow_up` when busy, `Ctrl+Enter` sends `steer`), and run control commands (`ctrl+a` abort, `ctrl+m` compact). Direct user messages are prefixed with `[用户直接指令（非 TL）]:` so the Member can distinguish the source, and a notification is injected into the TL session so the TL stays aware of all user interventions. Content refresh is event-driven: Member RPC events mark the tab dirty and trigger a throttled `get_messages` refetch. Not available outside a Team Session.
_Avoid_: 监控面板, 第二终端

**Team Session Lifecycle**:
1. User runs `/team start <name>` or `/team dynamic`
2. TL clarifies requirements with the user (possibly multiple rounds)
3. TL breaks down tasks, creates a plan, and writes the Shared Context
4. TL sets a **Goal** via `set_goal` to define the session's objective
5. TL uses `start_member` to launch Member RPC processes (each receives role info via env vars)
6. TL sends Shared Context to Members along with initial task assignments
7. TL and Members communicate via the message channel; TL monitors progress
8. If TL finishes a turn with an incomplete goal, the system auto-reminds the TL to continue
9. TL calls `finish_goal` when all criteria are met
10. TL reports completion to user when all tasks are done
11. User decides when to run `/team stop` to terminate all Member processes


## Example Dialogue

**Dev**: "I want to build a team that helps me refactor a large codebase."
**TL**: "Sure — I can create a Team Session for codebase refactoring. Let me clarify: is this a structural refactor (changing module boundaries) or a stylistic one (linting, formatting)?"
**Dev**: "Structural. I need to extract the auth module into its own package."
**TL**: "Got it. I'll assemble the team: an Analyzer Member to map dependencies, a Mover Member to do the extraction, and a Verifier Member to fix imports and run tests. I'll coordinate them and report progress."
