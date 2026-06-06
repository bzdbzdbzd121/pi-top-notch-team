import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../session/context";
import { startSession as startSessionState } from "../session/state";
import { readTeam } from "../team/store";
import { getRootDir } from "../config";

/**
 * Register the /team start command.
 * Activates TL tools, updates the message channel router with team members.
 */
export function registerStartCommand(pi: ExtensionAPI, teamCtx: TeamContext): void {
  pi.registerCommand("team-start", {
    description: "启动团队会话",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("用法：/team start <团队名称>", "warning");
        return;
      }

      const team = readTeam(name, getRootDir());
      if (!team) {
        ctx.ui.notify(`团队 "${name}" 不存在`, "warning");
        return;
      }

      startSessionState(team);

      // Update message channel router with team members
      teamCtx.router.updateMembers(team.members.map((m) => m.name));

      // Activate TL tools
      const tlToolNames = teamCtx.tlToolNames;
      const currentActive = pi.getActiveTools();
      const newActive = [...new Set([...currentActive, ...tlToolNames])];
      pi.setActiveTools(newActive);

      ctx.ui.notify(
        `团队 "${name}" 已就绪。${team.members.length} 个成员待启动。\n` +
          `TL 已获得进程管理工具（${tlToolNames.join(", ")}）。\n` +
          `请告诉 TL 你的任务需求，TL 会引导你完成。`,
        "info"
      );
    },
  });
}
