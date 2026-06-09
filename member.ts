import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const role = process.env.TEAM_ROLE;
  const teamName = process.env.TEAM_NAME;
  const teamMembers = process.env.TEAM_MEMBERS;
  const roleLabel = process.env.TEAM_ROLE_LABEL ?? role;
  const memberDescription = process.env.TEAM_MEMBER_DESCRIPTION ?? "";
  const sharedContextPath = process.env.TEAM_SHARED_CONTEXT_PATH;

  // Only activate if this process was launched as a Member
  if (!role || !teamName) {
    return;
  }

  const memberNames = teamMembers ? teamMembers.split(",") : [];
  const validTargets = new Set(["tl", "all", ...memberNames]);
  const memberList = teamMembers ? teamMembers.split(",").join("、") : "";

  // ── team_send_message tool ───────────────────────────────
  pi.registerTool({
    name: "team_send_message",
    label: "Team Send Message",
    description:
      "Send a message to another team member or the Team Lead via the real-time message channel. " +
      "Use this to share findings, ask for help, or report progress.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: `Target: one of ${teamMembers}, or "tl" for the Team Lead, or "all"`,
        },
        subject: {
          type: "string",
          description: "Optional subject line",
        },
        content: {
          type: "string",
          description: "Message content",
        },
      },
      required: ["to", "content"],
    } as any,
    async execute(
      _toolCallId: string,
      params: { to: string; subject?: string; content: string }
    ): Promise<any> {
      const from = role;
      const to = params.to;
      const subject = params.subject ?? "";
      const content = params.content;

      // Validate target
      if (!validTargets.has(to)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid target: ${to}. Valid members: ${memberNames.join(", ")}`,
            },
          ],
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `[消息已发送]
  发送者：${from}（${roleLabel}）
  接收者：${to}
  ${subject ? `主题：${subject}\n` : ""}
  内容：${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`,
          },
        ],
        details: {
          teamMessage: {
            from,
            to,
            subject,
            content,
            timestamp: Date.now(),
          },
        },
      };
    },
  });

  // ── Inject team awareness into system prompt ─────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    let extraPrompt = `
## 当前角色

你是团队 **${teamName}** 的 **${roleLabel}**（${role}）。

${memberDescription ? `职责：${memberDescription}\n` : ""}
${memberList ? `团队其他成员：${memberList}\n` : ""}

### 协作规则
- 使用 \`team_send_message\` 工具与其他成员或 Team Lead 交流
- Team Lead 会通过消息通道给你分配任务
- **任务完成后必须回复 TL**，告知处理结果
- **输出报告、方案、设计文档时，写入文件**（放在项目目录下），然后在消息中告知其他成员文件路径。不要将大量内容直接嵌入消息通道。
- 如果收到的消息中包含 \`<corr:...>\` 标签，在回复 Team Lead 时请将完整的标签一并附上
- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读
- 发现问题可以先通过消息通道与相关成员讨论
- 重大变更需先向 Team Lead 汇报
`;

    if (sharedContextPath) {
      extraPrompt += `\n共享上下文文件路径：${sharedContextPath}\n`;
    }

    return {
      systemPrompt: event.systemPrompt + extraPrompt,
    };
  });
}
