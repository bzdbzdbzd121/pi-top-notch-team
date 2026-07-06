import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listTeams } from "../../team/store";
import { getRootDir } from "../../config";

/**
 * /team list — List all team definitions.
 */
export async function handleList(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const teams = listTeams(getRootDir());
  if (teams.length === 0) {
    ctx.ui.notify("还没有创建任何团队", "info");
  } else {
    ctx.ui.notify(`已创建的团队：${teams.join(", ")}`, "info");
  }
}
