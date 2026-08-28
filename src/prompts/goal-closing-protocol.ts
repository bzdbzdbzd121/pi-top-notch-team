/**
 * 共享的「强制 Goal 关闭协议」提示词片段（防漂移）。
 *
 * 三种 TL 提示词变体（预定义团队 index.ts / dynamic-mode.ts / agent-initiated-mode.ts）
 * 的收尾流程都必须包含该协议：目标完成或遇到不可解决阻塞时，下一动作必须调用
 * `finish_goal`，禁止仅口头宣称完成。与提醒正文（goal-tools.ts buildReminderText）
 * 的决策结构保持一致：完成/阻塞分支前置、仅确有未满足条件才继续调度。
 */
export const GOAL_CLOSING_PROTOCOL_PROMPT =
  `**若已设定目标（set_goal）：** 完成条件全部满足，或遇到不可解决的阻塞问题时，` +
  `你的下一个动作必须调用 \`finish_goal\` 关闭目标提醒（禁止仅口头宣称完成——` +
  `提醒系统只认真实的 finish_goal 调用，文字说明不算）。`;
