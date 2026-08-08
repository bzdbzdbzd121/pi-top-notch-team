# Agent-initiated team sessions via a load-time `start_team_session` tool

The agent (as TL) can start a Dynamic Team Mode session itself by calling `start_team_session(task)` — registered at extension load time, making it the single deliberate exception to the session-scoped tool registration invariant (AGENTS.md decision #21). The session runs fully autonomously: no requirements grilling, no plan confirmation gate; the agent designs, launches, coordinates, reports, and tears the session down via `stop_team_session` (offered only in agent-initiated sessions).

## Status

Accepted

## Context

Team sessions previously required the user to type `/team start` or `/team dynamic`. We wanted the agent to be able to judge mid-conversation that a task warrants a team and delegate to Members without user friction.

Two facts shaped the design:

1. **Session origin determines guard philosophy.** In a user-initiated session the user's expectation is "do this *as a team*", so dispatch-policing guards (TL read guard, design-phase read soft limit, first-action protocol) enforce the team workflow. In an agent-initiated session the team is the agent's own chosen means — the user only cares that the result is good, so those guards are removed. Write guards (TL may not edit code) stay in both cases: TL and Member processes share one filesystem, and concurrent writes physically overwrite each other — a coordination hazard trust cannot fix. The escape hatch always exists: don't start a session, or `stop_team_session` and edit directly.
2. **Decision #21's invariant** ("outside a session, zero team tools in registry and active set") exists to prevent tool leakage. A load-time tool is a visible, permanent exception and must be the only one.

## Considered Options

- **Plan confirmation gate before launching members** (mirroring the Orchestration Playbook stage E) — rejected: it reintroduces the user-in-the-loop friction the feature exists to remove. User oversight is preserved via the team status widget (with a persistent 🤖/👤 origin marker), Member Inspector (`alt+t`), Esc, and `/team stop`.
- **Auto-teardown on `finish_goal`** — rejected: implicit lifecycle is surprising, and explicit teardown lets the agent keep a warm team when it anticipates follow-up delegation.
- **Supporting pre-defined YAML teams in `start_team_session`** — deferred: dynamic-only keeps the first iteration small; both handler paths share the same bootstrap so pre-defined support can be added later.
- **`pi.sendUserMessage("/team dynamic")` to simulate the user command** — rejected: fragile, pollutes the user message stream, and cannot carry the `task` into the Goal system.

## Consequences

- Session state carries `origin: "user" | "agent"`; guards, prompt selection, and session tool lists branch on it. Any future session-scoped tool must decide which origins see it.
- `task` is a required parameter: it auto-seeds the Goal system (turn-end reminders keep the agent on track through long Member waits) and anchors the autonomous design-phase prompt as the mission statement.
- Nesting is structurally impossible without new code: `index.ts` returns early when `TEAM_ROLE` is set, so Member processes never see `start_team_session`. Re-entry while a session is active returns an error.
