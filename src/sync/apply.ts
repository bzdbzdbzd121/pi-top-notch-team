/**
 * 阶段 2：同步主体（应用段）。
 *
 * 「先算后改」的第三段（方案 §3.2 / §7.D 第 3–4 步）——唯一写工作区与分支引用的阶段：
 *  1. TOCTOU 复核（FETCH_HEAD、本地分支、计划涉及文件的 blob id/存在性）；
 *  2. 逐文件「临时文件 + rename」落盘/删除，记录内存回滚日志；
 *  3. 临时索引构造提交（read-tree 云端树 → 精确路径增删 → write-tree →
 *     commit-tree 双父），全程不执行任何合并命令；
 *  4. 分支引用更新 + 快进推送（--no-verify）；失败即回滚文件、不动引用。
 *
 * 唯一允许的中间态：本地已提交但推送失败（明确报告，重跑收敛）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { FileClass } from "./classify";
import {
  describeSyncFailure,
  failureFromResult,
  isSafeRepoPath,
  listConflicts,
  listInvalidTeamFiles,
  manualFailure,
  resolveSafeWorktreePath,
  runLocalGit,
  runNetworkGit,
  verifyPlanFingerprints,
  type InvalidTeamFile,
  type IgnoredSummary,
  type PlanSnapshot,
  type SyncContext,
  type SyncFailure,
  type SyncPlan,
} from "./plan";

/** 身份缺失时的兜底提交身份（方案 §6.3 第 3 项；不修改用户 git 配置）。 */
export const FALLBACK_IDENTITY_NAME = "pi-top-notch-team";
export const FALLBACK_IDENTITY_EMAIL = "pi-top-notch-team@localhost";

export interface ApplySummary {
  branch: string;
  downloaded: string[];
  uploaded: string[];
  /** 云端删除、本机跟随删除。 */
  deletedOnLocal: string[];
  /** 本机删除、云端跟随删除。 */
  deletedOnRemote: string[];
  /** 非团队文件按「云端为准」覆盖的路径。 */
  passthroughUpdated: string[];
  /** 覆盖前留档的本机版本（方案 §4.3/§6.2#2：改动不被静默丢弃）。 */
  archivedFiles: { path: string; archivePath: string }[];
  /** 本地已跟踪但云端没有、被保留的路径（避免孤儿化）。 */
  keptLocalPaths: string[];
  ignored: IgnoredSummary;
  invalidTeams: InvalidTeamFile[];
  /** 新提交（或快进到的云端提交）；无事可做时为空。 */
  commit: string;
  pushed: boolean;
  pushFailure?: SyncFailure;
  /** 提交后索引刷新（reset --mixed）失败（独立于 push 失败）。 */
  indexRefreshFailure?: SyncFailure;
  fallbackIdentity: boolean;
  fastForward: boolean;
  backupRef?: string;
  noop: boolean;
}

export interface ApplyResult {
  ok: boolean;
  summary: ApplySummary;
  failure?: SyncFailure;
  /** 文件已回滚（报告「未做任何改动」）。 */
  rolledBack: boolean;
}

interface JournalEntry {
  absPath: string;
  /** 写入前的原始内容；null = 原本不存在。 */
  previous: Buffer | null;
}

function emptySummary(plan: SyncPlan): ApplySummary {
  return {
    branch: plan.branch,
    downloaded: [],
    uploaded: [],
    deletedOnLocal: [],
    deletedOnRemote: [],
    passthroughUpdated: [],
    archivedFiles: [],
    keptLocalPaths: [],
    ignored: plan.ignored,
    invalidTeams: [],
    commit: "",
    pushed: false,
    fallbackIdentity: false,
    fastForward: false,
    noop: false,
  };
}

