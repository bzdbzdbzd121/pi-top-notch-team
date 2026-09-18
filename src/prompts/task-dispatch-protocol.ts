/**
 * Shared TL dispatch contract: prompt guidance only, not schema/runtime validation.
 * Used by all TL modes and team_send_and_wait so follow-up tasks cannot drift.
 * Each guideline names its tool because pi appends these bullets without a prefix.
 */
export const TASK_DISPATCH_GUIDELINES: readonly string[] = [
  "team_send_and_wait 派发协议：每个 tasks[].content 都必须明确四项（首次派发、补派、返工同样适用）：目标（本次具体交付物）、非目标（本次明确不做的事）、修改范围（允许修改的文件/模块，或只读、不修改）、验收标准（可验证的完成条件与回报内容）。简单任务可压缩成几句话；非目标必须针对本次任务，不堆砌通用禁令。",
  "team_send_and_wait 的范围须覆盖测试及报告等产出；只读任务若需落盘报告，明确唯一允许的报告路径，其余不修改。尚不清楚实现范围时，先派只读侦察，不凭空指定文件、不授予无限修改权限。",
  "team_send_and_wait 应要求成员：范围外的问题只报告，不自行修复；必须扩围才能完成时，说明原因与最小扩展范围，向 TL 申请后结束当前回合等待授权，不边等边改；验收后停止本次任务并回复结果、实际修改文件及验证结果，不追加优化。TL 收到扩围申请后，先核对用户目标与约束，再明确授权或拒绝；授权时重新给出四项边界。",
  "team_send_and_wait 的 content 保持简短，四项边界摘要留在当前消息；长详情引用成员私有或独立任务文件，不写入 .shared-context.md。任务边界不能只藏在共享上下文或 nextSteps 中（nextSteps 是 TL 等待结束后的计划）。",
];

export const TASK_DISPATCH_PROTOCOL_PROMPT = `### 任务派发协议（明确目标与非目标）
${TASK_DISPATCH_GUIDELINES.map(line => `- ${line}`).join("\n")}`;
