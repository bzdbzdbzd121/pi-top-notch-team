import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../../session/context";
import { getSessionState, startSession, addMemberToSession } from "../../session/state";
import { getRootDir } from "../../config";
import type { TeamDefinition, TeamMember } from "../../team/definition";
import { ensureToolRegistered } from "../shared/ensure-tool";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * /team dynamic — Enter dynamic team mode (TL designs team on the fly).
 */
export async function handleDynamic(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const session = getSessionState();
  if (session.active) {
    ctx.ui.notify("当前已有活跃会话。请先 /team stop 结束当前会话。", "warning");
    return;
  }

  const ts = Date.now();
  const teamName = `_dynamic_${ts}`;
  const rootDir = getRootDir();
  const dynamicDir = join(rootDir, "sessions", teamName);
  mkdirSync(dynamicDir, { recursive: true });

  const emptyTeam: TeamDefinition = {
    name: teamName,
    description: "动态团队",
    members: [],
  };

  startSession(emptyTeam);
  teamCtx.isDynamicSession = true;
  teamCtx.dynamicPhase = "design";

  // Register add_dynamic_member tool dynamically (only during dynamic mode)
  ensureToolRegistered(pi, "add_dynamic_member", () => {
    pi.registerTool({
      name: "add_dynamic_member",
      label: "Add Dynamic Member",
      description:
        "Add a member to the dynamic team session. Only available in /team dynamic mode. " +
        "Each call adds one member to the in-memory team definition so start_member can launch it later. " +
        "Parameters: name (identifier), label (Chinese display name), systemPrompt (role definition), model (optional).",
      promptGuidelines: [
        "Use add_dynamic_member to register a team member after discussing the role with the user.",
        "Call once per member role. After all members are added, write .shared-context.md, then start members with start_member.",
      ],
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Member identifier (lowercase, e.g. 'coder', 'reviewer')" },
          label: { type: "string", description: "Human-readable display name in Chinese (e.g. '编码员')" },
          systemPrompt: { type: "string", description: "System prompt defining this member's role, skills, and behavior" },
          model: { type: "string", description: "Optional model override (e.g. 'anthropic/claude-sonnet-4')" },
        },
        required: ["name", "label", "systemPrompt"],
      },
      async execute(
        _toolCallId: string,
        params: { name: string; label: string; systemPrompt: string; model?: string }
      ) {
        const member: TeamMember = {
          name: params.name,
          label: params.label,
          systemPrompt: params.systemPrompt,
          model: params.model,
        };

        try {
          addMemberToSession(member);
          const session = getSessionState();
          if (session.teamDefinition) {
            teamCtx.router!.updateMembers(session.teamDefinition.members.map((m) => m.name));
          }
          return {
            details: {},
            content: [{ type: "text" as const, text: `成员「${params.label}（${params.name}）」已添加到动态团队。使用 start_member ${params.name} 启动。` }],
          };
        } catch (err) {
          return {
            details: {},
            content: [{ type: "text" as const, text: `添加成员失败：${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      },
    });
  });

  // Activate TL tools (including add_dynamic_member for dynamic mode)
  const tlToolNames = teamCtx.tlToolNames;
  const currentActive = pi.getActiveTools();
  const newActive = [...new Set([...currentActive, ...tlToolNames, "add_dynamic_member"])]
    .filter((t) => t !== "create_team_definition" && t !== "update_team_definition");
  pi.setActiveTools(newActive);

  // Install team status widget (design phase — 0 members)
  teamCtx.onSessionStart?.(ctx.ui as unknown as SessionUI);

  ctx.ui.notify(
    `动态团队模式已启动。请告诉 TL 你的任务需求，TL 将与你讨论需求、设计团队并协作完成任务。`,
    "info"
  );
}
