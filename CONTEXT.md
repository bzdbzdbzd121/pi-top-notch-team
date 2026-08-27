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
A set of tools that become active only during an active Team Session. The 9 session-scoped tools — `start_member`, `stop_member`, `list_members`, `get_member_log`, `wait_and_get_member_status`, `team_send_and_wait`, `write_shared_context`, `set_goal`, `finish_goal` — are registered on demand at the first session start, plus `add_dynamic_member` (dynamic mode only). Because pi provides no unregister API, registered tools remain in the registry after teardown; outside a Team Session they are removed from `activeTools`, so they are not visible or callable. These tools manage the lifecycle of Member `pi --mode rpc` processes, enable TL-to-Member communication, gate the shared-context write, and provide a goal-tracking system to keep the TL on task.

**Real-time Message Channel**:
The communication medium through which agents (Team Lead and Members) exchange information during a Team Session. Implementation is separate from the team orchestration logic.

**Shared Context**:
A Markdown document (`.shared-context.md`) maintained by the TL during a team session. Contains project background, goals, team member overview, terminology glossary, collaboration rules, and current progress. Created by the TL before spawning Members, and updated as needed. Members receive the Shared Context via the message channel on their first task assignment, and are notified of updates thereafter.
_Avoid_: Mission brief, team doc, session context

**Session Isolation**:
Each team session gets a unique `sessionId` (timestamp + random suffix). Session data is isolated under `sessions/<team-name>/<sessionId>/` to prevent conflicts when the same pre-defined team is used across multiple sessions. Dynamic mode sessions use timestamp-based team names (`_dynamic_<ts>`) for the same purpose. Session directories are retained on `/team stop` and marked stopped in `session.json`; use `/team resume` to continue or `/team delete` for explicit disk cleanup.

**Dynamic Team Mode** (`/team dynamic`):
A free-form session mode where the Team Definition is built at runtime rather than loaded from YAML. The TL enters a session with 0 members, discusses requirements with the user, and uses `add_dynamic_member` to register each role. Session data lives in `sessions/_dynamic_<ts>/` and remains resumable after `/team stop`; use `/team delete` for explicit disk cleanup. The session guard blocks code file writes from the moment of entry. During the design phase, the TL follows the **Orchestration Playbook** (below).
_Avoid_: Ad-hoc team, on-the-fly team, temporary team

**Orchestration Playbook**:
A methodology document (`src/prompts/orchestration-playbook.md`) injected into the Dynamic Team Mode design-phase TL prompt. Guides the TL through six stages: (A) requirements alignment via relentless one-at-a-time questioning (grilling), (B) task decomposition by deliverables with dependency graphs — large workloads split into multi-round batches, (C) workflow orchestration with quality reinforcement patterns for high-risk stages (parallel redundancy + cross-validation, adversarial debate, develop-review loop, spike-first, human checkpoints), (D) team design derived from the workflow, (E) a plan confirmation gate — the TL must not register or start members before the user explicitly approves the full plan, (F) landing via `add_dynamic_member`, Shared Context, and `start_member`.
_Avoid_: Workflow guide, design checklist

**Goal**:
A session-scoped objective set by the TL at the start of a task using the `set_goal` tool. Consists of a summary text and verifiable completion criteria. When the TL run is fully settled—after any retry, compaction, or queued continuation has finished—with an active, incomplete goal, the system submits a reminder to continue rather than asking the user for permission. `agent_end` is only an intermediate boundary and does not send the reminder. The TL calls `finish_goal` when the goal is met or an unresolvable blocker prevents completion.
_Avoid_: Task objective, milestone, checkpoint

