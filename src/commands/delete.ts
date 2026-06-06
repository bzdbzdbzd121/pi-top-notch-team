import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deleteTeam, readTeam } from "../team/store";
import { getRootDir } from "../config";

export function registerDeleteCommand(pi: ExtensionAPI): void {
  pi.registerCommand("team-delete", {
    description: "删除团队定义",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("用法：/team delete <团队名称>", "warning");
        return;
      }

      const team = readTeam(name, getRootDir());
      if (!team) {
        ctx.ui.notify(`团队 "${name}" 不存在`, "warning");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "确认删除",
        `确定要删除团队 "${name}" 吗？`
      );

      if (!confirmed) {
        ctx.ui.notify("已取消删除", "info");
        return;
      }

      deleteTeam(name, getRootDir());
      ctx.ui.notify(`团队 "${name}" 已删除`, "info");
    },
  });
}
