import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../session/context";
import { getSessionState, endSession } from "../session/state";

/**
 * Register the /team stop command.
 * Stops all member processes, clears handles, deactivates TL tools.
 */
export function registerStopCommand(pi: ExtensionAPI, teamCtx: TeamContext): void {
  pi.registerCommand("team-stop", {
    description: "终止当前团队会话",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const session = getSessionState();

      if (!session.active) {
        ctx.ui.notify("当前无活跃团队会话", "info");
        return;
      }

      const teamName = session.teamDefinition?.name ?? "unknown";

      // Stop all member processes
      if (teamCtx.processManager) {
        await teamCtx.processManager.stopAll();
      }
      teamCtx.memberHandles.clear();
      teamCtx.router.updateMembers([]);

      // Deactivate TL tools
      const allTools = pi.getAllTools();
      const tlToolNames = teamCtx.tlToolNames;
      const currentActive = pi.getActiveTools();
      const newActive = currentActive.filter((t: string) => !tlToolNames.includes(t));
      pi.setActiveTools(newActive);

      endSession();
      ctx.ui.notify(`团队 "${teamName}" 会话已结束`, "info");
    },
  });
}
