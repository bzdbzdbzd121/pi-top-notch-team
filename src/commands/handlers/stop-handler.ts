import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../../session/context";
import { getSessionState, endSession } from "../../session/state";
import { getRootDir } from "../../config";
import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * /team stop — Stop all members and end the session.
 */
export async function handleStop(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const session = getSessionState();
  if (!session.active) {
    ctx.ui.notify("当前无活跃团队会话", "info");
    return;
  }

  const teamName = session.teamDefinition?.name ?? "unknown";
  const sessionId = session.sessionId;
  const isDynamic = teamCtx.isDynamicSession;

  if (teamCtx.processManager) {
    await teamCtx.processManager.stopAll();
  }
  // Cancel any pending response waiters
  teamCtx.responseWaiter!.cancelAll();
  teamCtx.clearHandles();
  teamCtx.router!.updateMembers([]);

  const tlToolNames = teamCtx.tlToolNames;
  const currentActive = pi.getActiveTools();
  const toRemove = new Set([...tlToolNames, "add_dynamic_member", "create_team_definition", "update_team_definition"]);
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

  endSession();
  // Clear stale "团队成员运行中" status bar (belt-and-suspenders with agent_settled)
  ctx.ui.setStatus("team-members-running", undefined);
  ctx.ui.notify(`团队 "${teamName}" 会话已结束`, "info");
}
