import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../../session/context";
import { startSession, getSessionState } from "../../session/state";
import { ensureSharedContextFile } from "../../session/shared-context";
import { setManifestRuntimeContext, syncActiveManifest } from "../../session/manifest";
import { readTeam } from "../../team/store";
import { getRootDir } from "../../config";

/**
 * /team start <name> — Start a team session with a pre-defined team.
 */
export async function handleStart(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ctx: ExtensionCommandContext,
  subargs: string,
): Promise<void> {
  const name = subargs.trim();
  if (!name) {
    ctx.ui.notify("用法：/team start <团队名称>", "warning");
    return;
  }

  const team = readTeam(name, getRootDir());
  if (!team) {
    ctx.ui.notify(`团队 "${name}" 不存在`, "warning");
    return;
  }

  // Clean up any stale edit-mode or create-mode widget
  teamCtx.onEditEnd?.();
  teamCtx.onCreateEnd?.();

  startSession(team);
  // Persist the session manifest immediately (the /team resume anchor).
  setManifestRuntimeContext({ isDynamic: false, dynamicPhase: "design", agentInitiatedTask: null });
  syncActiveManifest({ status: "active" });
  // Create the shared context stub up front so the file always exists for
  // members. NOTE: the real content must be written via the
  // write_shared_context tool — start_member is gated on it — so this stub
  // is only a defensive fallback (e.g. file deleted mid-session).
  ensureSharedContextFile(team, getSessionState().sessionId);
  // Install team status widget immediately
  teamCtx.onSessionStart?.(ctx.ui as unknown as SessionUI);
  teamCtx.router!.updateMembers(team.members.map((m) => m.name));

  const tlToolNames = teamCtx.tlToolNames;
  const currentActive = pi.getActiveTools();
  const newActive = [...new Set([...currentActive, ...tlToolNames])]
    .filter((t) => t !== "create_team_definition" && t !== "update_team_definition");
  pi.setActiveTools(newActive);

  ctx.ui.notify(
    `团队 "${name}" 已就绪。${team.members.length} 个成员待启动。\n` +
      `TL 已获得进程管理工具（${tlToolNames.join(", ")}）。\n` +
      `请告诉 TL 你的任务需求，TL 会引导你完成。`,
    "info"
  );
}

