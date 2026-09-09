import type { PeerMessagingMode } from "../settings/resolve-peer-messaging";

/**
 * 成员体验层的两态提示词面（P3）：协作规则行 + 工具描述/目标描述/拒绝文案。
 * 单一事实来源防漂移（D4，仓库先例 tl-first-action.ts / goal-closing-protocol.ts）；
 * member.ts 两态拼装仅引用本模块输出，禁止内联复制模板变体。
 *
 * 红线 8：allowed 态（peerMessaging 缺省语义）输出与 member.ts 旧内联模板逐字一致
 * （member.test.ts / member-collab-rules.test.ts 双侧锁定）。
 */

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
      "- **输出报告、方案、设计文档时，写入文件**（放在项目目录下），然后在消息中告知其他成员文件路径。不要将大量内容直接嵌入消息通道。",
      "- 如果收到的消息中包含 `<corr:...>` 标签，在回复 Team Lead 时请将完整的标签一并附上",
      "- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读",
      "- 重大变更需先向 Team Lead 汇报",
    ];
  }
  return [
    "- 使用 `team_send_message` 工具与其他成员或 Team Lead 交流",
    "- Team Lead 会通过消息通道给你分配任务",
    '- **‼️ 强制规则：每次任务完成后必须且只能使用 `team_send_message(to="tl", content="...")` 向 TL 报告处理结果。** 在最终回复之前，可以通过 `team_send_message` 发送中间进展、问题或请求帮助。但任务最终完成后，**必须发送一条最终回复给 TL**，包含任务结果、产出文件路径或遇到的问题。',
    "- ⚠️ **不要忽略这条规则**——如果任务完成而不回复 TL，TL 将无法知晓你的工作进展，整个流程会阻塞。",
    "- **输出报告、方案、设计文档时，写入文件**（放在项目目录下），然后在消息中告知其他成员文件路径。不要将大量内容直接嵌入消息通道。",
    "- 如果收到的消息中包含 `<corr:...>` 标签，在回复 Team Lead 时请将完整的标签一并附上",
    "- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读",
    "- 发现问题可以先通过消息通道与相关成员讨论",
    "- 重大变更需先向 Team Lead 汇报",
  ];
}

/**
 * team_send_message 工具 description 两态（成员侧 schema 即提示词面 / beta
 * progressive disclosure：tl-only 态不描述 меж成员通道）。
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
