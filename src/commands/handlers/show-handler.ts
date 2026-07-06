import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readTeam } from "../../team/store";
import { getRootDir } from "../../config";

/**
 * /team show <name> — Display team definition details.
 */
export async function handleShow(
  ctx: ExtensionCommandContext,
  subargs: string,
): Promise<void> {
  const showName = subargs.trim();
  if (!showName) {
    ctx.ui.notify("用法：/team show <团队名称>", "warning");
    return;
  }

  const team = readTeam(showName, getRootDir());
  if (!team) {
    ctx.ui.notify(`团队 "${showName}" 不存在`, "warning");
    return;
  }

  let output = `团队：${team.name}\n`;
  output += `描述：${team.description}\n`;
  if (team.defaults?.model) {
    output += `默认模型：${team.defaults.model}\n`;
  }
  output += `\n成员（${team.members.length}）：\n\n`;
  for (const m of team.members) {
    output += `  [${m.label ?? m.name}]`;
    if (m.model) output += ` - 模型: ${m.model}`;
    output += `\n  提示词:\n`;
    const promptLines = m.systemPrompt.trim().split("\n");
    for (const pl of promptLines) {
      output += `    ${pl}\n`;
    }
    output += `\n`;
  }

  // Workflow display
  if (team.workflow) {
    const wf = team.workflow;
    output += `工作流：\n`;
    output += `  模式：${wf.strictness === "strict" ? "严格模式 ⚡" : "参考模式 📋"}\n`;
    if (wf.description) output += `  描述：${wf.description}\n`;
    output += `  步骤（${wf.stages.length}）：\n`;
    for (const s of wf.stages) {
      output += `    - 【${s.name}】${s.description} (${s.member})\n`;
      if (s.input) output += `      输入：${s.input}\n`;
      if (s.output) output += `      输出：${s.output}\n`;
      if (s.constraints) output += `      约束：${s.constraints}\n`;
      if (s.onFailure) output += `      失败处理：如「${s.onFailure.condition}」→ 回退至「${s.onFailure.returnToStage}」\n`;
    }
    if (wf.loops && wf.loops.length > 0) {
      output += `  循环段（${wf.loops.length}）：\n`;
      for (const loop of wf.loops) {
        output += `    🔁 条件「${loop.condition}」→ 重复步骤：${loop.stages.join("、")}\n`;
      }
    }
  }

  ctx.ui.notify(output, "info");
}
