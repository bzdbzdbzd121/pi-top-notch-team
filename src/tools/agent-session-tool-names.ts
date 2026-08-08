/**
 * Tool name constants for agent-initiated team sessions (ADR-0003).
 *
 * Leaf module on purpose: both `session/teardown.ts` (removal set) and
 * `tools/agent-session-tools.ts` (registration) need these names, and
 * importing them from the registration module would create an import cycle.
 */

/** Registered at extension load — the single deliberate exception to decision #21. */
export const START_TEAM_SESSION_TOOL_NAME = "start_team_session";

/**
 * Registered on-demand at session start (like the 9 session tools) but
 * ACTIVATED only in agent-initiated sessions — user-initiated sessions keep
 * their lifecycle user-owned (/team stop).
 */
export const STOP_TEAM_SESSION_TOOL_NAME = "stop_team_session";
