import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PeerMessagingMode } from "./src/settings/resolve-peer-messaging";
import {
  buildMemberCollabRules,
  buildSendToolDescription,
  buildToParamDescription,
  buildInvalidTargetText,
} from "./src/prompts/member-collab-rules";

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

  let memberNames: string[] = [];
  if (teamMembers) {
    try {
      memberNames = JSON.parse(teamMembers);
      if (!Array.isArray(memberNames)) memberNames = [];
    } catch {
      // Fallback: compatible with old comma-separated format
      memberNames = teamMembers.split(",");
    }
  }
  // P3 成员体验层：互发策略 spawn 快照（TEAM_PEER_MESSAGING env；缺省 "allowed"）。
  // 仅严格 "tl-only" 收缩面（非法值 fail-open 视为 allowed，与设置层缺省语义同构）。
  const peerMessaging: PeerMessagingMode =
    process.env.TEAM_PEER_MESSAGING === "tl-only" ? "tl-only" : "allowed";
  const validTargets =
    peerMessaging === "tl-only" ? new Set(["tl"]) : new Set(["tl", "all", ...memberNames]);
  const memberList = memberNames.join("、");
  // 协作规则段两态（单一事实来源：src/prompts/member-collab-rules.ts，D4 防漂移）
  const rulesBlock = buildMemberCollabRules(peerMessaging).join("\n");

  // ── team_send_message tool ───────────────────────────────
  pi.registerTool({
    name: "team_send_message",
    label: "Team Send Message",
    description: buildSendToolDescription(peerMessaging),
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          // 传入原始 env 串（现状插值语义：未设置时描述中保留 "undefined" 字样，逐字不变）
          description: buildToParamDescription(peerMessaging, teamMembers as string),
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
              text: buildInvalidTargetText(to, peerMessaging, memberNames),
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
  // P3 两态：名册行仅 allowed 态注入（tl-only 删除，防凭空构造成员名，D7）；
  // 协作规则段由 member-collab-rules.ts 两态输出插值；模板骨架逐字保留
  // （红线 8：allowed 态输出与旧内联模板逐字节一致，golden 测试锁定）。
  pi.on("before_agent_start", async (event, _ctx) => {
    let extraPrompt = `
## 当前角色

你是团队 **${teamName}** 的 **${roleLabel}**（${role}）。

${memberDescription ? `职责：${memberDescription}\n` : ""}
${peerMessaging === "tl-only" ? "" : memberList ? `团队其他成员：${memberList}\n` : ""}

### 协作规则
${rulesBlock}

### 沟通风格
- **简洁精炼**：剔除客套话、语气词、多余铺垫与模棱两可的表述
- **保持完整句式与语法**，专业术语、代码内容、报错信息原样不变
- **只输出核心内容**，全程保持精简风格，不添加冗余文字
`;

    if (sharedContextPath) {
      extraPrompt += `\n共享上下文文件路径：${sharedContextPath}\n`;
    }

    return {
      systemPrompt: event.systemPrompt + extraPrompt,
    };
  });
}
