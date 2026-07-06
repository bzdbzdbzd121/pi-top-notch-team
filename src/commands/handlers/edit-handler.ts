import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../../session/context";
import { readTeam, listTeams } from "../../team/store";
import { getRootDir } from "../../config";
import { saveTeamDefinition } from "../save-team-definition";
import { ensureToolRegistered } from "../shared/ensure-tool";
import { registerTeamDefinitionTool } from "../shared/register-definition-tool";
import { join } from "node:path";

/**
 * /team edit <name> — Enter team edit mode via natural language.
 */
export async function handleEdit(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ctx: ExtensionCommandContext,
  subargs: string,
  workflowSchema: Record<string, unknown>,
): Promise<void> {
  const editName = subargs.trim();
  if (!editName) {
    ctx.ui.notify("用法：/team edit <团队名称>，然后通过自然语言描述修改内容", "warning");
    return;
  }

  const rootDir = getRootDir();
  const teamsDir = join(rootDir, "teams");
  const team = readTeam(editName, rootDir);
  if (!team) {
    const allTeams = listTeams(rootDir);
    ctx.ui.notify(
      `团队 "${editName}" 不存在。团队定义文件存于 ${teamsDir}，` +
      (allTeams.length > 0
        ? `可用团队：${allTeams.join(", ")}`
        : "暂无团队，请先用 /team create 创建"),
      "warning"
    );
    return;
  }

  teamCtx.editingTeamName = editName;

  // Clean up any create-mode widget
  teamCtx.onCreateEnd?.();

  // Install edit-mode widget
  teamCtx.onEditStart?.(ctx.ui as unknown as SessionUI);

  // Register update_team_definition tool dynamically
  ensureToolRegistered(pi, "update_team_definition", () => {
    registerTeamDefinitionTool({
      pi,
      saveFn: saveTeamDefinition,
      ctx: teamCtx,
      wfSchema: workflowSchema,
      mode: "update",
    });
  });

  const currentActive = pi.getActiveTools();
  const newActive = [...new Set([...currentActive, "update_team_definition"])];
  pi.setActiveTools(newActive);

  ctx.ui.notify(
    `正在编辑团队 "${editName}"。请告诉 TL 你想做的修改，TL 会引导你完成。`,
    "info"
  );
}
