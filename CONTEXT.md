# pi-top-notch-team

Multi-agent team collaboration system for pi agent. Allows users to define teams of agent roles that work together on complex, long-running tasks.

## Architecture decisions

**Member Runtime**: Each Member runs as an independent `pi --mode rpc` subprocess. The Team Lead spawns and manages these processes. Members maintain independent session context.

**TL-Member Communication**: TL communicates with each Member via the Member's RPC stdin/stdout (JSONL protocol). TL sends prompt commands to stdin; TL reads events (tool_execution_end, etc.) from stdout.

**Message Channel**: A global message queue within the TL extension that routes messages between agents. All agents (TL and Members) can use the channel. Messages are processed serially by a router, which writes to each target Member's RPC stdin. No external infrastructure (sockets, files, buses) is required.

**Message Passing Mechanism (Member → TL)**: Member agents register a custom tool (`team_send_message`) exposed via the team extension. When called, the tool returns a structured result. The TL listens for `tool_execution_end` events on the Member's RPC stdout, detects the tool name, extracts the message, and enqueues it for routing.

**Remote Support**: The stream abstraction supports remote Members. Instead of spawning `pi` locally, the TL spawns `ssh remote-host pi --mode rpc`. The event stream and RPC protocol remain unchanged.

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

**Process Management Tools**:
A set of four tools registered only during an active Team Session: `start_member`, `stop_member`, `list_members`, `get_member_log`. These tools manage the lifecycle of Member `pi --mode rpc` processes. Not available outside a Team Session.

**Real-time Message Channel**:
The communication medium through which agents (Team Lead and Members) exchange information during a Team Session. Implementation is separate from the team orchestration logic.

**Shared Context**:
A Markdown document maintained by the TL during a team session. Contains project background, goals, team member overview, terminology glossary, collaboration rules, and current progress. Created by the TL before spawning Members, and updated as needed. Members receive the Shared Context via the message channel on their first task assignment, and are notified of updates thereafter.
_Avoid_: Mission brief, team doc, session context

**Team Session Lifecycle**:
1. User runs `/team start <name>`
2. TL clarifies requirements with the user (possibly multiple rounds)
3. TL breaks down tasks, creates a plan, and writes the Shared Context
4. TL uses `start_member` to launch Member RPC processes (each receives role info via env vars)
5. TL sends Shared Context to Members along with initial task assignments
6. TL and Members communicate via the message channel; TL monitors progress
7. TL updates Shared Context as needed and notifies Members
8. TL reports completion to user when all tasks are done
9. User decides when to run `/team stop` to terminate all Member processes
10. Member session files are preserved for future resumption

## Commands

| Command | Description |
|---------|-------------|
| `/team create` | Interactive team creation via natural language dialog with TL. TL collects info, auto-derives name/label from role descriptions, writes YAML via `create_team_definition` tool. |
| `/team start <name>` | Start a team session. Activates TL's process management tools, injects TL system prompt via `before_agent_start`. |
| `/team stop` | Terminate all Member processes and end the current team session. |
| `/team list` | List all team definitions in `~/.pi/top-notch-team/teams/`. |
| `/team show <name>` | Display a formatted view of a team's YAML definition. |
| `/team delete <name>` | Delete a team definition file (with confirmation). |
| `/team status` | Show the current team session state with member process statuses (🟢running/⚪stopped/🔴error). |
| `/team help` | Display usage help for all subcommands. |

Tab completion is supported for team names on `/team start`, `/team show`, `/team delete`.

## Example Dialogue

**Dev**: "I want to build a team that helps me refactor a large codebase."
**TL**: "Sure — I can create a Team Session for codebase refactoring. Let me clarify: is this a structural refactor (changing module boundaries) or a stylistic one (linting, formatting)?"
**Dev**: "Structural. I need to extract the auth module into its own package."
**TL**: "Got it. I'll assemble the team: an Analyzer Member to map dependencies, a Mover Member to do the extraction, and a Verifier Member to fix imports and run tests. I'll coordinate them and report progress."
