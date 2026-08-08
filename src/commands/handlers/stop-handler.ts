import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../../session/context";
import { getSessionState } from "../../session/state";
import { teardownTeamSession } from "../../session/teardown";

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

  // Shared teardown with the stop_team_session tool (ADR-0003): stop members,
  // deactivate tools, remove widgets, clean up session dir, end session.
  const { teamName } = await teardownTeamSession(pi, teamCtx);

  // Clear stale "团队成员运行中" status bar (belt-and-suspenders with agent_settled)
  ctx.ui.setStatus("team-members-running", undefined);
  ctx.ui.notify(`团队 "${teamName}" 会话已结束`, "info");
}
