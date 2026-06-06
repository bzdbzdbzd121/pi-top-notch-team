# Members run as independent `pi --mode rpc` processes

Each Member agent in a team runs as its own `pi --mode rpc` subprocess spawned and managed by the Team Lead extension. Members maintain their own session context independent of the TL.

## Status

Accepted

## Context

We needed a runtime model for Member agents that could:

- Maintain independent conversation context and memory across multiple task assignments within a team session
- Run in parallel (multiple Members working simultaneously)
- Support future remote execution (Member on another machine)

Three options were considered:

1. **pi-subagents mechanism**: Built-in delegation to subagents. Drawback: subagent context is not retained after a task completes, so a Member cannot accumulate knowledge across multiple assignments within a team session.

2. **In-process: Extension API + child_process with custom runner**: Keep everything in one pi process, spawn lightweight Node.js child processes for Members. Drawback: reinvents what pi already provides (tool execution, session management, LLM integration).

3. **Independent pi --mode rpc processes**: Each Member is a full pi agent in RPC mode, spawned via `child_process.spawn()`. The TL communicates with each Member through the RPC JSONL protocol over stdin/stdout. Drawback: higher resource usage per Member (full model context, process overhead). Benefit: each Member is a fully capable pi agent with its own session, tools, and context.

## Decision

Use option 3: Members run as independent `pi --mode rpc` subprocesses.

## Consequences

- Each Member carries full pi overhead (conversation session, model context, tool registry), but this is acceptable for long-running team sessions where Members accumulate significant context.
- The TL must manage process lifecycle (spawn, monitor, restart on crash, terminate) via stream abstractions.
- Member session files persist at `~/.pi/top-notch-team/sessions/<team-name>/<member-name>/` and survive team session restarts.
- Remote execution is supported transparently by swapping the local `spawn("pi", ...)` for `spawn("ssh", ["remote-host", "pi", ...])` — the RPC protocol over stdin/stdout is unchanged.
