import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../../session/context";
import { saveTeamDefinition } from "../save-team-definition";
import { ensureToolRegistered } from "../shared/ensure-tool";
import { registerTeamDefinitionTool } from "../shared/register-definition-tool";

/**
 * /team create — Enter team creation mode via natural language dialogue.
 */
export async function handleCreate(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ctx: ExtensionCommandContext,
  workflowSchema: Record<string, unknown>,
): Promise<void> {
  teamCtx.isCreatingTeam = true;

  // Install create-mode widget
  teamCtx.onCreateStart?.(ctx.ui as unknown as SessionUI);

  // Register create_team_definition tool dynamically
  ensureToolRegistered(pi, "create_team_definition", () => {
    registerTeamDefinitionTool({
      pi,
      saveFn: saveTeamDefinition,
      ctx: teamCtx,
      wfSchema: workflowSchema,
      mode: "create",
    });
  });

  const currentActive = pi.getActiveTools();
  const newActive = [...new Set([...currentActive, "create_team_definition"])];
  pi.setActiveTools(newActive);

  ctx.ui.notify(
    "团队创建模式已启动。请告诉我你想创建的团队信息，TL 会引导你完成。",
    "info"
  );
}
