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

# Start a team session
/team start <team-name>

# Stop when done
/team stop
```

## Commands

| Command | Description |
|---------|-------------|
| `/team create` | Create a team via natural language dialogue |
| `/team edit <name>` | Modify an existing team via natural language dialogue |
| `/team start <name>` | Start a team session |
| `/team stop` | End the current team session |
| `/team list` | List all team definitions |
| `/team show <name>` | Display team definition details |
| `/team delete <name>` | Delete a team definition |
| `/team status` | Show team session state with member statuses |
| `/team help` | Show usage help |

Tab completion for team names is supported on `/team start`, `/team show`, `/team delete`, `/team edit`.

## How It Works

```
Your pi session (TL extension)
  ├── /team command (8 subcommands)
  ├── 4 process management tools
  ├── Message channel (queue → router)
  └── Member Process Manager
        ├── Member A (pi --mode rpc)
        ├── Member B (pi --mode rpc)
        └── Member C (pi --mode rpc)
```

### Flow

1. **Define a team** — Use `/team create` to describe your team. The TL collects details and saves a YAML definition to `~/.pi/top-notch-team/teams/`.

2. **Start a session** — `/team start <name>` activates TL tools (`start_member`, `stop_member`, `list_members`, `get_member_log`) and injects team awareness into the TL's system prompt.

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

### Message Channel

```
Member A calls team_send_message({to: "mover", content: "..."})
  → RPC stdout emits tool_execution_end event
  → TL extension intercepts the event
  → Message enqueued in serial FIFO queue
  → Router dispatches:
    ├── to="mover"  → writes prompt to Member B's RPC stdin
    ├── to="tl"     → injects into TL's session via pi.sendMessage()
    ├── to="all"    → broadcasts to all Members
    └── unknown     → logged as warning
```

A text-based fallback also parses `<team-message to="..." subject="...">...</team-message>` tags in assistant output, so messages work even when the LLM writes them as text instead of calling the tool.

### TL Tools

| Tool | Description |
|------|-------------|
| `start_member(name)` | Launch a Member's pi RPC process |
| `stop_member(name)` | Gracefully terminate a Member process |
| `list_members()` | Show all member statuses |
| `get_member_log(name, lines?)` | Fetch recent member session messages via RPC |

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

64 tests across 10 files.

### Project Structure

```
pi-top-notch-team/
├── index.ts              ← TL extension (entry point)
├── member.ts             ← Member extension (team_send_message tool)
├── AGENTS.md             ← AI agent codebase guide
├── CONTEXT.md            ← Glossary & key decisions
├── DESIGN.md             ← Full design specification
├── docs/adr/             ← Architecture Decision Records
└── src/
    ├── commands/team.ts  ← Unified /team command
    ├── channel/          ← Message queue + router
    ├── process/          ← Member process lifecycle
    ├── tools/tl-tools.ts ← TL process management tools
    ├── team/             ← Definition types, store, schema
    └── session/          ← Session state + context
```

## Design Decisions

- **Members as independent `pi --mode rpc` processes** — each Member has its own session context, unlike subagent delegation which loses context after each task. See [ADR-0001](docs/adr/0001-members-as-independent-pi-rpc-processes.md).

- **TL as central message router** — no external message bus needed. Member messages are detected via RPC `tool_execution_end` events, enqueued, and routed. See [ADR-0002](docs/adr/0002-tl-as-central-message-router.md).

- **Environment variables for role injection** — `TEAM_ROLE`, `TEAM_NAME`, `TEAM_MEMBERS` etc. are set on spawn. The Member extension reads these to inject team awareness without accessing the YAML file.

## License

MIT
