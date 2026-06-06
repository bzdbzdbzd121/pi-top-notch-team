import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSessionState } from "../session/state";

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("team-status", {
    description: "查看当前团队会话状态",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const session = getSessionState();

      if (!session.active || !session.teamDefinition) {
        ctx.ui.notify("当前无活跃团队会话", "info");
        return;
      }

      const team = session.teamDefinition;
      const elapsed = Math.floor((Date.now() - (session.startedAt ?? Date.now())) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;

      let output = `活跃团队：${team.name}\n`;
      output += `描述：${team.description}\n`;
      output += `已运行：${minutes}分${seconds}秒\n`;
      output += `成员（${team.members.length}）：\n`;
      for (const m of team.members) {
        output += `  - ${m.label ?? m.name}\n`;
      }

      ctx.ui.notify(output, "info");
    },
  });
}
