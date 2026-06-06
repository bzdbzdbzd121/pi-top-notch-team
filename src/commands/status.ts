import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSessionState } from "../session/state";

export type StatusProvider = () => Array<{ name: string; status: string; pid: number | null }>;

export function registerStatusCommand(
  pi: ExtensionAPI,
  getMemberStatuses?: StatusProvider
): void {
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

      const statuses = getMemberStatuses?.() ?? [];
      const statusMap = new Map(statuses.map((s) => [s.name, s]));

      for (const m of team.members) {
        const actual = statusMap.get(m.name);
        if (actual) {
          const statusIcon =
            actual.status === "running" ? "🟢" :
            actual.status === "error" ? "🔴" : "⚪";
          output += `  ${statusIcon} ${m.label ?? m.name}: ${actual.status}`;
          if (actual.pid) output += ` (PID: ${actual.pid})`;
          output += `\n`;
        } else {
          output += `  ⚪ ${m.label ?? m.name}: 未启动\n`;
        }
      }

      ctx.ui.notify(output, "info");
    },
  });
}
