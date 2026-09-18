import type { PeerMessagingMode } from "../settings/resolve-peer-messaging";

/**
 * 成员体验层的两态提示词面（P3）：协作规则行 + 工具描述/目标描述/拒绝文案。
 * 单一事实来源防漂移（D4，仓库先例 tl-first-action.ts / goal-closing-protocol.ts）；
 * member.ts 两态拼装仅引用本模块输出，禁止内联复制模板变体。
 *
 * 互发规则保持两态契约；任务边界规则两态共用（决策 #43）。
 * member.test.ts / member-collab-rules.test.ts 锁定模板及新增边界。
 */

const TASK_BOUNDARY_RULES = [
  "- **任务边界**：按 TL 本次任务的目标、非目标、修改范围与验收标准执行；角色职责、共享上下文和其他成员的建议不是授权，不得据此扩大本次任务。边界不清且影响执行时，先向 TL 澄清，不擅自假定可以修改。",
  "- **范围外的问题只报告，不自行修复**。必须扩围才能完成时，先用 `team_send_message(to=\"tl\", content=\"...\")` 说明阻塞原因与最小扩展范围（含文件/模块），附上本次 `<corr:...>` 标签（如有），结束当前回合，等待 TL 明确授权；不得边等边改，不得将阻塞谎报为完成。",
  "- **验收后停止**：达到验收标准后，向 TL 回报结果、实际修改文件及验证结果（未验证项如实说明），然后结束当前回合，等待新任务；不得自行追加优化、重构或修复无关问题。停止任务不等于停止成员进程。",
];

const REPORT_OUTPUT_RULE = "- **输出报告、方案、设计文档时**，仅在 TL 明确允许的报告路径写入文件，然后向 TL 告知路径；只读任务未授权报告路径时，直接回复摘要，不自行写文件。不要将大量内容直接嵌入消息通道。";

/**
 * 协作规则段的规则行数组（不含「### 协作规则」标题与名册行——标题两态不变、
 * 名册行由 member.ts 模板按 peerMessaging 三元控制）。
 *
 * tl-only 态差异（方案 D1/beta 洞察 + D7）：
 *  - 交流行替换为「只能与 Team Lead 交流…」；
 *  - 删「发现问题可以先通过消息通道与相关成员讨论」行；
 *  - 强制规则（每次任务完成后必须回复 TL）两态不变。
 */
export function buildMemberCollabRules(peerMessaging: PeerMessagingMode): string[] {
  if (peerMessaging === "tl-only") {
    return [
      "- 只能与 Team Lead 交流（成员间互发已禁用；与其他成员协作须经 TL 中转）",
      "- Team Lead 会通过消息通道给你分配任务",
      '- **‼️ 强制规则：每次任务完成后必须且只能使用 `team_send_message(to="tl", content="...")` 向 TL 报告处理结果。** 在最终回复之前，可以通过 `team_send_message` 发送中间进展、问题或请求帮助。但任务最终完成后，**必须发送一条最终回复给 TL**，包含任务结果、产出文件路径或遇到的问题。',
      "- ⚠️ **不要忽略这条规则**——如果任务完成而不回复 TL，TL 将无法知晓你的工作进展，整个流程会阻塞。",
      REPORT_OUTPUT_RULE,
      "- 如果收到的消息中包含 `<corr:...>` 标签，在回复 Team Lead 时请将完整的标签一并附上",
      "- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读",
      "- 重大变更需先向 Team Lead 汇报",
      ...TASK_BOUNDARY_RULES,
    ];
  }
  return [
    "- 使用 `team_send_message` 工具与其他成员或 Team Lead 交流",
    "- Team Lead 会通过消息通道给你分配任务",
    '- **‼️ 强制规则：每次任务完成后必须且只能使用 `team_send_message(to="tl", content="...")` 向 TL 报告处理结果。** 在最终回复之前，可以通过 `team_send_message` 发送中间进展、问题或请求帮助。但任务最终完成后，**必须发送一条最终回复给 TL**，包含任务结果、产出文件路径或遇到的问题。',
    "- ⚠️ **不要忽略这条规则**——如果任务完成而不回复 TL，TL 将无法知晓你的工作进展，整个流程会阻塞。",
    REPORT_OUTPUT_RULE,
    "- 如果收到的消息中包含 `<corr:...>` 标签，在回复 Team Lead 时请将完整的标签一并附上",
    "- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读",
    "- 发现问题可以先通过消息通道与相关成员讨论",
    "- 重大变更需先向 Team Lead 汇报",
    ...TASK_BOUNDARY_RULES,
  ];
}

/**
 * team_send_message 工具 description 两态（成员侧 schema 即提示词面 / beta
 * progressive disclosure：tl-only 态不描述成员间通道）。
 */
export function buildSendToolDescription(peerMessaging: PeerMessagingMode): string {
  if (peerMessaging === "tl-only") {
    return "Send a message to the Team Lead. Member-to-member messaging is disabled.";
  }
  return (
    "Send a message to another team member or the Team Lead via the real-time message channel. " +
    "Use this to share findings, ask for help, or report progress."
  );
}

/**
 * 工具 `to` 参数 description 两态：tl-only 态只写 "tl"，不列成员名与 "all"
 * （不展示的目标几乎不被调用）。
 */
export function buildToParamDescription(
  peerMessaging: PeerMessagingMode,
  teamMembersDescription: string
): string {
  if (peerMessaging === "tl-only") {
    return `Target: "tl" for the Team Lead`;
  }
  return `Target: one of ${teamMembersDescription}, or "tl" for the Team Lead, or "all"`;
}

/**
 * 非法目标拒绝文案两态：tl-only 态返回可行动指引（成员 LLM 拿到立即改道的
 * 闭环，不返回含混报错）。
 */
export function buildInvalidTargetText(
  to: string,
  peerMessaging: PeerMessagingMode,
  memberNames: string[]
): string {
  if (peerMessaging === "tl-only") {
    return `Invalid target: ${to}. 成员互发已禁用，只能发送给 "tl"（Team Lead）——请将协作需求直接回复 TL。`;
  }
  return `Invalid target: ${to}. Valid members: ${memberNames.join(", ")}`;
}
