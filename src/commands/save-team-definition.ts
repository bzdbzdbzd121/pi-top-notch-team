import type { TeamWorkflow, TeamDefinition, TeamMember } from "../team/definition";
import { readTeam, writeTeam } from "../team/store";
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

  writeTeam(teamData as TeamDefinition, rootDir);
  return null;
}
