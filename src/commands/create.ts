import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../session/context";

/**
 * Register the /team create command and the create_team_definition tool.
 */
export function registerCreateCommand(pi: ExtensionAPI, ctx: TeamContext): void {
  // Register the tool that the TL will call after collecting info
  pi.registerTool({
    name: "create_team_definition",
    label: "Create Team Definition",
    description:
      "Call this tool after the user has confirmed the team details. " +
      "Saves the team YAML to disk and runs validation. " +
      "Parameters: name (team name), description, members (array of {name, label?, systemPrompt, model?})",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Team name (identifier)" },
        description: { type: "string", description: "Team description" },
        defaultModel: {
          type: "string",
          description: "Optional default model for all members",
        },
        members: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              systemPrompt: { type: "string" },
              model: { type: "string" },
            },
            required: ["name", "systemPrompt"],
          },
          description: "Team members",
        },
      },
      required: ["name", "description", "members"],
    } as any,
    async execute(
      _toolCallId: string,
      params: {
        name: string;
        description: string;
        defaultModel?: string;
        members: Array<{
          name: string;
          label?: string;
          systemPrompt: string;
          model?: string;
        }>;
      },
    ) {
      const { validateTeamDefinition } = await import("../team/schema");
      const { writeTeam } = await import("../team/store");
      const { getRootDir } = await import("../config");

      const teamData = {
        name: params.name,
        description: params.description,
        defaults: params.defaultModel ? { model: params.defaultModel } : undefined,
        members: params.members.map((m) => ({
          name: m.name,
          label: m.label,
          systemPrompt: m.systemPrompt,
          model: m.model,
        })),
      };

      const validation = validateTeamDefinition(teamData);
      if (!validation.valid) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `团队定义校验失败：\n${validation.errors.join("\n")}\n请修正后重试。`,
            },
          ],
        };
      }

      writeTeam(teamData as any, getRootDir());
      ctx.isCreatingTeam = false;

      return {
        details: {},
        content: [
          {
            type: "text" as const,
            text: `团队 "${params.name}" 已创建成功！${params.members.length} 个成员已配置。用 /team list 查看，用 /team start ${params.name} 启动。`,
          },
        ],
      };
    },
  });

  // Register the /team create command
  pi.registerCommand("team-create", {
    description: "通过自然语言对话创建团队",
    handler: async (_args: string, _cmdCtx: ExtensionCommandContext) => {
      ctx.isCreatingTeam = true;
      _cmdCtx.ui.notify(
        "团队创建模式已启动。请告诉我你想创建的团队信息，TL 会引导你完成。",
        "info"
      );
    },
  });
}
