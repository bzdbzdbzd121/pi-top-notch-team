import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRootDir } from "../../config";
import {
  deleteMemberSessionArchives,
  formatArchiveCleanupResult,
  formatArchiveScanPreview,
  formatBytes,
  scanMemberSessionArchives,
  type ArchiveCleanupResult,
  type ArchiveScan,
} from "../../process/member-session";

/**
 * 阶段 3（方案 §3.3.3）：`/team clean [团队名]` —— 归档清理的唯一入口。
 *
 * 三段式：先算（只读扫描）→ 再问（预览 + 确认）→ 最后改（逐条删除 + 汇总）。
 * 只删 `.member-resets` 下的归档目录；团队定义、会话历史、共享上下文、
 * 成员会话目录一律不碰。没有归档时不弹确认框。会话进行中同样可用（不依赖会话状态）。
 */

export interface CleanHandlerDeps {
  /** 数据根目录（默认 getRootDir()；测试注入）。 */
  rootDir?: string;
  /** 扫描实现（默认 member-session 的只读实现；测试注入）。 */
  scan?: (rootDir: string, opts?: { teamName?: string }) => ArchiveScan;
  /** 删除实现（默认 member-session 的实现；测试注入以构造失败场景）。 */
  remove?: (scan: ArchiveScan) => ArchiveCleanupResult;
}

export async function handleClean(
  ctx: ExtensionCommandContext,
  subargs: string,
  deps: CleanHandlerDeps = {}
): Promise<void> {
  const teamName = subargs.trim() || undefined;
  const rootDir = deps.rootDir ?? getRootDir();
  const scanArchives = deps.scan ?? scanMemberSessionArchives;

  // 指定团队时先确认它存在（团队定义文件或会话目录任一存在即可）——否则「没有归档」
  // 与「团队名打错了」会被混为一谈（验收 7）。定义存在性只看文件，不解析 YAML
  // （损坏的定义也应该能清归档）。
  if (teamName) {
    const hasDefinition = existsSync(join(rootDir, "teams", `${teamName}.yaml`));
    const hasSessionDir = existsSync(join(rootDir, "sessions", teamName));
    if (!hasDefinition && !hasSessionDir) {
      ctx.ui.notify(`团队 "${teamName}" 不存在。`, "warning");
      return;
    }
  }

  const scan = scanArchives(rootDir, teamName ? { teamName } : undefined);

  if (scan.entries.length === 0) {
    // 无归档 → 单条提示，不弹确认框（验收 3）。但扫描阶段跳过/非标准条目必须报告，
    // 且**不得说成「没有可清理的归档」**——否则用户会以为归档不存在（v3 验收 10）。
    const scope = teamName ? `（团队 "${teamName}"）` : "";
    const hasSkipped = scan.skipped.length > 0;
    const lines = hasSkipped
      ? [
          `未发现可自动清理的成员重启归档${scope}；发现 ${scan.skipped.length} 个不合规或非标准条目（未删除）：`,
        ]
      : [`没有可清理的成员重启归档${scope}。`];
    if (hasSkipped) {
      for (const item of scan.skipped) lines.push(`- ${item.path}（${item.reason}）`);
    }
    ctx.ui.notify(lines.join("\n"), hasSkipped ? "warning" : "info");
    return;
  }

  // 预览（只读）→ 确认 → 删除。预览里明确写清范围与「不影响什么」。
  ctx.ui.notify(formatArchiveScanPreview(scan), "info");
  const confirmed = await ctx.ui.confirm(
    "确认清理成员重启归档",
    `将删除 ${scan.entries.length} 个归档目录（合计 ${formatBytes(scan.totalBytes)}），删除后不可恢复。`
  );
  if (!confirmed) {
    ctx.ui.notify("已取消清理", "info");
    return;
  }

  const removeArchives = deps.remove ?? deleteMemberSessionArchives;
  const result = removeArchives(scan);
  ctx.ui.notify(
    formatArchiveCleanupResult(result, scan.skipped),
    result.failed.length > 0 ? "warning" : "info"
  );
}
