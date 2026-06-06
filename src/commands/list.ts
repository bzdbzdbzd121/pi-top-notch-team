import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listTeams } from "../team/store";
import { getRootDir } from "../config";

export function registerListCommand(pi: ExtensionAPI): void {
  pi.registerCommand("team-list", {
    description: "列出所有已创建的团队",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const teams = listTeams(getRootDir());
      if (teams.length === 0) {
        ctx.ui.notify("还没有创建任何团队", "info");
        return;
      }
      ctx.ui.notify(`已创建的团队：${teams.join(", ")}`, "info");
    },
  });
}
