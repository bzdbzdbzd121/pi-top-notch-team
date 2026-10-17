import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TeamWorkflow, TeamDefinition, TeamMember } from "../team/definition";
import { getTeamsDir, readTeam, writeTeam } from "../team/store";
import { validateTeamDefinition } from "../team/schema";

export interface TeamSaveParams {
  name: string;
  description?: string;
  defaultModel?: string;
  members?: Array<{ name: string; label?: string; systemPrompt?: string; model?: string }>;
  workflow?: TeamWorkflow;
}

/**
 * Validate and persist a team definition.
 *
 * For updates (isUpdate=true): merges with existing team YAML on disk.
 * - Members in params with missing systemPrompt auto-fill from stored data
 * - Members omitted from params.members are deleted
 * - workflow and defaults not in params are preserved from existing
 *
 * Returns an error result if invalid, or null if saved successfully.
 */
export async function saveTeamDefinition(
  params: TeamSaveParams,
  rootDir: string,
  isUpdate = false
): Promise<any> {
  // Create 模式的「已存在」守卫（阶段 4 收尾裁决）：目标 teams/<name>.yaml 已存在
  // 时拒绝创建并引导 /team edit —— 绝不静默覆盖同名团队。云同步会把其它机器上的
  // 同名团队下载到本机，静默覆盖会直接丢掉那份定义。
  //
  // 用 existsSync 而不是 readTeam：readTeam 对「文件存在但校验失败」也返回 null，
  // 而这一类（例如刚同步下来、格式非法的团队）恰恰最需要保护。
  if (!isUpdate) {
    const targetPath = join(getTeamsDir(rootDir), `${params.name}.yaml`);
    if (existsSync(targetPath)) {
      return {
        details: {},
        content: [
          {
            type: "text" as const,
            text:
              `团队 "${params.name}" 已存在（${targetPath}），已拒绝创建以避免覆盖同名团队。\n` +
              `如需修改它，请用 /team edit ${params.name}。\n` +
              `如果它是刚云同步下来的团队，直接用 /team start ${params.name} 即可。\n` +
              `若要另建一个不同的团队，请换一个名字重新创建。`,
          },
        ],
      };
    }
  }

  // Read existing team for update merge
  let existingTeam: TeamDefinition | null = null;
  if (isUpdate) {
    existingTeam = readTeam(params.name, rootDir);
  }

  // For updates: preserve existing fields when not provided
  const description = params.description ?? existingTeam?.description ?? "";

  // Merge members: for updates, if members not provided, preserve existing
  const mergedMembers = params.members
    ? params.members.map((m) => {
        if (existingTeam && !m.systemPrompt) {
          const existing = existingTeam.members.find((em) => em.name === m.name);
          if (existing) {
            return {
              name: m.name,
              label: m.label ?? existing.label,
              systemPrompt: existing.systemPrompt,
              model: m.model ?? existing.model,
            };
          }
        }
        return {
          name: m.name,
          label: m.label,
          systemPrompt: m.systemPrompt,
          model: m.model,
        };
      })
    : existingTeam?.members ?? [];

  const teamData: Record<string, unknown> = {
    name: params.name,
    description,
    defaults: params.defaultModel
      ? { model: params.defaultModel }
      : existingTeam?.defaults,
    members: mergedMembers,
  };

  if (params.workflow) {
    teamData.workflow = params.workflow;
  } else if (existingTeam?.workflow) {
    teamData.workflow = existingTeam.workflow;
  }

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

  writeTeam(teamData as unknown as TeamDefinition, rootDir);
  return null;
}
