/**
 * Workflow prompt builder for pre-defined team TL sessions.
 *
 * Background: the previous inline builder in index.ts injected the team YAML
 * workflow as a *declarative* stage list ("默认工作流（参考模式）— 尽可能遵循").
 * TLs routinely ignored it: users said "根据团队流程，进行 xxx 分析" and the TL
 * went off analyzing by itself. Root causes addressed here:
 *
 * 1. No activation rule — nothing mapped the user's "按团队流程" phrasing to
 *    "activate the workflow". Fixed by ACTIVATION_BANNER (placed near the top
 *    of the TL prompt, right after the first-action protocol) and rule 1 of
 *    the execution protocol.
 * 2. No execution protocol — the old text never said WHO runs each stage
 *    (the stage's member, via team_send_and_wait), that the TL must NEVER
 *    execute a stage itself, or how outputs flow between stages.
 * 3. Soft reference-mode language — "尽可能遵循" licensed deviation. Now
 *    reference mode still defaults to following the workflow and requires
 *    justification to the user for any deviation.
 * 4. Buried executor — the member assignment was a parenthetical at the end
 *    of the stage line; now each stage leads with "→ 执行者：`member`".
 *
 * Pure function, no side effects — unit-tested in workflow-prompt.test.ts.
 */

import type { TeamWorkflow } from "../team/definition";

/**
 * Short banner injected near the TOP of the TL prompt (right after the
 * first-action protocol) when the team defines a workflow. Its only job is
 * to make "the team has a workflow, go read it" unmissable before the model
 * gets diluted by the long prompt body.
 */
export const WORKFLOW_ACTIVATION_BANNER = `> 🚨 本团队定义了「团队工作流」（见下方）：收到任务型诉求时，先检查是否命中工作流激活条件；命中则严格按「工作流执行协议」逐 stage 派发，不得自己开工分析。\n`;

/**
 * Build the workflow section of the TL prompt for a pre-defined team.
 * Returns an empty string when the team has no workflow.
 */
export function buildWorkflowPrompt(workflow: TeamWorkflow | undefined): string {
  if (!workflow) return "";

  const wf = workflow;
  const strict = wf.strictness === "strict";

  const fmtStage = (s: TeamWorkflow["stages"][number]): string => {
    let t = `  【${s.name}】→ 执行者：\`${s.member}\`\n    ${s.description}`;
    if (s.input) t += `\n    输入：${s.input}`;
    if (s.output) t += `\n    输出：${s.output}`;
    if (s.constraints) t += `\n    约束：${s.constraints}`;
    if (s.onFailure) t += `\n    失败处理：如「${s.onFailure.condition}」→ 回退至「${s.onFailure.returnToStage}」`;
    return t;
  };

  let text = "";
  if (strict) {
    text += `\n### 团队工作流（严格模式 ⚡ — 必须遵守）\n严格按以下步骤执行：不得跳过、调序、合并 stage，更不得由你（TL）亲自执行任何 stage。\n\n`;
  } else {
    text += `\n### 团队工作流（参考模式 📋）\n默认按以下步骤顺序执行；确需偏离（跳过/调序/并行化）时，必须先向用户说明理由再执行。\n\n`;
  }

  if (wf.description) text += `**流程描述：** ${wf.description}\n\n`;

  text += `**步骤序列：**\n`;
  for (const s of wf.stages) text += fmtStage(s) + "\n\n";

  if (wf.loops && wf.loops.length > 0) {
    text += `**循环段：**\n`;
    for (const loop of wf.loops) {
      text += `  🔁 条件「${loop.condition}」→ 重复步骤：${loop.stages.join("、")}\n`;
    }
    text += "\n";
  }

  text += `**🔄 工作流执行协议（命中即必须遵守）：**
1. **激活条件** — 用户提到「团队流程 / 按流程 / 按工作流」，或任务与上方流程描述匹配时，激活本工作流。激活后的第一个动作是派发第 1 个 stage —— **禁止先自己 read/bash 分析**。
2. **逐 stage 派发** — 每个 stage 用 \`team_send_and_wait\` 派给其「执行者」，任务消息包含：stage 目标、输入（上游产出文件路径）、约束、产出要求，并要求 Member 完成后回复 TL。**你绝不亲自执行 stage 的工作**（stage 执行者为 \`tl\` 的除外）。
3. **串行等待** — 当前 stage 的 Member 回复并确认产出后，才派发下一个 stage；把上游产出（文件路径）作为下游输入传递。
4. **独立 stage 可并行** — 相互独立、无输入依赖的多个 stage（如多名分析员并行分析），放入同一个 \`team_send_and_wait\` 的 tasks 批量派发。
5. **失败与循环** — stage 失败时按 onFailure 回退至指定 stage 重新派发；loops 条件成立时重复对应 stage 组。
6. **进度可见** — 每完成一个 stage，向用户简要汇报：「stage N/M【名称】已完成，产出：…」。
`;

  if (strict) {
    text += `> ⚡ 严格模式附加规则：完成上一个 stage 前不得开始下一个；所有 stage 必须按序全部执行。\n`;
  }

  return text;
}
