# TL extension as central message router with tool_execution_end event stream

The Team Lead extension acts as the central message router for the real-time message channel. Member messages are detected via `tool_execution_end` RPC events and routed through a global serial queue to the target Member's RPC stdin.

## Status

Accepted

## Context

The message channel allows any agent (TL or Member) to send messages to any other agent in the team. We needed a mechanism that:

- Works with the independent pi --mode rpc architecture (separate processes, no shared memory)
- Does not require external infrastructure (no sockets, files, message buses)
- Can be extended to support remote execution in the future
- Handles concurrent messages without protocol corruption (JSONL framing)

Two approaches were considered for the Member→TL messaging direction:

1. **File/socket IPC**: The Member's `team_send_message` tool writes to a named pipe or Unix socket; the TL polls or listens. This adds infrastructure that must be created, monitored, and cleaned up per Member process.

2. **RPC event stream interception**: The Member's `team_send_message` tool is registered via the team extension (loaded by the Member's pi RPC process). When the tool executes, the Member's RPC process emits a `tool_execution_end` event to stdout. The TL, which reads the Member's stdout stream, detects this event by `toolName === "team_send_message"` and enqueues the message for routing.

## Decision

Use option 2: intercept `tool_execution_end` events from the Member's RPC stdout stream. Messages are processed through a single global queue (serial FIFO) to avoid JSONL write interleaving on the target Member's stdin.

## Consequences

- Zero external infrastructure: the RPC stdin/stdout serves double duty as both the command/control channel and the message channel.
- The stream abstraction naturally extends to remote execution: whether local or SSH-tunneled, the TL reads from a stream and writes to a stream.
- The global serial queue means message routing is not a throughput bottleneck, but is explicitly designed for low-concurrency scenarios (typical team: 2–5 Members, infrequent inter-agent messages).
- The TL must distinguish `team_send_message` tool results from other tool results in the event stream — this is done by tool name matching on the `tool_execution_end` event.
