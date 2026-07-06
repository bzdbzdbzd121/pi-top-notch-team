import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSessionState } from "../../session/state";
import type { StatusProvider } from "../status";

/**
 * /team status — Show active session and member process statuses.
 */
export async function handleStatus(
  ctx: ExtensionCommandContext,
  getMemberStatuses?: StatusProvider,
): Promise<void> {
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
    } else {
      output += `  ⚪ ${m.label ?? m.name}: 未启动`;
    }
    output += `\n`;
  }

  ctx.ui.notify(output, "info");
}
