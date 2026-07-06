import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../../session/context";

/**
 * /team done | /team cancel — Exit create or edit mode.
 */
export async function handleDone(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!teamCtx.isCreatingTeam && !teamCtx.editingTeamName) {
    ctx.ui.notify("当前没有正在进行的创建或编辑操作", "info");
    return;
  }
  const wasEditing = !!teamCtx.editingTeamName;
  const wasCreating = teamCtx.isCreatingTeam;
  const mode = teamCtx.isCreatingTeam ? "创建" : "编辑";
  teamCtx.isCreatingTeam = false;
  teamCtx.editingTeamName = null;
  // Deactivate team definition tools
  const curActive = pi.getActiveTools();
  pi.setActiveTools(curActive.filter((t: string) => t !== "create_team_definition" && t !== "update_team_definition"));
  // Remove widgets
  if (wasEditing) teamCtx.onEditEnd?.();
  if (wasCreating) teamCtx.onCreateEnd?.();
  ctx.ui.notify(`已退出${mode}操作`, "info");
}
