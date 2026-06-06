import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readTeam } from "../team/store";
import { getRootDir } from "../config";

export function registerShowCommand(pi: ExtensionAPI): void {
  pi.registerCommand("team-show", {
    description: "显示团队定义详情",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("用法：/team show <团队名称>", "warning");
        return;
      }

      const team = readTeam(name, getRootDir());
      if (!team) {
        ctx.ui.notify(`团队 "${name}" 不存在`, "warning");
        return;
      }

      let output = `团队：${team.name}\n`;
      output += `描述：${team.description}\n`;
      if (team.defaults?.model) {
        output += `默认模型：${team.defaults.model}\n`;
      }
      output += `成员（${team.members.length}）：\n`;
      for (const m of team.members) {
        output += `  - ${m.label ?? m.name}`;
        if (m.model) output += ` [${m.model}]`;
        output += `\n    提示词：${m.systemPrompt.slice(0, 60)}...\n`;
      }

      ctx.ui.notify(output, "info");
    },
  });
}
