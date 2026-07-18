# pi-top-notch-team

Multi-agent team collaboration extension for [pi](https://pi.dev). Define teams of specialized agent roles that work together on complex, long-running tasks.

When a team session starts, your current pi session becomes the **Team Lead (TL)**, which orchestrates **Member** agents — each running as an independent `pi --mode rpc` subprocess. Members keep their own context and memory, and communicate through a real-time message channel routed by the TL.

## Features

- **🤖 Multi-agent collaboration** — TL clarifies requirements, breaks down tasks, spawns Members, and monitors progress
- **🧠 Independent context** — Each Member runs its own pi session with persistent memory
- **📨 Real-time message channel** — Agents communicate via a built-in message bus (no external infrastructure needed)
- **📋 Shared Context** — TL maintains a Markdown document with project goals, glossary, progress, and collaboration rules
- **🔄 Auto-restart** — Crashed Members are automatically restarted with their session preserved
- **👥 Custom teams** — Define teams via natural language with `/team create`

## Quick Start

```bash
# Install
pi install ./pi-top-notch-team

# Or try without installing
pi -e ./index.ts

# Create a team
/team create
# → TL will guide you through creating a team definition

# Start a team session with a pre-defined team
/team start <team-name>

# Or use dynamic mode (TL designs team on the fly)
/team dynamic
# → TL interviews you about the goal (grilling), decomposes the task,
#   designs a workflow with quality reinforcement (cross-validation,
#   adversarial debate, review loops), then presents a full plan for
#   your confirmation before launching any member

# Stop when done
/team stop
```

## Commands

| Command | Description |
|---------|-------------|
| `/team create` | Create a team via natural language dialogue |
| `/team dynamic` | Dynamic team mode — TL designs team on the fly based on user requirements |
| `/team edit <name>` | Modify an existing team via natural language dialogue |
| `/team start <name>` | Start a team session with a pre-defined YAML team |
| `/team stop` | End the current team session (cleans up dynamic session directories) |
| `/team list` | List all team definitions |
| `/team show <name>` | Display team definition details |
| `/team cancel`           | Cancel current create/edit operation |
| `/team delete <name>` | Delete a team definition |
| `/team status` | Show team session state with member statuses |
| `/team help` | Show usage help |

Tab completion for team names is supported on `/team start`, `/team show`, `/team delete`, `/team edit`.

## How It Works

```
Your pi session (TL extension)
  ├── /team command (11 subcommands)
  ├── 7 process management tools (incl. add_dynamic_member)
  ├── Message channel (event-handler → queue → router → response-waiter)
  └── Member Process Manager
        ├── Member A (pi --mode rpc)
        ├── Member B (pi --mode rpc)
        └── Member C (pi --mode rpc)
```

### Flow

1. **Define a team** — Use `/team create` to describe your team. The TL collects details and saves a YAML definition to `~/.pi/top-notch-team/teams/`. Or use `/team dynamic` to skip pre-definition and let the TL design the team at runtime.

2. **Start a session** — `/team start <name>` or `/team dynamic` activates TL tools (`start_member`, `stop_member`, `list_members`, `get_member_log`, `wait_and_get_member_status`, `team_send_message`, `team_send_and_wait`, `add_dynamic_member`) and injects team awareness into the TL's system prompt.

3. **TL works with you** — The TL clarifies requirements, writes a Shared Context document, and spawns Members via `start_member`.

4. **Members work in parallel** — Each Member runs as `pi --mode rpc`, keeping its own session. Members use `team_send_message` to communicate with each other and the TL.

5. **Monitor and wrap up** — The TL tracks progress via `list_members` and `get_member_log`. When done, run `/team stop`.

### Team Definition

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
  - name: "mover"
    label: "代码迁移员"
    systemPrompt: "你负责执行代码迁移操作..."
  - name: "verifier"
    label: "验证员"
    systemPrompt: "你负责验证迁移后的代码..."

```

## Architecture

See [DESIGN.md](DESIGN.md) for the full architecture spec and [docs/adr/](docs/adr/) for decision records.

**TL** — user's pi session, registers `/team` command + process management tools.

**Members** — independent `pi --mode rpc` subprocesses, keep own context.

**Message Channel** — TL routes messages between agents via RPC event stream. No external infrastructure needed.

**Role injection** — env vars (`TEAM_ROLE`, `TEAM_NAME`, etc.) set on Member spawn.

### TL Tools

| Tool | Description |
|------|-------------|
| `start_member(name)` | Launch a Member's pi RPC process |
| `stop_member(name)` | Gracefully terminate a Member process |
| `list_members()` | Show all member statuses |
| `get_member_log(name, lines?, maxContentLength?)` | Fetch recent member session via RPC. `maxContentLength` truncates each message (default 200 chars). |
| `wait_and_get_member_status()` | 等待所有 member 空闲后查看运行状态: idle/working/crashed/stopped。如有 member 在工作则阻塞。No parameters. |
| `add_dynamic_member(name, label, systemPrompt, model?)` | Register a member in /team dynamic mode (name=identifier, label=Chinese display name) |
| `team_send_and_wait({tasks: [{to, content}], nextSteps})` | Send message(s) to one or more members and wait for ALL responses. Tasks array supports concurrent dispatch to different members for parallel execution. Returns partial results if some members fail. nextSteps 在 wait 结束后随结果返回。 |

These tools are only available while a team session is active.

## Installation

### From local path

```bash
git clone <repo-url>
pi install ./pi-top-notch-team
```

### From npm

```bash
pi install npm:pi-top-notch-team
```

### Try without installing

```bash
pi -e ./index.ts
```

## Development

```bash
cd pi-top-notch-team
npm install
npm test           # Run all tests
npm run test:watch # Watch mode
```


260+ tests. See [AGENTS.md](AGENTS.md) for full source map and DI pattern documentation.

## Design Decisions

Key decisions documented in [ADRs](docs/adr/):

- **Members as independent pi --mode rpc processes** — own context, session persistence, recoverable. [ADR-0001](docs/adr/0001-members-as-independent-pi-rpc-processes.md)
- **TL as central message router** — RPC event stream, no external bus needed. [ADR-0002](docs/adr/0002-tl-as-central-message-router.md)
- **Environment variables for role injection** — spawned Member gets role/config via env vars, not YAML file access.

## License

MIT