/** 尽力而为地 fsync（掉电不留下空文件；失败不改变写入语义）。 */
function syncFileBestEffort(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    /* best-effort */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** 原子写（同目录临时文件 + rename）；临时名不匹配 `*.yaml`；二进制安全。 */
function writeFileAtomic(absPath: string, content: string | Buffer): void {
  const tmpPath = `${absPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, content);
    syncFileBestEffort(tmpPath);
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 保留原始错误 */
    }
    throw err;
  }
}

/** 清理本次运行新建的留档（回滚路径专用：已被还原的工作区不再需要冗余留档）。 */
function cleanupCreatedArchives(archives: string[]): void {
  for (const abs of archives) {
    try {
      rmSync(abs, { force: true });
    } catch {
      /* 尽力而为 */
    }
  }
}

function rollback(journal: JournalEntry[]): void {
  for (const entry of [...journal].reverse()) {
    try {
      if (entry.previous === null) {
        if (existsSync(entry.absPath)) unlinkSync(entry.absPath);
      } else {
        writeFileAtomic(entry.absPath, entry.previous);
      }
    } catch {
      /* 回滚尽力而为；失败留给下次同步按最新状态收敛 */
    }
  }
}

function toSummaryName(path: string): string {
  return path.endsWith(".yaml") ? path.slice(0, -".yaml".length) : path;
}

/** 归档目录（`<rootDir>/sync-conflicts/`）：不参与列表、不参与同步、不污染云端。阶段 4 复用同一目录。 */
export function syncConflictsDir(rootDir: string): string {
  return join(rootDir, "sync-conflicts");
}

/** Windows 保留设备名（含扩展名前的首个点段）——归档名必须规避，否则 Windows 上必失败。 */
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** 路径安全化：只折掉真正的路径/非法字符，保留中文、空格等可读信息。 */
function sanitizeArchiveName(relPath: string): string {
  const safe = relPath
    // 路径分隔符与 Windows 非法字符（含控制字符）→ `_`
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    // 前导 `.`/`_` 折叠（避免 `..`、`.hidden` 形态与隐藏文件）
    .replace(/^[._]+/, "_")
    // Windows 不允许文件名以点或空格结尾
    .replace(/[. ]+$/, "");
  if (safe.length === 0) return "file";
  const stem = safe.split(".")[0]?.toLowerCase() ?? "";
  return WINDOWS_RESERVED_NAMES.has(stem) ? `_${safe}` : safe;
}

/**
 * 归档文件名：`<路径安全化>-<原路径短哈希>[-<冲突序号>].<YYYYMMDD-HHmmss>`。
 *
 * 短哈希保证**不同路径在同一秒内也绝不撞名**（中文名/特殊字符名折成同一个
 * 可读名也不互相覆盖）；可读名保留中文等原始信息，不再退化为 `_md` 这类无
 * 信息名。`suffix > 1` 供同一路径同一秒的极端重复归档追加序号。
 * 阶段 4 的团队归档复用同一目录与命名规则（见 isArchiveFileName）。
 */
export function archiveFileName(relPath: string, now: Date, suffix = 0): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
  const hash = createHash("sha1").update(relPath).digest("hex").slice(0, 8);
  const safe = sanitizeArchiveName(relPath);
  const counter = suffix > 0 ? `-${suffix}` : "";
  return `${safe}-${hash}${counter}.${stamp}`;
}

/** 归档文件名识别（status 计数与阶段 4 复用同一规则）。 */
export function isArchiveFileName(name: string): boolean {
  return /\.\d{8}-\d{4}(\d{2})?(\.yaml)?$/.test(name);
}

/**
 * 取一个当前不存在的归档路径：短哈希已保证不同路径唯一，同路径同一秒重复
 * 归档（极端情况）用序号兜底，绝不覆盖已有留档。
 */
function uniqueArchivePath(dir: string, relPath: string, now: Date): string {
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? archiveFileName(relPath, now) : archiveFileName(relPath, now, i + 1);
    const abs = join(dir, name);
    if (!existsSync(abs)) return abs;
  }
  throw manualFailure(
    `归档目录中同名留档过多（${relPath}），已中止（未做任何改动）`,
    "清理 sync-conflicts 目录后重试"
  );
}

/** 云端 blob 内容（按 sha 缓存；二进制安全捕获，非文本文件不被 utf8 解码损坏）。 */
async function readRemoteBlob(
  ctx: SyncContext,
  blob: string,
  cache: Map<string, Buffer>
): Promise<{ ok: true; content: Buffer } | { ok: false; failure: SyncFailure }> {
  const cached = cache.get(blob);
  if (cached !== undefined) return { ok: true, content: cached };
  const res = await runLocalGit(ctx, ["cat-file", "blob", blob], {
    maxBuffer: 8 * 1024 * 1024,
    binaryStdout: true,
  });
  if (!res.ok) return { ok: false, failure: failureFromResult(res) };
  const content = res.stdoutBuffer ?? Buffer.from(res.stdout, "utf8");
  cache.set(blob, content);
  return { ok: true, content };
}

function bufferEquals(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

function actionKind(action: FileClass): FileClass["kind"] {
  return action.kind;
}

const ADD_KINDS: FileClass["kind"][] = ["local-modified", "local-only"];
const DELETE_KINDS: FileClass["kind"][] = ["local-deleted", "remote-deleted", "both-deleted"];

/**
 * 应用同步（唯一写工作区与引用的入口）。
 * 失败时（引用更新之前）回滚已写文件并报告「未做任何改动」。
 */
export async function applySync(input: {
  ctx: SyncContext;
  plan: SyncPlan;
  snapshot: PlanSnapshot;
}): Promise<ApplyResult> {
  const { ctx, plan, snapshot } = input;
  const summary = emptySummary(plan);
  const journal: JournalEntry[] = [];
  /** 本次运行新建的留档文件——回滚时一并清理（工作区已还原，留档变冗余）。 */
  const createdArchives: string[] = [];

  // ── 1. TOCTOU 复核（计划期间文件/引用被改动即中止） ──
  const conflicts = listConflicts(plan);
  if (conflicts.length > 0) {
    return {
      ok: false,
      summary,
      failure: manualFailure(
        `存在 ${conflicts.length} 个需要决策的冲突团队（${conflicts.map((c) => c.path).join("、")}）`,
        "冲突决策将在后续版本提供；当前请手工处理这些团队后重试"
      ),
      rolledBack: false,
    };
  }

  const stale = await verifyPlanFingerprints(ctx, snapshot);
  if (stale) return { ok: false, summary, failure: stale, rolledBack: false };

  const remoteMap = new Map(snapshot.remoteEntries.map((e) => [e.path, e]));
  const actionMap = new Map(plan.actions.map((a) => [a.path, a]));
  const blobCache = new Map<string, Buffer>();

  // ── 2. 工作区落盘（原子替换 / 删除；失败即回滚） ──
  // 危险路径（`..`/绝对路径/反斜杠）一律跳过：计划阶段已过滤，这里再作防御。
  const unsafe: string[] = [];
  const safeAbs = (rel: string): string | null => {
    if (!isSafeRepoPath(rel)) {
      unsafe.push(rel);
      return null;
    }
    return resolveSafeWorktreePath(ctx.teamsDir, rel);
  };
  try {
    for (const action of plan.actions) {
      const path = action.path;
      const kind = actionKind(action);
      if (ADD_KINDS.includes(kind)) {
        // 本机侧内容已在工作区，分类阶段已确认；仅计数
        summary.uploaded.push(toSummaryName(path));
        continue;
      }
      if (DELETE_KINDS.includes(kind)) {
        const abs = safeAbs(path);
        if (!abs) continue;
        if (kind === "remote-deleted" || kind === "both-deleted") {
          if (existsSync(abs)) {
            journal.push({ absPath: abs, previous: readFileSync(abs) });
            unlinkSync(abs);
            summary.deletedOnLocal.push(toSummaryName(path));
          }
        } else {
          // local-deleted：本机已无文件，云端删除在提交树中体现
          summary.deletedOnRemote.push(toSummaryName(path));
        }
        continue;
      }
      if (kind === "remote-modified" || kind === "remote-only") {
        const entry = remoteMap.get(path);
        if (!entry) continue;
        const abs = safeAbs(path);
        if (!abs) continue;
        const blob = await readRemoteBlob(ctx, entry.blob, blobCache);
        if (!blob.ok) throw blob.failure;
        const previous = existsSync(abs) ? readFileSync(abs) : null;
        if (!bufferEquals(blob.content, previous)) {
          journal.push({ absPath: abs, previous });
          writeFileAtomic(abs, blob.content);
        }
        summary.downloaded.push(toSummaryName(path));
      }
    }

    // 非团队文件「云端为准」：远端树里有、本地内容不同的路径按远端覆盖
    for (const entry of snapshot.remoteEntries) {
      if (actionMap.has(entry.path)) continue;
      const abs = safeAbs(entry.path);
      if (!abs) continue;
      const previous = existsSync(abs) ? readFileSync(abs) : null;
      const blob = await readRemoteBlob(ctx, entry.blob, blobCache);
      if (!blob.ok) throw blob.failure;
      if (!bufferEquals(blob.content, previous)) {
        // 覆盖前留档本机版本（方案 §4.3/§6.2#2：「云端为准」不等于丢弃本机改动）。
        // 留档失败则中止（宁可同步失败，不让用户改动消失）——回滚后本地文件保持原样。
        if (previous !== null) {
          const archiveDir = syncConflictsDir(ctx.rootDir);
          let archiveAbs = "";
          try {
            mkdirSync(archiveDir, { recursive: true });
            archiveAbs = uniqueArchivePath(archiveDir, entry.path, new Date());
            writeFileAtomic(archiveAbs, previous); // 原子写：崩溃不留截断的「完整命名」留档
          } catch (err) {
            if (archiveAbs.length > 0) {
              try {
                rmSync(archiveAbs, { force: true }); // 清掉本次写入的半成品
              } catch {
                /* 尽力而为 */
              }
            }
            throw manualFailure(
              `非团队文件被云端覆盖前的留档失败（${entry.path}），已中止（未做任何改动）：${
                err instanceof Error ? err.message : String(err)
              }`,
              "确认 sync-conflicts 目录可写、磁盘空间充足后重试"
            );
          }
          createdArchives.push(archiveAbs);
          summary.archivedFiles.push({ path: entry.path, archivePath: archiveAbs });
        }
        const absDir = dirname(abs);
        if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
        journal.push({ absPath: abs, previous });
        writeFileAtomic(abs, blob.content);
        summary.passthroughUpdated.push(entry.path);
      }
    }

    if (unsafe.length > 0) {
      summary.ignored = {
        ...summary.ignored,
        unsafePaths: [...new Set([...(summary.ignored.unsafePaths ?? []), ...unsafe])].sort(),
      };
    }

    // 本地已跟踪、云端没有的非管理路径：仍存在→保留（避免孤儿化）；
    // 已在本机删除的已跟踪文件会被下方索引循环一并移除（不再跟踪），
    // 不得声称「保留/不删除」（复审建议 #2）。
    for (const entry of snapshot.localEntries) {
      if (remoteMap.has(entry.path) || actionMap.has(entry.path)) continue;
      const abs = resolveSafeWorktreePath(ctx.teamsDir, entry.path);
      if (abs && existsSync(abs)) summary.keptLocalPaths.push(entry.path);
    }

    // 落盘后重新扫描：本地原有 + 刚下载的非法 YAML 都如实报告（真实后果见文案）
    summary.invalidTeams = await listInvalidTeamFiles(ctx);

    // 无事可做：双方提交一致且没有任何动作/覆盖/删除 → 不构造提交、不推送
    const hasWork =
      plan.actions.some((a) => a.kind !== "unchanged" && a.kind !== "both-deleted") ||
      summary.passthroughUpdated.length > 0 ||
      summary.deletedOnLocal.length > 0;
    if (snapshot.localSha === snapshot.remoteSha && !hasWork) {
      summary.noop = true;
      return { ok: true, summary, rolledBack: false };
    }
  } catch (err) {
    rollback(journal);
    cleanupCreatedArchives(createdArchives);
    const failure = typeof err === "object" && err !== null && "classification" in err
      ? (err as SyncFailure)
      : manualFailure(
          `写入工作区失败：${err instanceof Error ? err.message : String(err)}`,
          "确认磁盘空间与目录权限后重试"
        );
    return { ok: false, summary, failure, rolledBack: true };
  }

  // ── 3. 临时索引构造提交树（不执行任何合并） ──
  const gitDir = snapshot.gitDir;
  const tmpIndex = join(gitDir, `sync-index-${process.pid}-${Date.now()}`);
  const indexEnv = { GIT_INDEX_FILE: tmpIndex };
  const addEnv = { GIT_INDEX_FILE: tmpIndex, GIT_LITERAL_PATHSPECS: "1" };

  const failBeforeCommit = (failure: SyncFailure): ApplyResult => {
    rollback(journal);
    cleanupCreatedArchives(createdArchives);
    return { ok: false, summary, failure, rolledBack: true };
  };

  try {
    const readTree = snapshot.remoteSha
      ? await runLocalGit(ctx, ["read-tree", snapshot.remoteSha], { env: indexEnv })
      : await runLocalGit(ctx, ["read-tree", "--empty"], { env: indexEnv });
    if (!readTree.ok) return failBeforeCommit(failureFromResult(readTree));

    for (const action of plan.actions) {
      if (!isSafeRepoPath(action.path)) continue; // 防御：危险路径不进入索引操作
      const kind = actionKind(action);
      if (ADD_KINDS.includes(kind)) {
        const add = await runLocalGit(ctx, ["add", "--", action.path], { env: addEnv });
        if (!add.ok) return failBeforeCommit(failureFromResult(add));
      } else if (DELETE_KINDS.includes(kind)) {
        const remove = await runLocalGit(ctx, ["update-index", "--force-remove", "--", action.path], { env: indexEnv });
        if (!remove.ok) return failBeforeCommit(failureFromResult(remove));
      }
    }

    // 本地已跟踪但云端没有的非管理路径：保留在提交树中
    for (const entry of snapshot.localEntries) {
      if (remoteMap.has(entry.path) || actionMap.has(entry.path)) continue;
      const abs = resolveSafeWorktreePath(ctx.teamsDir, entry.path);
      if (!abs || !existsSync(abs)) continue;
      const add = await runLocalGit(ctx, ["add", "--", entry.path], { env: addEnv });
      if (!add.ok) return failBeforeCommit(failureFromResult(add));
    }

    const writeTree = await runLocalGit(ctx, ["write-tree"], { env: indexEnv });
    if (!writeTree.ok) return failBeforeCommit(failureFromResult(writeTree));
    const finalTree = writeTree.stdout.trim();

    const oldSha = snapshot.localSha || "0000000000000000000000000000000000000000";

    // 换远端地址：先为本地历史保留备份引用，避免旧历史被推到新仓库
    // （审查 #1：新 ref 必须传全 0 old 值；失败则中止，不静默降级）
    if (snapshot.remoteUrlChanged && snapshot.localSha) {
      const backupRef = `refs/sync-backup/${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const backup = await runLocalGit(ctx, [
        "update-ref",
        backupRef,
        snapshot.localSha,
        "0000000000000000000000000000000000000000",
      ]);
      if (!backup.ok) {
        return failBeforeCommit(
          manualFailure(
            "换远端地址前的本地历史备份引用创建失败，已中止（未做任何改动）",
            "检查仓库可写后重试（备份名 refs/sync-backup/<时间戳>）"
          )
        );
      }
      summary.backupRef = backupRef;
    }

    // 快速路径：最终树 = 云端树且本地是云端的祖先（本次只有下载）→ 直接指向云端提交
    const canFastForward =
      snapshot.remoteSha !== "" &&
      finalTree === snapshot.remoteTree &&
      (snapshot.localSha === "" || (await isAncestor(ctx, snapshot.localSha, snapshot.remoteSha)));

    if (canFastForward) {
      const update = await runLocalGit(ctx, ["update-ref", `refs/heads/${plan.branch}`, snapshot.remoteSha, oldSha]);
      if (!update.ok) return failBeforeCommit(failureFromResult(update));
      const reset = await runLocalGit(ctx, ["reset", "--mixed", "--quiet"]);
      if (!reset.ok) return failBeforeCommit(failureFromResult(reset));
      summary.commit = snapshot.remoteSha;
      summary.pushed = true;
      summary.fastForward = true;
      return { ok: true, summary, rolledBack: false };
    }

    // 空远端 + 最终树 = 本地已有历史（审查 #9）：直接推现有 tip，不造无意义提交
    if (snapshot.remoteSha === "" && snapshot.localSha !== "" && finalTree === snapshot.localTree) {
      const push = await pushBranch(ctx, plan.branch);
      if (push.ok) {
        summary.pushed = true;
      } else {
        summary.pushFailure = push.failure;
      }
      summary.commit = snapshot.localSha;
      return { ok: true, summary, rolledBack: false };
    }

    // 父提交：本地 tip + 云端 tip（双父，保留双方历史）；换远端地址时仅云端为父
    const parents = snapshot.remoteUrlChanged
      ? (snapshot.remoteSha ? [snapshot.remoteSha] : [])
      : dedupe([snapshot.localSha, snapshot.remoteSha].filter(Boolean));
    const message = `sync: 下载 ${summary.downloaded.length}、上传 ${summary.uploaded.length}、删除 ${
      summary.deletedOnLocal.length + summary.deletedOnRemote.length
    }`;

    // 身份缺失 → 兜底身份（-c 传入，不修改用户全局配置）
    const ident = await runLocalGit(ctx, ["var", "GIT_AUTHOR_IDENT"]);
    const fallbackIdentity = !ident.ok;
    summary.fallbackIdentity = fallbackIdentity;

    const commitArgs = [
      "-c",
      "commit.gpgsign=false",
      ...(fallbackIdentity
        ? ["-c", `user.name=${FALLBACK_IDENTITY_NAME}`, "-c", `user.email=${FALLBACK_IDENTITY_EMAIL}`]
        : []),
      "commit-tree",
      finalTree,
      ...parents.flatMap((p) => ["-p", p]),
      "-m",
      message,
    ];
    const commit = await runLocalGit(ctx, commitArgs);
    if (!commit.ok) return failBeforeCommit(failureFromResult(commit));
    const commitSha = commit.stdout.trim();

    // 引用更新（old 值校验防并发覆盖）；失败 → 文件回滚、不动引用
    const update = await runLocalGit(ctx, ["update-ref", `refs/heads/${plan.branch}`, commitSha, oldSha]);
    if (!update.ok) return failBeforeCommit(failureFromResult(update));

    const reset = await runLocalGit(ctx, ["reset", "--mixed", "--quiet"]);
    if (!reset.ok) {
      // 引用已更新：不回滚文件（提交已生效），但索引刷新失败要独立报告
      // （审查 #8：这不是 push 失败）；仍继续尝试推送
      summary.indexRefreshFailure = failureFromResult(reset);
    }

    summary.commit = commitSha;

    // ── 4. 推送（唯一允许的中间态：本地已提交、推送失败） ──
    const push = await pushBranch(ctx, plan.branch);
    if (push.ok) {
      summary.pushed = true;
    } else {
      summary.pushed = false;
      summary.pushFailure = push.failure;
    }
    return { ok: true, summary, rolledBack: false };
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

async function isAncestor(ctx: SyncContext, ancestor: string, descendant: string): Promise<boolean> {
  const res = await runLocalGit(ctx, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return res.ok;
}

/** 推送分支（无 upstream 时 `-u`；`--no-verify` 绕过用户 pre-push 钩子）。 */
async function pushBranch(
  ctx: SyncContext,
  branch: string
): Promise<{ ok: true } | { ok: false; failure: SyncFailure }> {
  const upstream = await runLocalGit(ctx, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  const needUpstream = !upstream.ok;
  const args = ["push", ...(needUpstream ? ["-u"] : []), "--no-verify", "--", "origin", branch];
  const res = await runNetworkGit(ctx, args);
  if (res.ok) return { ok: true };

  if (/non-fast-forward|\[rejected\]|fetch first|remote contains work/i.test(res.stderr)) {
    return {
      ok: false,
      failure: manualFailure(
        "推送被拒绝：云端已有其它机器推送的更新",
        "重新运行 /team sync 合并云端更新后会自动重推"
      ),
    };
  }
  return { ok: false, failure: failureFromResult(res) };
}

export { describeSyncFailure };
