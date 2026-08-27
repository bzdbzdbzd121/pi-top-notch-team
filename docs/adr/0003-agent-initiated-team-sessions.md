# Agent-initiated team sessions via a load-time `start_team_session` tool

The agent (as TL) can start a Dynamic Team Mode session itself by calling `start_team_session(task)` — registered at extension load time, making it the single deliberate exception to the **load-time registration** rule (AGENTS.md decision #21). The session runs fully autonomously: no requirements grilling, no plan confirmation gate; the agent designs, launches, coordinates, reports, and tears the session down via `stop_team_session` (offered only in agent-initiated sessions). Session-scoped tools registered after the first session remain in pi's registry because pi has no unregister API; outside a session they are removed from `activeTools` and are not visible or callable.

## Status

Accepted

## Revision (2026-08-28)

**Write guards are lifted for agent-initiated sessions.** The original design restricted the TL to read + `.md`-only writes in **both** session origins (the pre-revision Context below claimed "Write guards … stay in both cases"). With this revision, `origin: "agent"` sessions (start_team_session) get the full normal-mode tool surface — write/edit any extension, bash, fetch_content, ctx_execute, mcp, etc. — in BOTH design and execution phases (one early-exit branch in the `tool_call` guard, firing before phase/whitelist resolution). The only origin-independent rule that remains is the `.shared-context.md` redirect to `write_shared_context` — the start_member hard gate depends on the session flag that tool sets, a mechanism contract rather than a file-type restriction. User-origin sessions (`/team start`, `/team dynamic`) keep all guards unchanged.

Rationale (three converging arguments, from the review of the change):

- **The write guard is a policy, not a hard invariant.** Member↔member processes share the same filesystem and were never restricted from concurrent writes. If concurrent-write prevention were an origin-independent structural invariant, member↔member writes would have been blocked too — they are not. The guard only ever encoded the user-session expectation "do this as a team".
- **The guard never eliminated the overwrite hazard, only narrowed it.** The `.md`-allowed path always carried the same concurrent-overwrite risk on its documents; the guard reduced the overlap window, which is a policy trade-off, not a safety guarantee.
- **The guard was already bypassable in agent sessions.** The execution-phase whitelist includes `bash`, and `cat > file` writes any file — the effective outcome was teaching the TL to write code through bash (unauditable, no edit diff semantics). Lifting write/edit converges the bypass back into the sanctioned tools, making writes *more* observable, not less.

Residual risk (low–medium): TL and members concurrently writing the same file can physically overwrite each other. Mitigations: the agent-initiated prompt's write discipline (check no member is working on the same file before editing — via `list_members`/`get_member_log` or a `team_send_and_wait` notice; notify members to re-read/re-verify after edits), git recoverability (overwrite ≠ delete), and the TL turn-suspension semantics of `team_send_and_wait` (structurally compressing the write window). The same risk already exists between members and is accepted there.

## Context

Team sessions previously required the user to type `/team start` or `/team dynamic`. We wanted the agent to be able to judge mid-conversation that a task warrants a team and delegate to Members without user friction.

Two facts shaped the design:

1. **Session origin determines guard philosophy.** In a user-initiated session the user's expectation is "do this *as a team*", so dispatch-policing guards (TL read guard, design-phase read soft limit, first-action protocol) enforce the team workflow. In an agent-initiated session the team is the agent's own chosen means — the user only cares that the result is good, so those guards are removed. Write guards are **user-origin-only** (see the Revision above): agent-initiated sessions lift them in both phases, keeping only the `.shared-context.md` write_shared_context redirect. The escape hatch always exists: don't start a session, or `stop_team_session` and edit directly.
2. **Decision #21's registration/activation invariant.** A fresh pi process starts with no session-scoped team tools in its registry. Session-scoped tools are registered on demand at the first session start; because pi has no unregister API, they remain in the registry after teardown, while the session visibility guard removes them from `activeTools` outside a session. `start_team_session` remains the sole load-time registration exception and is the only team-session entry point intentionally active outside a session.

## Considered Options

- **Plan confirmation gate before launching members** (mirroring the Orchestration Playbook stage E) — rejected: it reintroduces the user-in-the-loop friction the feature exists to remove. User oversight is preserved via the team status widget (with a persistent 🤖/👤 origin marker), Member Inspector (`alt+t`), Esc, and `/team stop`.
- **Auto-teardown on `finish_goal`** — rejected: implicit lifecycle is surprising, and explicit teardown lets the agent keep a warm team when it anticipates follow-up delegation.
- **Supporting pre-defined YAML teams in `start_team_session`** — deferred: dynamic-only keeps the first iteration small; both handler paths share the same bootstrap so pre-defined support can be added later.
- **`pi.sendUserMessage("/team dynamic")` to simulate the user command** — rejected: fragile, pollutes the user message stream, and cannot carry the `task` into the Goal system.

## Consequences

- Session state carries `origin: "user" | "agent"`; guards, prompt selection, and session tool lists branch on it. Any future session-scoped tool must decide which origins see it.
- `task` is a required parameter: it auto-seeds the Goal system (turn-end reminders keep the agent on track through long Member waits) and anchors the autonomous design-phase prompt as the mission statement.
- Nesting is structurally impossible without new code: `index.ts` returns early when `TEAM_ROLE` is set, so Member processes never see `start_team_session`. Re-entry while a session is active returns an error.
