import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readTeam, deleteTeam, deleteTeamSessions } from "../../team/store";
import { getRootDir } from "../../config";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * /team delete <name> — Delete a team definition (with confirmation).
 */
export async function handleDelete(
  ctx: ExtensionCommandContext,
  subargs: string,
): Promise<void> {
  const deleteName = subargs.trim();
  if (!deleteName) {
    ctx.ui.notify("用法：/team delete <团队名称>", "warning");
    return;
  }

  const team = readTeam(deleteName, getRootDir());
  if (!team) {
    ctx.ui.notify(`团队 "${deleteName}" 不存在`, "warning");
    return;
  }

  const confirmed = await ctx.ui.confirm(
    "确认删除",
    `确定要删除团队 "${deleteName}" 吗？`
  );

  if (!confirmed) {
    ctx.ui.notify("已取消删除", "info");
    return;
  }

  // 1. Delete YAML file first
  deleteTeam(deleteName, getRootDir());

  // 2. Check if session data exists and prompt user
  const rootDir = getRootDir();
  const sessionDir = join(rootDir, "sessions", deleteName);
  if (existsSync(sessionDir)) {
    const deleteSessions = await ctx.ui.confirm(
      "删除会话数据",
      `团队 "${deleteName}" 的会话数据目录存在。是否同时删除会话数据？`
    );
    if (deleteSessions) {
      deleteTeamSessions(deleteName, rootDir);
      ctx.ui.notify(
        `团队 "${deleteName}" 及所有会话数据已删除`,
        "info"
      );
    } else {
      ctx.ui.notify(
        `团队 "${deleteName}" 已删除，会话数据已保留`,
        "info"
      );
    }
  } else {
    ctx.ui.notify(`团队 "${deleteName}" 已删除`, "info");
  }
}
