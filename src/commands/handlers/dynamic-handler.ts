import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../../session/context";
import { getSessionState } from "../../session/state";
import { bootstrapDynamicSession } from "../../setup/dynamic-session-bootstrap";

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

  // Shared bootstrap with the start_team_session tool (ADR-0003): session
  // dir, startSession(origin "user"), shared-context stub, dynamic design
  // phase, add_dynamic_member registration, widget + session-tool activation.
  bootstrapDynamicSession(pi, teamCtx, ctx.ui as unknown as SessionUI, "user");

  ctx.ui.notify(
    `动态团队模式已启动。请告诉 TL 你的任务需求，TL 将与你讨论需求、设计团队并协作完成任务。`,
    "info"
  );
}
