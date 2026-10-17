/**
 * 阶段 2：`/team sync` 与 `/team sync status` 的编排与输出（方案 §5 阶段 2 / §7.F）。
 *
 * 三段式：「先算（只读）→ 再问（零改动）→ 最后改（一次落盘）」。
 * 阶段 2 的冲突处理是**安全中止并列出冲突团队**（决策界面在阶段 4）。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getRootDir } from "../config";
import { getTeamsDir } from "../team/store";
import type { GitResult, GitRunOptions } from "./git-runner";
import { runGit } from "./git-runner";
import {
  loadSyncConfig,
  maskRemoteUrl,
  saveSyncConfig,
  validateRemoteUrl,
  type SyncConfig,
} from "./config";
import { acquireSyncLock, isSyncLockStale, readSyncLock } from "./lock";
import { applySync, type ApplySummary } from "./apply";
import {
  buildSyncPlan,
  cleanupSyncResiduals,
  countUncommittedTeamChanges,
  describeSyncFailure,
  discoverRemoteBranch,
  ensureRemoteAndBranch,
  fetchRemote,
  formatPlanSummary,
  hasIndexLock,
  inspectRepo,
  listConflicts,
  listInvalidTeamFiles,
  listLocalDeletePaths,
  listRemoteDeletePaths,
  manualFailure,
  runLocalGit,
  type PreparedRepository,
  type SyncContext,
  type SyncFailure,
  type SyncPlan,
} from "./plan";

/** status 的短超时远端检查。 */
const STATUS_CHECK_TIMEOUT_MS = 15_000;

export interface SyncCommandDeps {
  rootDir?: string;
  runGit?: (args: string[], options: GitRunOptions) => Promise<GitResult>;
  now?: () => Date;
  /** 网络重试/检查超时覆写（测试用）。 */
  statusTimeoutMs?: number;
}

function buildContext(
  rootDir: string,
  config: SyncConfig,
  deps?: SyncCommandDeps
): SyncContext {
  return {
    rootDir,
    teamsDir: getTeamsDir(rootDir),
    config,
    runGit: deps?.runGit ?? runGit,
  };
}

