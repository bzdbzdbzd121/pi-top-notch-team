import { GOAL_TOOL_NAMES } from "../tools/goal-tools";
import { SHARED_CONTEXT_TOOL_NAME } from "../tools/shared-context-tool";

/**
 * Session-only tool visibility enforcement.
 *
 * Invariant: team-session tools are visible to the TL ONLY while a team
 * session is active (`/team start` or `/team dynamic`):
 *
 *   start_member, stop_member, list_members, get_member_log,
 *   team_send_and_wait, wait_and_get_member_status,
 *   write_shared_context, set_goal, finish_goal
 *
 * Registration: all nine are registered ON-DEMAND at session start
 * (`onSessionStart`) and never at extension load — outside a session the tool
 * registry contains none of them. pi has no unregisterTool API, so after the
 * first session they stay in the registry forever; the active-tool set
 * (pi.setActiveTools) is therefore the ONLY visibility gate.
 *
 * Enforcement: this pure function is applied at every `before_agent_start`
 * turn boundary. Session active → ensure registered (idempotent) + active.
 * No session → remove from the active set (never register). A stale
 * active-tool list (extension reload, other extensions calling
 * setActiveTools, plan-mode tool toggles, future code paths) can thus never
 * leak the session tools outside a session.
 *
 * Mode-scoped tools (create_team_definition / update_team_definition /
 * add_dynamic_member) are NOT covered here — they already have their own
 * register-on-demand + deactivate-on-exit lifecycle.
 */
export const SESSION_TOOL_NAMES = [
  "start_member",
  "stop_member",
  "list_members",
  "get_member_log",
  "team_send_and_wait",
  "wait_and_get_member_status",
  SHARED_CONTEXT_TOOL_NAME,
  ...GOAL_TOOL_NAMES,
] as const;

export interface SessionToolVisibilityDeps {
  /** Whether a team session (predefined or dynamic) is currently active. */
  sessionActive: boolean;
  /** Current active tool names (pi.getActiveTools()). */
  activeTools: string[];
  /** Whether a tool name is already registered (pi.getAllTools()). */
  isRegistered(name: string): boolean;
  /**
   * Register ALL session-only tools (idempotent). Called only when at least
   * one of them is missing from the registry.
   */
  registerTools(): void;
  /** Apply a new active tool set (pi.setActiveTools()). */
  setActiveTools(names: string[]): void;
}

export interface SessionToolVisibilityResult {
  /** Whether the active tool set was modified. */
  changed: boolean;
  /** Active tool set after enforcement. */
  activeTools: string[];
}

export function enforceSessionToolVisibility(
  deps: SessionToolVisibilityDeps
): SessionToolVisibilityResult {
  const { sessionActive, activeTools } = deps;
  const active = new Set(activeTools);

  if (sessionActive) {
    // Session active → session tools must be registered (idempotent) and
    // active. Registration must happen BEFORE activation: pi.setActiveTools
    // silently ignores unregistered names.
    const missingActive = SESSION_TOOL_NAMES.filter((n) => !active.has(n));
    if (missingActive.length > 0) {
      if (SESSION_TOOL_NAMES.some((n) => !deps.isRegistered(n))) {
        deps.registerTools();
      }
      const next = [...new Set([...activeTools, ...SESSION_TOOL_NAMES])];
      deps.setActiveTools(next);
      return { changed: true, activeTools: next };
    }
    return { changed: false, activeTools };
  }

  // No session → session tools must never be active (they may remain
  // registered; pi has no unregisterTool API, but the active set is the only
  // visibility gate).
  const leakedSet = new Set(SESSION_TOOL_NAMES);
  const leaked = SESSION_TOOL_NAMES.filter((n) => active.has(n));
  if (leaked.length > 0) {
    const next = activeTools.filter((n) => !leakedSet.has(n));
    deps.setActiveTools(next);
    return { changed: true, activeTools: next };
  }
  return { changed: false, activeTools };
}