**Auto-Compaction** (自动压缩):
A dispatch-time mechanism: when a Member is idle and about to receive a new prompt via the Real-time Message Channel, the TL first checks the Member's context usage (`get_session_stats`). If usage exceeds the configured **Compaction Threshold**, the Member is compacted (`compact` RPC) before the prompt is delivered. Configured globally via `/team setting` (toggle + optional percent and/or absolute-token thresholds — either one triggers; compaction wait timeout in minutes). Success is silent; the TL is only notified when a configured compaction did not happen (compaction failure/timeout, or stats query failure — both fail open and dispatch anyway). At most one compaction per dispatch; no re-check loop afterwards. Member Inspector direct messages bypass this mechanism.
_Avoid_: auto-compact (pi's own built-in per-session feature), context cleanup

**Compacting** (压缩中):
A Member operational state (`idle` / `working` / `compacting` / `crashed` / `stopped`) entered when Auto-Compaction starts and exited when the compaction RPC responds (or times out). Counts as busy for all-idle wait logic (`wait_and_get_member_status`, `team_send_and_wait`). Shown as 🗜️ in the team status widget and Member Inspector. The compaction turn's own RPC events are shielded so they don't corrupt the state machine.
_Avoid_: compressing, summarizing

**Member Inspector** (成员检视浮窗):
A full-keyboard overlay summoned by the user with `alt+t` during an active Team Session. Displays a horizontal tab per Member (including crashed/stopped ones, marked with status icons), the selected Member's conversation content (user/assistant messages rendered in full, tool calls collapsed to one-line summaries with an `e` key toggle, thinking hidden), and a footer with each Member's operational state, context usage %, and key hints. The user can send messages directly to a Member via an input box (`i`/`Enter` to open; Enter sends `prompt` when idle or `follow_up` when busy, `Ctrl+Enter` sends `steer`), and run control commands (`ctrl+a` abort, `ctrl+o` compact). Direct user messages are prefixed with `[用户直接指令（非 TL）]:` so the Member can distinguish the source; user interventions are not mirrored into the TL session. Content refresh is event-driven: Member RPC events mark the tab dirty and trigger a throttled `get_messages` refetch. Not available outside a Team Session.
_Avoid_: 监控面板, 第二终端

**Session Origin** (会话来源):
A Team Session attribute (`origin: "user" | "agent"`) recording how the session was started. Determines guard strength (dispatch-policing guards apply only to user-initiated sessions; write guards apply to both) and tool visibility (`stop_team_session` is offered only in agent-initiated sessions). See ADR-0003.

**Agent-initiated Team Session** (自主会话):
A Dynamic Team Mode session started by the TL itself via the `start_team_session(task)` tool — registered at extension load time, the single deliberate exception to session-scoped tool registration. Fully autonomous: no requirements grilling, no plan confirmation gate; the TL designs, launches, coordinates, reports, and tears the session down via `stop_team_session`. Dispatch-policing guards (TL read guard, design-phase read soft limit, first-action protocol) do not apply — the user cares about the result, not the process; write guards (TL may not edit code) still apply because TL and Members share one filesystem. The team status widget carries a persistent 🤖 origin marker.
_Avoid_: sub-agent delegation, self-spawned team

**User-initiated Team Session** (手动会话):
A Team Session started by an explicit user command (`/team start <name>` or `/team dynamic`). The user owns the lifecycle (`/team stop`), and the full guard set applies because the user's intent is "do this as a team".
_Avoid_: manual session

**Team Session Lifecycle**:
1. User runs `/team start <name>` or `/team dynamic`
2. TL clarifies requirements with the user (possibly multiple rounds)
3. TL breaks down tasks, creates a plan, and writes the Shared Context
4. TL sets a **Goal** via `set_goal` to define the session's objective
5. TL uses `start_member` to launch Member RPC processes (each receives role info via env vars)
6. TL sends Shared Context to Members along with initial task assignments
7. TL and Members communicate via the message channel; TL monitors progress
8. After the TL run is fully settled (not merely at `agent_end`), an incomplete goal produces a reminder to continue
9. TL calls `finish_goal` when all criteria are met
10. TL reports completion to user when all tasks are done
11. User decides when to run `/team stop` to terminate all Member processes


## Example Dialogue

**Dev**: "I want to build a team that helps me refactor a large codebase."
**TL**: "Sure — I can create a Team Session for codebase refactoring. Let me clarify: is this a structural refactor (changing module boundaries) or a stylistic one (linting, formatting)?"
**Dev**: "Structural. I need to extract the auth module into its own package."
**TL**: "Got it. I'll assemble the team: an Analyzer Member to map dependencies, a Mover Member to do the extraction, and a Verifier Member to fix imports and run tests. I'll coordinate them and report progress."