/** 是否具备交互能力（JSON/print 模式不允许写操作）。 */
function isInteractive(ctx: ExtensionCommandContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

// ── 输出格式化（纯函数，便于单测；方案 §7.F 文案） ──────────

function formatClock(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatInvalidTeams(invalid: { name: string; errors: string[] }[]): string {
  return invalid
    .map((t) => `${t.name}.yaml：${t.errors[0] ?? "格式非法"}`)
    .join("；");
}

/** 异常行（真实后果：仍会落地；/team list 仍列出，/team start 报「团队不存在」）。 */
export function formatInvalidTeamsLine(invalid: { name: string; errors: string[] }[]): string | null {
  if (invalid.length === 0) return null;
  return `异常：${invalid.length} 个团队文件校验失败（${formatInvalidTeams(invalid)}；文件已同步，修复后即可用）`;
}

/** 同步结果摘要（方案 §7.F）。 */
export function formatSyncResult(summary: ApplySummary): string {
  if (summary.noop) {
    return "已是最新（云端无更新，本机无待同步改动）";
  }
  const lines: string[] = ["云同步完成"];
  if (summary.fastForward) lines.push(`更新：快进到云端提交（本地无待上传改动）`);
  lines.push(`下载：${summary.downloaded.length}${summary.downloaded.length ? `（${summary.downloaded.join("、")}）` : ""}`);
  lines.push(`上传：${summary.uploaded.length}${summary.uploaded.length ? `（${summary.uploaded.join("、")}）` : ""}`);
  const deleted = [...summary.deletedOnRemote.map((p) => `云端删 ${p}`), ...summary.deletedOnLocal.map((p) => `本机删 ${p}`)];
  lines.push(`删除：${deleted.length}${deleted.length ? `（${deleted.join("；")}）` : ""}`);
  if (summary.passthroughUpdated.length > 0) {
    lines.push(`非团队文件（云端为准）：${summary.passthroughUpdated.length}（${summary.passthroughUpdated.join("、")}）`);
  }
  if (summary.keptLocalPaths.length > 0) {
    lines.push(
      `保留本地独有已跟踪文件：${summary.keptLocalPaths.length}（${summary.keptLocalPaths.join("、")}；不上传、不删除）`
    );
  }
  if (summary.ignored.nonYamlLocalModified.length > 0) {
    lines.push(
      `非团队文件的本机改动不会被上传（本机版：${summary.ignored.nonYamlLocalModified.join("、")}）`
    );
  }
  if (summary.ignored.unsafePaths && summary.ignored.unsafePaths.length > 0) {
    lines.push(`⚠️ 已跳过危险路径（不落盘）：${summary.ignored.unsafePaths.join("、")}`);
  }
  if (summary.ignored.nestedYaml.length > 0) {
    lines.push(`已忽略子目录 yaml：${summary.ignored.nestedYaml.length}（${summary.ignored.nestedYaml.join("、")}）`);
  }
  const invalidLine = formatInvalidTeamsLine(summary.invalidTeams);
  if (invalidLine) lines.push(invalidLine);
  if (summary.commit) {
    if (summary.pushed) {
      lines.push(`提交：（本地已推送）${summary.commit.slice(0, 7)}`);
    } else if (summary.pushFailure) {
      lines.push(`提交：（本地已提交，尚未推送）${summary.commit.slice(0, 7)}`);
      lines.push(`推送失败：${describeSyncFailure(summary.pushFailure)}`);
    } else {
      lines.push(`提交：${summary.commit.slice(0, 7)}`);
    }
  }
  if (summary.indexRefreshFailure) {
    // 独立于 push 失败（审查 #8）：引用已更新、提交已生效，只是索引未对齐
    lines.push(`索引刷新失败：${describeSyncFailure(summary.indexRefreshFailure)}（提交已生效，下次运行自动收敛）`);
  }
  if (summary.backupRef) {
    lines.push(`已为换地址前的本地历史保留备份引用：${summary.backupRef}`);
  }
  if (summary.fallbackIdentity) {
    lines.push("身份：本次提交使用兜底身份 pi-top-notch-team <pi-top-notch-team@localhost>（未修改你的 git 全局配置）");
  }
  return lines.join("\n");
}

/** 失败输出（原因 + 修法 + 可选命令/stderr 诊断）。 */
export function formatSyncFailure(failure: SyncFailure, options?: { raw?: boolean }): string {
  const lines = [`云同步失败：${describeSyncFailure(failure)}`];
  if (options?.raw) {
    if (failure.command) lines.push(`失败命令：${failure.command}`);
    if (failure.stderr && failure.stderr.trim().length > 0) {
      const stderr = failure.stderr.trim().split("\n").slice(0, 5).join("\n");
      lines.push(`原始输出：\n${stderr}`);
    }
  }
  return lines.join("\n");
}

export interface SyncStatusData {
  configured: boolean;
  enabled: boolean;
  remoteUrlMasked: string;
  branch: string;
  branchSourceLabel: string;
  remote:
    | { kind: "empty" }
    | { kind: "up-to-date" }
    | { kind: "behind"; behind: number }
    | { kind: "ahead"; ahead: number }
    | { kind: "diverged"; ahead: number; behind: number }
    | { kind: "error"; failure: SyncFailure }
    | { kind: "unchecked" };
  checkedAt: string;
  local: { uncommittedTeams: number; unpushedCommits: number };
  archive: { count: number; latest?: string };
  invalidTeams: { name: string; errors: string[] }[];
  repo: { ok: boolean; note?: string };
}

/** 状态输出（方案 §7.F 定稿格式的可实现子集；归档/异常等待阶段 4 填充）。 */
export function formatSyncStatus(data: SyncStatusData): string {
  const lines: string[] = ["云同步状态"];
  const branchLabel = data.branch ? `${data.branch}（${data.branchSourceLabel}）` : "未确定";
  if (!data.configured) {
    lines.push("配置：未配置        仓库：—");
    lines.push(`分支：${branchLabel}`);
    lines.push("远端：未检查（尚未配置仓库地址）");
    lines.push("本地：—");
    lines.push("提示：运行 /team sync 按引导填写私有仓库地址（该仓库必须为私有）。");
    return lines.join("\n");
  }

  lines.push(`配置：已配置（${data.enabled ? "启用" : "未启用"}）        仓库：${data.remoteUrlMasked}（已脱敏）`);
  lines.push(`分支：${branchLabel}`);

  switch (data.remote.kind) {
    case "empty":
      lines.push("远端：空仓库（无任何提交）");
      break;
    case "up-to-date":
      lines.push(`远端：无更新（检查于 ${data.checkedAt}）`);
      break;
    case "behind":
      lines.push(`远端：落后 ${data.remote.behind} 个提交（检查于 ${data.checkedAt}）`);
      break;
    case "ahead":
      lines.push(`远端：领先 ${data.remote.ahead} 个提交（本地已提交未推送；检查于 ${data.checkedAt}）`);
      break;
    case "diverged":
      lines.push(`远端：已分叉（本地领先 ${data.remote.ahead}、落后 ${data.remote.behind}；检查于 ${data.checkedAt}）`);
      break;
    case "error":
      lines.push(`远端：无法检查：${describeSyncFailure(data.remote.failure)}`);
      break;
    case "unchecked":
      lines.push("远端：未检查（未接入仓库或未启用）");
      break;
  }

  lines.push(
    `本地：${data.local.uncommittedTeams} 个团队有未提交改动；${data.local.unpushedCommits} 个未推送提交`
  );
  if (data.archive.count > 0) {
    lines.push(`归档：${data.archive.count} 个冲突留档待清理${data.archive.latest ? `（${data.archive.latest}）` : ""}`);
  }
  const invalidLine = formatInvalidTeamsLine(data.invalidTeams);
  if (invalidLine) lines.push(invalidLine);
  lines.push(`仓库：${data.repo.ok ? "正常" : `需处理${data.repo.note ? `（${data.repo.note}）` : ""}`}`);
  return lines.join("\n");
}

// ── 首次接入引导 ─────────────────────────────────────────────

const GUIDE_TEXT = [
  "云同步尚未配置。",
  "需要你有一个**私有** git 仓库（插件不代建仓库；团队定义含 systemPrompt，公开仓库等于公开它们）。",
  "按提示填写仓库地址（支持 ssh://、git@host:path、https://（不含凭据）、file:// 或本地绝对路径）。",
].join("\n");

async function guideConfiguration(
  ctx: ExtensionCommandContext,
  rootDir: string
): Promise<SyncConfig | null> {
  const existing = loadSyncConfig(rootDir);
  if (!ctx.hasUI) {
    ctx.ui.notify(`${GUIDE_TEXT}\n当前模式不支持写操作：请在交互式终端运行 /team sync 完成配置。`, "warning");
    return null;
  }

  ctx.ui.notify(GUIDE_TEXT, "info");
  const input = await ctx.ui.input("云同步仓库地址（私有仓库，Esc 取消）");
  if (input === undefined) {
    ctx.ui.notify("已取消配置。", "info");
    return null;
  }
  const remoteUrl = input.trim();
  const error = validateRemoteUrl(remoteUrl);
  if (error) {
    ctx.ui.notify(`仓库地址不可用：${error}`, "warning");
    return null;
  }

  const config: SyncConfig = {
    enabled: true,
    remoteUrl,
    branch: existing?.branch ?? "",
  };
  try {
    saveSyncConfig(config, rootDir);
  } catch (err) {
    ctx.ui.notify(`保存云同步配置失败：${err instanceof Error ? err.message : String(err)}`, "error");
    return null;
  }
  ctx.ui.notify("云同步配置已保存。", "info");
  return config;
}

// ── /team sync ───────────────────────────────────────────────

/** 计划是否需要用户确认（删除传播 / 首次接入上传）。修改类计划零交互。 */
export function planNeedsConfirmation(plan: SyncPlan): boolean {
  const deletions = listLocalDeletePaths(plan).length + listRemoteDeletePaths(plan).length;
  if (deletions > 0) return true;
  if (plan.flags.firstAttach) {
    const uploads = plan.actions.some((a) => a.kind === "local-only" || a.kind === "local-modified");
    if (uploads) return true;
  }
  return false;
}

export async function handleSyncCommand(
  ctx: ExtensionCommandContext,
  subargs: string,
  deps?: SyncCommandDeps
): Promise<void> {
  const args = subargs.trim().toLowerCase();
  if (args === "status") {
    await handleSyncStatus(ctx, deps);
    return;
  }

  const rootDir = deps?.rootDir ?? getRootDir();
  const now = deps?.now ?? (() => new Date());

  if (!isInteractive(ctx)) {
    ctx.ui.notify(
      "云同步需要交互式界面（TUI/RPC）才能执行写操作。\n可在交互式终端运行 /team sync；只读查询可用 /team sync status。",
      "warning"
    );
    return;
  }

  // 配置 / 首次接入引导
  let config = loadSyncConfig(rootDir);
  if (!config || !config.remoteUrl) {
    config = await guideConfiguration(ctx, rootDir);
    if (!config) return;
  } else if (!config.enabled) {
    const enable = await ctx.ui.confirm("云同步", "云同步当前处于停用状态，是否启用并继续同步？");
    if (!enable) {
      ctx.ui.notify("已取消（云同步仍处于停用状态）。", "info");
      return;
    }
    config = { ...config, enabled: true };
    try {
      saveSyncConfig(config, rootDir);
    } catch (err) {
      ctx.ui.notify(`保存云同步配置失败：${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
  }

  const syncCtx = buildContext(rootDir, config, deps);

  const lock = acquireSyncLock(rootDir);
  if (!lock.ok) {
    if (lock.reason === "held") {
      const holder = lock.holder
        ? `（进程 ${lock.holder.pid}，开始于 ${lock.holder.startedAt}）`
        : "（锁文件存在但暂不可读）";
      ctx.ui.notify(
        `另一个同步实例正在运行${holder}，本次未执行。请等待其完成或确认残留后清理 <rootDir>/sync.lock。`,
        "warning"
      );
    } else {
      ctx.ui.notify(`无法获取同步锁：${lock.error}`, "error");
    }
    return;
  }

  try {
    // index.lock 预检（明确报错，不删除别人的锁）
    const repoState = await inspectRepo(syncCtx);
    cleanupSyncResiduals(syncCtx, { now: now().getTime(), gitDir: repoState.gitDir || undefined });
    if (repoState.nestedInsideOtherRepo && !repoState.hasRepo) {
      ctx.ui.notify(
        "⚠️ 检测到 teams/ 目录位于另一个 git 仓库内：同步会把 teams/ 变成嵌入式仓库，外层仓库将不再跟踪团队 YAML（团队定义改由云同步管理）。",
        "warning"
      );
    }
    if (repoState.hasRepo && repoState.gitDir && hasIndexLock(repoState.gitDir)) {
      ctx.ui.notify(
        formatSyncFailure(
          manualFailure(
            "仓库锁文件 .git/index.lock 存在：另一个 git/sync 进程可能正在运行，或上次异常退出",
            "确认没有其它 git/sync 进程在运行（不要删除正在被使用的锁）；若确认是上次异常退出的残留，可手动删除 .git/index.lock 后重试"
          )
        ),
        "warning"
      );
      return;
    }

    // 准备（可能写 .git：init / remote / HEAD 对齐 / fetch）
    const prepared = await ensureRemoteAndBranch(syncCtx, {
      onRemoteUrlChanged: async (currentUrl, configuredUrl) =>
        ctx.ui.confirm(
          "云同步",
          `本地仓库的远端地址与配置不一致：\n  当前：${maskRemoteUrl(currentUrl)}\n  配置：${maskRemoteUrl(configuredUrl)}\n是否改用配置中的地址？（换地址会先在本地留一个备份引用；不静默改写）`
        ),
    });
    if (!prepared.ok) {
      if (prepared.cancelled) {
        ctx.ui.notify(`已取消：${describeSyncFailure(prepared.failure)}`, "info");
      } else {
        ctx.ui.notify(formatSyncFailure(prepared.failure, { raw: true }), "warning");
      }
      return;
    }

    const fetched = await fetchRemote(syncCtx, prepared.prepared);
    if (!fetched.ok) {
      ctx.ui.notify(formatSyncFailure(fetched.failure, { raw: true }), "warning");
      return;
    }

    const built = await buildSyncPlan({ ctx: syncCtx, prepared: prepared.prepared, remoteSha: fetched.remoteSha });
    if (!built.ok) {
      ctx.ui.notify(formatSyncFailure(built.failure, { raw: true }), "warning");
      return;
    }
    const { plan, snapshot } = built.result;

    // 冲突 → 安全中止（决策界面在阶段 4）
    const conflicts = listConflicts(plan);
    if (conflicts.length > 0) {
      const list = conflicts
        .map((c) => `  ${c.path}（可选：${c.options.join(" / ")}）`)
        .join("\n");
      ctx.ui.notify(
        `检测到 ${conflicts.length} 个冲突团队，已安全中止（未做任何改动）：\n${list}\n冲突决策界面将在后续版本提供；当前请手工处理这些团队后重试。`,
        "warning"
      );
      return;
    }

    ctx.ui.notify(formatPlanSummary(plan), "info");

    if (planNeedsConfirmation(plan)) {
      const deletes = [...listRemoteDeletePaths(plan), ...listLocalDeletePaths(plan)];
      const detail = deletes.length > 0 ? `\n将删除：${deletes.join("、")}` : "";
      const confirmed = await ctx.ui.confirm("云同步", `按上述计划执行同步？${detail}`);
      if (!confirmed) {
        ctx.ui.notify("已取消，未做任何改动。", "info");
        return;
      }
    }

    const applied = await applySync({ ctx: syncCtx, plan, snapshot });
    if (!applied.ok) {
      const suffix = applied.rolledBack ? "\n已回滚，未做任何改动。" : "";
      ctx.ui.notify(`${formatSyncFailure(applied.failure!, { raw: true })}${suffix}`, "warning");
      return;
    }

    ctx.ui.notify(formatSyncResult(applied.summary), applied.summary.pushed || applied.summary.noop ? "info" : "warning");
  } finally {
    lock.lock.release();
  }
}

// ── /team sync status ────────────────────────────────────────

function collectArchive(rootDir: string): { count: number; latest?: string } {
  const dir = join(rootDir, "sync-conflicts");
  if (!existsSync(dir)) return { count: 0 };
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
    if (files.length === 0) return { count: 0 };
    return { count: files.length, latest: join(dir, files[files.length - 1]) };
  } catch {
    return { count: 0 };
  }
}

export async function handleSyncStatus(ctx: ExtensionCommandContext, deps?: SyncCommandDeps): Promise<void> {
  const rootDir = deps?.rootDir ?? getRootDir();
  const now = deps?.now ?? (() => new Date());
  const config = loadSyncConfig(rootDir);
  const checkedAt = formatClock(now());

  const emptyLocal = { uncommittedTeams: 0, unpushedCommits: 0 };

  if (!config || !config.remoteUrl) {
    ctx.ui.notify(
      formatSyncStatus({
        configured: false,
        enabled: false,
        remoteUrlMasked: "",
        branch: "",
        branchSourceLabel: "自动探测",
        remote: { kind: "unchecked" },
        checkedAt,
        local: emptyLocal,
        archive: collectArchive(rootDir),
        invalidTeams: [],
        repo: { ok: true },
      }),
      "info"
    );
    return;
  }

  const syncCtx = buildContext(rootDir, config, deps);
  const repoState = await inspectRepo(syncCtx);
  const invalidTeams = repoState.hasRepo ? await listInvalidTeamFiles(syncCtx) : [];

  // 分支：配置优先；否则本地 HEAD；再否则默认
  let branch = config.branch || repoState.headBranch || "";
  let branchSourceLabel = config.branch ? "配置" : "自动探测";

  // 仓库状态：锁 / index.lock
  let repoOk = true;
  let repoNote: string | undefined;
  const lockPath = join(rootDir, "sync.lock");
  const lockInfo = readSyncLock(lockPath);
  if (!repoState.hasRepo && config.remoteUrl) {
    repoOk = false;
    repoNote = "尚未接入（运行 /team sync 完成首次接入）";
  } else if (lockInfo && !isSyncLockStale(lockInfo)) {
    repoOk = false;
    repoNote = `另一同步实例运行中（pid ${lockInfo.pid}）`;
  } else if (repoState.hasRepo && repoState.gitDir && hasIndexLock(repoState.gitDir)) {
    repoOk = false;
    repoNote = "存在 .git/index.lock（另一进程运行中或上次异常退出）";
  }

  // 远端检查（短超时；失败保留本地信息）
  let remote: SyncStatusData["remote"] = { kind: "unchecked" };
  let uncommittedTeams = 0;
  let unpushedCommits = 0;

  if (!config.enabled || !config.remoteUrl) {
    remote = { kind: "unchecked" };
  } else if (!repoState.hasRepo) {
    remote = { kind: "unchecked" };
  } else {
    const statusCtx: SyncContext = {
      ...syncCtx,
      networkTimeoutMs: deps?.statusTimeoutMs ?? STATUS_CHECK_TIMEOUT_MS,
    };
    const discovery = await discoverRemoteBranch(statusCtx, config.branch);
    if (!discovery.ok) {
      remote = { kind: "error", failure: discovery.failure };
    } else {
      branch = discovery.branch;
      branchSourceLabel = discovery.source === "config" ? "配置" : "自动探测";
      if (discovery.emptyRemote) {
        remote = { kind: "empty" };
      } else {
        const fetched = await fetchRemote(
          statusCtx,
          {
            branch: discovery.branch,
            branchSource: discovery.source,
            emptyRemote: false,
            remoteSha: discovery.remoteSha,
            remoteUrlChanged: false,
            state: repoState,
          } satisfies PreparedRepository,
          { noWriteFetchHead: true } // 只读检查：不写 FETCH_HEAD（不与进行中的 sync 干扰）
        );
        if (!fetched.ok) {
          remote = { kind: "error", failure: fetched.failure };
        } else {
          const localRef = `refs/heads/${discovery.branch}`;
          const localExists = await runLocalGit(syncCtx, ["rev-parse", "--verify", "--quiet", localRef]);
          if (!localExists.ok || localExists.stdout.trim().length === 0) {
            // 本地尚无分支：远端领先其全部提交（审查 #10）
            const count = await runLocalGit(syncCtx, ["rev-list", "--count", fetched.remoteSha]);
            const behind = count.ok ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0;
            remote = { kind: "behind", behind };
          } else {
            const counts = await runLocalGit(syncCtx, [
              "rev-list",
              "--left-right",
              "--count",
              `${fetched.remoteSha}...${localRef}`,
            ]);
            if (counts.ok) {
              const [behindStr, aheadStr] = counts.stdout.trim().split(/\s+/);
              const behind = Number.parseInt(behindStr ?? "0", 10) || 0;
              const ahead = Number.parseInt(aheadStr ?? "0", 10) || 0;
              unpushedCommits = ahead;
              if (behind === 0 && ahead === 0) remote = { kind: "up-to-date" };
              else if (behind > 0 && ahead === 0) remote = { kind: "behind", behind };
              else if (ahead > 0 && behind === 0) remote = { kind: "ahead", ahead };
              else remote = { kind: "diverged", ahead, behind };
            }
          }
        }
      }
    }
    if (branch) {
      uncommittedTeams = await countUncommittedTeamChanges(syncCtx, branch);
    }
  }

  ctx.ui.notify(
    formatSyncStatus({
      configured: true,
      enabled: config.enabled,
      remoteUrlMasked: maskRemoteUrl(config.remoteUrl),
      branch,
      branchSourceLabel,
      remote,
      checkedAt,
      local: { uncommittedTeams, unpushedCommits },
      archive: collectArchive(rootDir),
      invalidTeams,
      repo: { ok: repoOk, note: repoNote },
    }),
    "info"
  );
}

/** 供团队会话白名单/帮助引用（保持单一事实来源）。 */
export const SYNC_USAGE = [
  "  /team sync              与云端双向同步（首次运行会引导配置仓库地址）",
  "  /team sync status       查看云同步状态（只读）",
].join("\n");
