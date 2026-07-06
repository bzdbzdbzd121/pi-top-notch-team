import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../../session/context";
import type { TeamSaveParams } from "../save-team-definition";
import { getRootDir } from "../../config";

interface ToolParameterProperty {
  type: string;
  description?: string;
  items?: ToolParameterProperty;
  properties?: Record<string, ToolParameterProperty>;
  required?: readonly string[];
  enum?: readonly string[];
  oneOf?: readonly Record<string, unknown>[];
  [key: string]: unknown;
}

interface ToolInputSchema {
  type: "object";
  description?: string;
  properties: Record<string, ToolParameterProperty | Record<string, unknown>>;
  required?: readonly string[];
}

export type DefinitionToolMode = "create" | "update";

/** Dependencies for registerTeamDefinitionTool. */
export interface RegisterDefinitionDeps {
  pi: ExtensionAPI;
  saveFn: (params: TeamSaveParams, rootDir: string, isUpdate?: boolean) => Promise<any>;
  ctx: TeamContext;
  wfSchema: Record<string, unknown>;
  mode: DefinitionToolMode;
}

const TOOL_CONFIG: Record<DefinitionToolMode, {
  name: string;
  label: string;
  description: string;
  membersRequired: string[];
  isUpdate: boolean;
}> = {
  create: {
    name: "create_team_definition",
    label: "Create Team Definition",
    description:
      "Call this tool after the user has confirmed the team details. " +
      "Saves the team YAML to ~/.pi/top-notch-team/teams/<name>.yaml and runs validation. " +
      "Path can be overridden via TOP_NOTCH_TEAM_ROOT env var.",
    membersRequired: ["name", "systemPrompt"],
    isUpdate: false,
  },
  update: {
    name: "update_team_definition",
    label: "Update Team Definition",
    description:
      "Call this tool after the user has confirmed changes to an existing team. " +
      "Overwrites the team YAML at ~/.pi/top-notch-team/teams/<name>.yaml with the new definition and runs validation. " +
      "Path can be overridden via TOP_NOTCH_TEAM_ROOT env var.\n" +
      "MERGE FEATURE: For existing (unchanged) members, you only need to pass {name: \"...\"} \u2014 " +
      "systemPrompt/label/model auto-fill from stored YAML. Omit a member to delete it. " +
      "New or modified members need full data.\n" +
      "Only name is required for updates \u2014 you can omit description, members, and defaultModel " +
      "if you only want to change the workflow (or any other subset of fields). " +
      "Unprovided fields preserve their existing values from the stored YAML.",
    membersRequired: ["name"],
    isUpdate: true,
  },
};

const SUCCESS_MESSAGES: Record<DefinitionToolMode, (params: TeamSaveParams) => string> = {
  create: (params) =>
    `团队 "${params.name}" 已创建成功！${params.members!.length} 个成员已配置。用 /team list 查看，用 /team start ${params.name} 启动。`,
  update: (params) =>
    `团队 "${params.name}" 已更新成功！${params.members ? params.members.length + ' 个成员' : '成员'}已就绪。若需继续修改，请继续描述；完成编辑后输入 /team done 退出编辑模式。`,
};

/**
 * Build the `required` field for tool parameters.
 * Create mode requires name + description + members.
 * Update mode requires only name — allows partial updates (e.g. workflow-only).
 */
function buildParametersRequired(mode: DefinitionToolMode): string[] {
  if (mode === "create") {
    return ["name", "description", "members"];
  }
  // update mode: only name is required; everything else is optional
  return ["name"];
}

/**
 * Dynamically register a team definition tool (create or update) for /team mode.
 * Unified replacement for registerCreateDefinitionTool and registerUpdateDefinitionTool.
 */
export function registerTeamDefinitionTool(deps: RegisterDefinitionDeps): void {
  const { pi, saveFn, ctx, wfSchema, mode } = deps;
  const cfg = TOOL_CONFIG[mode];

  pi.registerTool({
    name: cfg.name,
    label: cfg.label,
    description: cfg.description,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Team name (identifier)" },
        description: { type: "string", description: "Team description" },
        defaultModel: { type: "string", description: "Optional default model for all members" },
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
            required: cfg.membersRequired,
          },
          description: "Team members",
        },
        workflow: wfSchema,
      },
      required: buildParametersRequired(mode),
    },
    async execute(
      _toolCallId: string,
      params: TeamSaveParams,
    ) {
      const result = await saveFn(params, getRootDir(), cfg.isUpdate);
      if (result) return result;

      // Note: create mode does NOT auto-exit. User must run /team done manually.
      // This allows creating multiple teams or adjustments in one session.

      return {
        details: {},
        content: [{
          type: "text" as const,
          text: SUCCESS_MESSAGES[mode](params),
        }],
      };
    },
  });
}
