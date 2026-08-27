import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "./context";
import { getSessionState, endSession } from "./state";
import { resetGoal } from "../tools/goal-tools";
import { STOP_TEAM_SESSION_TOOL_NAME } from "../tools/agent-session-tool-names";
import { markManifestStopped, resetManifestRuntimeContext } from "./manifest";

/**
 * Shared team-session teardown (ADR-0003).
 *
 * Single implementation behind both `/team stop` (user-initiated sessions)
 * and the `stop_team_session` tool (agent-initiated sessions): stop all
 * member processes, cancel pending waiters, deactivate session tools,
 * remove widgets, preserve the resumable session directory, reset session/goal
 * state. UI concerns (notify / status bar) stay with the caller.
 *
 * @returns the ended team's name (for caller messaging)
 */
export async function teardownTeamSession(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
): Promise<{ teamName: string }> {
  const session = getSessionState();
  const teamName = session.teamDefinition?.name ?? "unknown";
  const sessionId = session.sessionId;
  const isDynamic = teamCtx.isDynamicSession;

  // One-shot "session ended" notice for the TL: consumed by the next
  // before_agent_start to inject a banner telling the agent the team session
  // is over and the team tools are deactivated — without triggering a new
  // conversation. Only set when a session was actually active (a bare
  // `/team stop` with nothing running must not produce a spurious banner).
  if (session.active) {
    teamCtx.sessionEndedNotice = true;
  }

  if (teamCtx.processManager) {
    await teamCtx.processManager.stopAll();
  }
  // Cancel any pending response waiters
  teamCtx.responseWaiter?.cancelAll();
  teamCtx.clearHandles();
  teamCtx.router?.updateMembers([]);

  const currentActive = pi.getActiveTools();
  const toRemove = new Set([
    ...teamCtx.tlToolNames,
    "add_dynamic_member",
    "create_team_definition",
    "update_team_definition",
    STOP_TEAM_SESSION_TOOL_NAME,
  ]);
  pi.setActiveTools(currentActive.filter((t: string) => !toRemove.has(t)));

  // Remove team status widget and edit/create-mode widgets immediately
  teamCtx.onSessionEnd?.();
  teamCtx.onEditEnd?.();
  teamCtx.onCreateEnd?.();

  // Mark the session manifest as cleanly stopped. The session directory is
  // intentionally PRESERVED (member pi session files + shared context) so the
  // session stays resumable via /team resume — disk cleanup is explicit via
  // /team delete, matching pi's own session semantics.
  if (teamName !== "unknown" && sessionId) {
    markManifestStopped(teamName, sessionId);
  }
  if (isDynamic) {
    teamCtx.isDynamicSession = false;
    teamCtx.dynamicPhase = "design";
  }
  teamCtx.agentInitiatedTask = null;
  teamCtx.resumedFrom = null;
  resetManifestRuntimeContext();

  endSession();
  resetGoal();
  return { teamName };
}
