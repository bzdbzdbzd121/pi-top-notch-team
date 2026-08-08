import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "./context";
import { getSessionState, endSession } from "./state";
import { resetGoal } from "../tools/goal-tools";
import { STOP_TEAM_SESSION_TOOL_NAME } from "../tools/agent-session-tool-names";
import { getRootDir } from "../config";
import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared team-session teardown (ADR-0003).
 *
 * Single implementation behind both `/team stop` (user-initiated sessions)
 * and the `stop_team_session` tool (agent-initiated sessions): stop all
 * member processes, cancel pending waiters, deactivate session tools,
 * remove widgets, best-effort session directory cleanup, reset session/goal
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

  // Clean up session directory
  if (isDynamic) {
    const dynamicDir = join(getRootDir(), "sessions", teamName);
    try {
      rmSync(dynamicDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
    teamCtx.isDynamicSession = false;
    teamCtx.dynamicPhase = "design";
  } else if (sessionId) {
    const sessionDir = join(getRootDir(), "sessions", teamName, sessionId);
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  teamCtx.agentInitiatedTask = null;

  endSession();
  resetGoal();
  return { teamName };
}
