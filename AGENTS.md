# pi-top-notch-team — Agent Guide

Multi-agent team collaboration extension for [pi](https://pi.dev). Enables users to define teams of specialized agent roles that work together on complex, long-running tasks.

## Quick Start

```bash
# Install locally
pi install ./pi-top-notch-team

# Create a team definition
/team create

# Start a team session
/team start <team-name>

# After the TL completes work
/team stop
```

## Architecture

```
User's pi session (TL extension)
  ├── 9 subcommands (/team create, edit, start, stop, list, show, delete, status, help)
  ├── 4 TL tools (start_member, stop_member, list_members, get_member_log)
  ├── Message channel (queue → router)
  └── Member Process Manager
        ├── Member A (pi --mode rpc, member.ts)
        ├── Member B (pi --mode rpc, member.ts)
        └── Member C (pi --mode rpc, member.ts)
```

**Key files:**

| File | Role |
|------|------|
| `index.ts` | TL extension entry point. Registers `/team` command, TL tools, message channel, `before_agent_start` injection |
| `member.ts` | Member extension entry point. Registers `team_send_message` tool, injects team awareness via env vars |
| `package.json` | pi package manifest with `pi.extensions` pointing to `["./index.ts", "./member.ts"]` |

## Source Map

```
src/
├── commands/
│   ├── team.ts       ← Single /team command (7 subcommands: create/start/stop/list/show/delete/status)
│   └── team.test.ts
├── channel/          ← Real-time message channel
│   ├── types.ts      ← TeamMessage interface
│   ├── message-queue.ts  ← Serial FIFO queue
│   └── router.ts     ← Routes to member / tl / all / self-skip
├── process/          ← Member process lifecycle
│   ├── member-process.ts  ← pi --mode rpc spawn wrapper
│   └── manager.ts    ← Multi-member lifecycle + auto-restart
├── tools/
│   └── tl-tools.ts   ← 4 TL process management tools
├── team/
│   ├── definition.ts ← TeamDefinition / TeamMember types
│   ├── schema.ts     ← YAML field validation
│   └── store.ts      ← Read/write/delete team YAML files
├── session/
│   ├── state.ts      ← TeamSessionState (active, teamDefinition, startedAt)
│   └── context.ts    ← TeamContext shared mutable state interface
├── config.ts         ← getRootDir() via env var or ~/.pi/top-notch-team
└── test/fixtures/    ← Test YAML files + mock-extension-api.ts
```

## Key Design Decisions

1. **Members as independent `pi --mode rpc` processes** — each Member has its own session context. TL communicates via stdin/stdout JSONL. See ADR-0001.

2. **TL as central message router** — Member messages detected via `tool_execution_end` RPC events, enqueued in serial FIFO queue, routed via `router.ts`. See ADR-0002.

3. **Environment variables for Member awareness** — `TEAM_ROLE`, `TEAM_NAME`, `TEAM_MEMBERS`, `TEAM_MEMBER_DESCRIPTION` are set on spawn. No YAML file reading in member.ts.

4. **Two separate extensions** — `index.ts` (TL) and `member.ts` (Member) are both declared in `pi.extensions`. Mode detection: TL checks `!isRpc || !hasTeamEnv`; Member checks `process.env.TEAM_ROLE`.

## Message Channel Flow

```
Member A calls team_send_message({to: "mover", content: "..."})
  → RPC stdout emits tool_execution_end
  → index.ts createAndRegisterMember onEvent handler
  → messageQueue.enqueue(TeamMessage)
  → router.route(msg)
    ├── to="mover"  → handle.sendCommand({type:"prompt", message:"..."}) on Member B's stdin
    ├── to="tl"     → pi.sendMessage({customType:"team-message", ...})
    ├── to="all"    → broadcast to all (skip self)
    └── unknown     → console.warn
```

Backup: assistant text outputs matching `<team-message to="..." subject="...">...</team-message>` are also parsed and enqueued.

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

64 tests across 10 files. Tests live alongside source as `*.test.ts`.

| Test Level | What | How |
|-----------|------|-----|
| Unit | schema, store, message-queue, router, config | Pure functions, no mocking |
| Integration | commands, tl-tools, member-process, manager | Mock ExtensionAPI / child_process |
| E2E | Manual via `pi --mode json -e ./index.ts` | Real pi binary |

## Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `TOP_NOTCH_TEAM_ROOT` | Tests / config | Override data directory (~/.pi/top-notch-team) |
| `TEAM_ROLE` | Member process | Member identifier |
| `TEAM_ROLE_LABEL` | Member process | Human-readable role name |
| `TEAM_NAME` | Member process | Team name |
| `TEAM_MEMBERS` | Member process | Comma-separated member list |
| `TEAM_MEMBER_DESCRIPTION` | Member process | System prompt for role |
| `TEAM_SESSION_DIR` | Member process | Session file storage path |
| `TEAM_SHARED_CONTEXT_PATH` | Member process | Shared context file path |

## Commands Reference

| Command | Description |
|---------|-------------|
| `/team create` | Natural language team creation via TL dialogue |
| `/team edit <name>` | Natural language team modification via TL dialogue |
| `/team start <name>` | Start team session, activate TL tools |
| `/team stop` | Stop all members, deactivate TL tools |
| `/team list` | List all team definitions |
| `/team show <name>` | Display team definition details |
| `/team cancel           | Cancel current create or edit operation |
| `/team delete <name>` | Delete a team definition (with confirmation) |
| `/team status` | Show active session + member process statuses |
| `/team help` | Display usage help for all subcommands |

## TL Tools (active only during team session)

| Tool | Description |
|------|-------------|
| `start_member(name)` | Launch a Member's pi RPC process |
| `stop_member(name)` | Gracefully terminate a Member process |
| `list_members()` | Show all member statuses |
| `get_member_log(name, lines?)` | Query Member's recent session via RPC |

## ADRs

- `docs/adr/0001-members-as-independent-pi-rpc-processes.md` — Core architecture
- `docs/adr/0002-tl-as-central-message-router.md` — Message channel design

## Design Document

See [DESIGN.md](./DESIGN.md) for the full design specification (16 sections).
