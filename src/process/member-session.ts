import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from "node:path";
import type { MemberProcessHandle } from "./member-process";

/**
 * 成员会话文件模块（阶段 2，方案 §3.2 / 附录 B）。
 *
 * 职责：
 *  - 枚举成员会话目录下的 `*.jsonl`（递归；`hasSessionFiles` 与归档共用这一份实现）
 *  - 把旧会话文件归档到 `.member-resets/<成员>/<时间戳>/`（同步文件 API）
 *  - 统计该成员的归档数量与占用字节（结果文案里的「累计」）
 *  - 启动后查询成员实际承载的会话条数（`get_state`，阶段 4 消费）
 *
 * 归档布局（方案 §3.2.3）：
 *   <团队会话目录>/
 *   ├── .member-resets/<成员>/<YYYYMMDD-HHMMSS[-n]>/…   ← 归档（点号开头；成员名不能以点开头）
 *   └── <成员>/…                                        ← 成员自己的 pi 会话目录
 *
 * 归档根与成员目录**同级**而不是在成员目录内部：扩展的「能不能续接」探测是递归的，
 * 留在成员目录内（哪怕改后缀）仍会被算作「有历史」；放到同级是结构性排除，
 * 不依赖任何后缀约定。归档随 `/team delete` 删除整个团队会话目录时一并清除。
 */

/** 归档根目录名（点号开头；成员名不能以点开头，见 src/team/schema.ts）。 */
export const MEMBER_ARCHIVE_ROOT = ".member-resets";

/** 归档目录名格式：YYYYMMDD-HHMMSS，同秒重复时追加 -1、-2… */
const ARCHIVE_DIR_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;

export interface MemberSessionFile {
  /** 相对成员会话目录的路径（嵌套布局时保留子目录，分隔符为 "/"）。 */
  relativePath: string;
  /** 绝对路径（或调用方传入的相对路径原样拼接）。 */
  path: string;
}

/**
 * 递归列出成员会话目录下的 `*.jsonl`。目录不存在/不可读 → `[]`。
 * 刻意不跟随符号链接（`Dirent.isFile()` 对符号链接为假）——归档只搬真实文件。
 */
export function listMemberSessionFiles(sessionDir: string): MemberSessionFile[] {
  const files: MemberSessionFile[] = [];
  walk(sessionDir, "", files);
  return files;
}

function walk(currentDir: string, prefix: string, out: MemberSessionFile[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  // 稳定顺序：归档与断言都不依赖文件系统的目录顺序
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walk(absolutePath, relativePath, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push({ relativePath, path: absolutePath });
    }
  }
}

export interface ArchiveFailure {
  relativePath: string;
  reason: string;
}

export interface ArchiveResult {
  /** 归档目录（本次无文件可归档、或归档被跳过时为 null） */
  archiveDir: string | null;
  /** 成功移动的相对路径 */
  moved: string[];
  /** 失败明细（不抛错） */
  failed: ArchiveFailure[];
  /** 归档后该成员的累计归档目录数（含本次）与合计字节数 */
  memberArchiveCount: number;
  memberArchiveBytes: number;
}

export interface ArchiveMemberSessionParams {
  /** 成员自己的会话目录（文件来源；归档根取它的同级目录） */
  sessionDir: string;
  memberName: string;
  /** 启动前快照（由 listMemberSessionFiles 产生）；缺省时现场枚举 */
  files?: MemberSessionFile[];
  now?: Date;
}

/**
 * 把成员会话目录下全部 `*.jsonl` 移入
 *   `<成员会话目录的同级>/.member-resets/<成员>/<YYYYMMDD-HHMMSS[-n]>/`
 * （保持相对路径与原文件名，恢复就是一次普通移动）。
 *
 * 同步文件 API（方案 §3.1.4）：归档发生在「重复启动检查 → 登记句柄 → start()」
 * 的同步段内，换成异步 API 会重新打开并发窗口。任何错误只记录进 `failed`，
 * 绝不抛出（归档失败不阻断启动，本次干净由配置层的 fresh 保证）。
 */
export function archiveMemberSessionFiles(params: ArchiveMemberSessionParams): ArchiveResult {
  const { sessionDir, memberName } = params;
  const now = params.now ?? new Date();
  const files = params.files ?? listMemberSessionFiles(sessionDir);

  const archiveRoot = join(dirname(sessionDir), MEMBER_ARCHIVE_ROOT);
  const memberArchiveDir = join(archiveRoot, memberName);
  const resolvedRoot = resolve(archiveRoot);
  const resolvedMemberDir = resolve(memberArchiveDir);

  // 防御：动态成员名未经校验（src/setup/dynamic-session-bootstrap.ts）。两种形状
  // 会让归档根与成员会话目录重合或把归档写到根外，一律跳过并说明，不发明第二套目录名。
  const degenerate =
    resolvedRoot === resolve(sessionDir) ||
    resolvedMemberDir === resolvedRoot ||
    !resolvedMemberDir.startsWith(resolvedRoot + sep);
  if (degenerate) {
    return {
      archiveDir: null,
      moved: [],
      failed: [
        {
          relativePath: memberName,
          reason: `成员名不可用于归档目录（${memberName}），已跳过归档；旧会话文件仍在 ${sessionDir}`,
        },
      ],
      ...summarizeMemberArchives(memberArchiveDir),
    };
  }

  if (files.length === 0) {
    return {
      archiveDir: null,
      moved: [],
      failed: [],
      ...summarizeMemberArchives(memberArchiveDir),
    };
  }

  const archiveDir = createArchiveDir(memberArchiveDir, now);
  const moved: string[] = [];
  const failed: ArchiveFailure[] = [];

  for (const file of files) {
    // relativePath 用 "/" 分隔（可移植的归档内相对路径）
    const destination = join(archiveDir, ...file.relativePath.split("/"));
    try {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(file.path, destination);
      moved.push(file.relativePath);
    } catch (err) {
      failed.push({ relativePath: file.relativePath, reason: errorReason(err) });
    }
  }

  // 自检（方案 §3.2.4 最后一行）：只作提示、不作硬门——硬门会让「将来 pi 换存储
  // 格式」变成 fresh 永久不可用。归档根是成员目录的同级，所以移动过去的文件
  // 不会在这里被当成残留。
  const alreadyReported = new Set(failed.map((f) => f.relativePath));
  for (const residual of listMemberSessionFiles(sessionDir)) {
    if (alreadyReported.has(residual.relativePath)) continue;
    failed.push({
      relativePath: residual.relativePath,
      reason: "归档后该文件仍留在成员会话目录",
    });
  }

  return {
    archiveDir,
    moved,
    failed,
    ...summarizeMemberArchives(memberArchiveDir),
  };
}

/** 取一个不存在的时间戳目录（同一秒重复归档时追加 -1、-2…）。 */
function createArchiveDir(memberArchiveDir: string, now: Date): string {
  const stamp = formatArchiveStamp(now);
  let dir = join(memberArchiveDir, stamp);
  for (let suffix = 1; existsSync(dir); suffix++) {
    dir = join(memberArchiveDir, `${stamp}-${suffix}`);
  }
  return dir;
}

/** 归档目录名：本地时间 YYYYMMDD-HHMMSS（字典序即时间序）。 */
function formatArchiveStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 该成员的归档累计：时间戳目录数量 + 递归合计字节数（不可读按 0）。 */
function summarizeMemberArchives(memberArchiveDir: string): {
  memberArchiveCount: number;
  memberArchiveBytes: number;
} {
  let count = 0;
  let bytes = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(memberArchiveDir, { withFileTypes: true });
  } catch {
    return { memberArchiveCount: 0, memberArchiveBytes: 0 };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !ARCHIVE_DIR_PATTERN.test(entry.name)) continue;
    count += 1;
    bytes += directoryBytes(join(memberArchiveDir, entry.name));
  }
  return { memberArchiveCount: count, memberArchiveBytes: bytes };
}

function directoryBytes(dir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(path);
    } else if (entry.isFile()) {
      try {
        total += statSync(path).size;
      } catch {
        /* unreadable file: count 0 */
      }
    }
  }
  return total;
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 纯函数：字节数格式化（B 取整；KB/MB/GB/TB 一位小数）。非法/负值 → "0 B"。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export interface ResumedSessionProbe {
  /** resumed = 成员实际承载了历史；new = 实际是全新会话；unknown = 查询失败/超时 */
  status: "resumed" | "new" | "unknown";
  messageCount?: number;
  sessionId?: string;
}

/**
 * 启动后查询成员实际承载的会话（`get_state`，默认 3s 超时，fail-open → unknown）。
 * 只报事实、不猜目录：目录里有文件不等于成员真的续接上了（阶段 4 消费）。
 */
export async function probeResumedSession(
  handle: MemberProcessHandle,
  timeoutMs = 3000
): Promise<ResumedSessionProbe> {
  try {
    const response = await handle.sendCommandAndWait(
      { type: "get_state" },
      (event: any) => event?.type === "response" && event?.command === "get_state",
      timeoutMs
    );
    const data = response?.data;
    if (response?.success === false || !data) return { status: "unknown" };
    const messageCount = data.messageCount;
    if (typeof messageCount !== "number") return { status: "unknown" };
    return {
      status: messageCount > 0 ? "resumed" : "new",
      messageCount,
      ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}),
    };
  } catch {
    return { status: "unknown" };
  }
}

// ── 归档扫描与清理（阶段 3，方案 §3.3.3 / §3.3.4）────────────────
// 只读扫描在 `sessions/` 下找 `.member-resets`；删除只听用户确认后的扫描结果，
// 且逐条复核形状与真实路径。永不按「父目录整体删除」。

export interface MemberSessionArchiveEntry {
  teamName: string;
  /** 会话目录名（sessionId）；旧格式扁平布局时为 null */
  sessionId: string | null;
  memberName: string;
  /** 归档目录绝对路径（…/.member-resets/<成员>/<时间戳>） */
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface ArchiveScan {
  /** 数据根目录（删除阶段用它复核形状，防越界） */
  rootDir: string;
  /** 过滤的团队名（undefined = 全部团队） */
  teamName?: string;
  entries: MemberSessionArchiveEntry[];
  totalBytes: number;
  teamCount: number;
  sessionCount: number;
  /** 跳过/不可读的条目（不中断扫描） */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * 有界深度扫描（方案 v3：§3.3.3 / 阶段 3 验收 10）。
 *
 * `MEMBER_ARCHIVE_ROOT_MAX_DEPTH` = `.member-resets` 自身相对 `sessions/` 的**最大层级**
 * （团队=1）：2 = 旧扁平布局 `<团队>/.member-resets`，3 = 标准 `<团队>/<会话>/.member-resets`，
 * 4 = 成员名含一个路径分隔符产生的非标准层级 `<团队>/<会话>/<a>/.member-resets`。
 * 更深的归档根（多级分隔符）不在扫描范围——**不假装覆盖**（属附录 I 第 5 条的已知限制）。
 */
export const MEMBER_ARCHIVE_ROOT_MAX_DEPTH = 4;

/**
 * 归档根之下的最大探测层级（成员分组可能因成员名含分隔符而多层）：
 * 1 = 归档根直接含时间戳（无成员层，形状不合规 → skipped），
 * 2 = 标准 `<成员>/<时间戳>`，3 = `<a>/<b>/<时间戳>`（一个分隔符）。
 */
export const MEMBER_ARCHIVE_STAMP_MAX_DEPTH = 3;

/** 扫描上下文（保持递归签名的参数数量可控）。 */
interface ArchiveScanContext {
  rootDir: string;
  teamName: string;
  scan: ArchiveScan;
  teams: Set<string>;
  sessions: Set<string>;
}

/**
 * 只读扫描 `sessions/` 下的所有归档：支持 `<团队>/<会话>/.member-resets/…`
 * 与旧扁平布局 `<团队>/.member-resets/…`。不可读/形状不合规的条目记入
 * `skipped`，不中断扫描；扫描阶段零写操作（预览 = 干跑）。
 *
 * **完备性（深度上限内）**：遇到的每个时间戳形状目录「要么可删（两种合法形状）、
 * 要么进 skipped」——包括成员名含分隔符产生的非标准层级，不存在静默漏见的第三种状态。
 */
export function scanMemberSessionArchives(
  rootDir: string,
  opts?: { teamName?: string }
): ArchiveScan {
  const sessionsRoot = join(rootDir, "sessions");
  const scan: ArchiveScan = {
    rootDir,
    teamName: opts?.teamName,
    entries: [],
    totalBytes: 0,
    teamCount: 0,
    sessionCount: 0,
    skipped: [],
  };

  const teamNames = opts?.teamName
    ? [opts.teamName]
    : listDirectoryNames(sessionsRoot).filter((name) => !name.startsWith("."));

  const teams = new Set<string>();
  const sessions = new Set<string>();

  for (const teamName of teamNames) {
    // 团队目录相对 sessions/ 的层级 = 1；向下最多走到层级 3
    // （它的 `.member-resets` 子目录正好是层级 4 = 深度上限）。
    walkArchiveRoots(join(sessionsRoot, teamName), 1, {
      rootDir,
      teamName,
      scan,
      teams,
      sessions,
    });
  }

  scan.teamCount = teams.size;
  scan.sessionCount = sessions.size;
  return scan;
}

/**
 * 从 `dir`（相对 sessions/ 的层级为 `depth`）开始发现归档根：
 * 先看 `dir/.member-resets`，再在层级上限内下探子目录。
 */
function walkArchiveRoots(dir: string, depth: number, ctx: ArchiveScanContext): void {
  const archiveRoot = join(dir, MEMBER_ARCHIVE_ROOT);
  const archiveRootStat = lstatOrNull(archiveRoot);
  if (archiveRootStat) {
    if (archiveRootStat.isSymbolicLink() || !archiveRootStat.isDirectory()) {
      ctx.scan.skipped.push({
        path: archiveRoot,
        reason: archiveRootStat.isSymbolicLink()
          ? "归档根是符号链接，已跳过"
          : "归档根不是目录，已跳过",
      });
    } else {
      // 归档根层级：扁平团队 = 2，标准团队/会话 = 3，非标准（成员名含分隔符）= 4。
      const rootDepth = depth + 1;
      const sessionId = rootDepth === 3 ? basename(dir) : null;
      collectArchiveStamps(archiveRoot, 1, rootDepth, sessionId, ctx);
    }
  }

  // 下探到层级 3（root 层级 4）为止；更深不扫（有界深度，见常量注释）。
  if (depth >= MEMBER_ARCHIVE_ROOT_MAX_DEPTH - 1) return;
  for (const child of listDirectoryNames(dir)) {
    if (child === MEMBER_ARCHIVE_ROOT) continue;
    walkArchiveRoots(join(dir, child), depth + 1, ctx);
  }
}

/**
 * 在归档根之下枚举时间戳目录（最多 `MEMBER_ARCHIVE_STAMP_MAX_DEPTH` 层）：
 * 符合两种合法形状 → 可删除清单；其余时间戳形状 → skipped（不删除、不静默）；
 * 非时间戳空/无关子目录 → skipped（让用户知道归档根下有不合规内容）。
 */
function collectArchiveStamps(
  dir: string,
  level: number,
  rootDepth: number,
  sessionId: string | null,
  ctx: ArchiveScanContext
): void {
  for (const name of listDirectoryNames(dir, { includeSymlinks: true })) {
    const path = join(dir, name);
    const stat = lstatOrNull(path);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      ctx.scan.skipped.push({ path, reason: "条目是符号链接，已跳过" });
      continue;
    }
    if (!stat.isDirectory()) {
      ctx.scan.skipped.push({ path, reason: "条目不是目录，已跳过" });
      continue;
    }

    if (ARCHIVE_DIR_PATTERN.test(name)) {
      if (rootDepth <= MEMBER_ARCHIVE_ROOT_MAX_DEPTH && isSafeArchiveEntry(ctx.rootDir, path)) {
        const bytes = directoryBytes(path);
        ctx.scan.entries.push({
          teamName: ctx.teamName,
          sessionId,
          memberName: basename(dir),
          path,
          bytes,
          mtimeMs: stat.mtimeMs,
        });
        ctx.scan.totalBytes += bytes;
        ctx.teams.add(ctx.teamName);
        ctx.sessions.add(`${ctx.teamName}\u0000${sessionId ?? ""}`);
      } else {
        ctx.scan.skipped.push({
          path,
          reason:
            "归档路径非标准层级（可能来自含路径分隔符的成员名或超出扫描深度），已跳过不删除",
        });
      }
      continue; // 不进入时间戳目录
    }

    if (level < MEMBER_ARCHIVE_STAMP_MAX_DEPTH) {
      const before = ctx.scan.entries.length + ctx.scan.skipped.length;
      collectArchiveStamps(path, level + 1, rootDepth, sessionId, ctx);
      if (ctx.scan.entries.length + ctx.scan.skipped.length === before) {
        // 非时间戳且内部没有任何归档 → 不合规条目（成员目录里的空/垃圾子目录）
        ctx.scan.skipped.push({ path, reason: "不合规的归档条目（无时间戳子目录），已跳过" });
      }
    } else {
      // 超出成员分组探测层级：可能是多级分隔符的成员名，报告但不删除。
      ctx.scan.skipped.push({
        path,
        reason: "超出归档扫描深度（成员分组层级过多），已跳过不删除",
      });
    }
  }
}

/**
 * 形状校验（导出供单测）：只接受
 *   <root>/sessions/<团队>/.member-resets/<成员>/<时间戳>
 *   <root>/sessions/<团队>/<会话>/.member-resets/<成员>/<时间戳>
 * 成员/会话段不得含路径分隔符；时间戳匹配 `^\d{8}-\d{6}(-\d+)?$`。
 */
export function isSafeArchiveEntry(rootDir: string, entryPath: string): boolean {
  const sessionsRoot = resolve(join(rootDir, "sessions"));
  const resolved = resolve(entryPath);
  const rel = relative(sessionsRoot, resolved);
  if (!rel || rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;

  const parts = rel.split(sep);
  let team: string;
  let sessionId: string | undefined;
  let member: string;
  let stamp: string;
  if (parts.length === 5) {
    [team, sessionId, member, stamp] = [parts[0], parts[1], parts[3], parts[4]];
    if (parts[2] !== MEMBER_ARCHIVE_ROOT) return false;
  } else if (parts.length === 4) {
    [team, member, stamp] = [parts[0], parts[2], parts[3]];
    if (parts[1] !== MEMBER_ARCHIVE_ROOT) return false;
  } else {
    return false;
  }

  return (
    isSafeName(team) &&
    (sessionId === undefined || isSafeName(sessionId)) &&
    isSafeName(member) &&
    ARCHIVE_DIR_PATTERN.test(stamp)
  );
}

function isSafeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes(sep)
  );
}

export interface ArchiveCleanupResult {
  deleted: string[];
  failed: Array<{ path: string; reason: string }>;
  freedBytes: number;
}

/**
 * 删除扫描结果中的归档目录。逐条复核形状、符号链接与真实路径（父目录可能被换成
 * 链接）；单个失败只影响该条并在 `failed` 里给出原因，绝不抛出。空 `.member-resets`
 * 与其下空成员目录顺手清理，非空父目录保留。
 */
export function deleteMemberSessionArchives(scan: ArchiveScan): ArchiveCleanupResult {
  const deleted: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  let freedBytes = 0;

  let sessionsRootReal = "";
  try {
    sessionsRootReal = realpathSync(join(scan.rootDir, "sessions"));
  } catch {
    sessionsRootReal = "";
  }

  for (const entry of scan.entries) {
    try {
      if (!isSafeArchiveEntry(scan.rootDir, entry.path)) {
        failed.push({
          path: entry.path,
          reason: "路径形状不合规（不在 <数据目录>/sessions 的归档形状内），已跳过",
        });
        continue;
      }
      const stat = lstatSync(entry.path);
      if (stat.isSymbolicLink()) {
        failed.push({ path: entry.path, reason: "条目是符号链接，已跳过" });
        continue;
      }
      if (!stat.isDirectory()) {
        failed.push({ path: entry.path, reason: "条目不是目录，已跳过" });
        continue;
      }
      const real = realpathSync(entry.path);
      if (
        !sessionsRootReal ||
        !(real === sessionsRootReal || real.startsWith(sessionsRootReal + sep))
      ) {
        failed.push({ path: entry.path, reason: "真实路径不在 <数据目录>/sessions 内，已跳过" });
        continue;
      }
      rmSync(entry.path, { recursive: true, force: false });
      deleted.push(entry.path);
      freedBytes += entry.bytes;
      removeEmptyArchiveParents(entry.path);
    } catch (err) {
      failed.push({ path: entry.path, reason: errorReason(err) });
    }
  }

  return { deleted, failed, freedBytes };
}

/** 只删空的 <成员> 目录与空 `.member-resets`；非空即保留（rmdir 抛错即止）。 */
function removeEmptyArchiveParents(entryPath: string): void {
  const memberDir = dirname(entryPath);
  const archiveRoot = dirname(memberDir);
  for (const dir of [memberDir, archiveRoot]) {
    try {
      rmdirSync(dir);
    } catch {
      /* 非空或已不存在：保留 */
    }
  }
}

/** 纯函数：预览文案（最多 maxLines 条路径，其余折叠）。 */
export function formatArchiveScanPreview(scan: ArchiveScan, maxLines = 6): string {
  const scope = scan.teamName ? `团队 "${scan.teamName}"` : "全部团队";
  const lines = [
    `成员重启归档（范围：${scope}）`,
    `- ${scan.teamCount} 个团队 / ${scan.sessionCount} 个会话 / ${scan.entries.length} 个归档 / 合计 ${formatBytes(scan.totalBytes)}`,
  ];
  const shown = scan.entries.slice(0, Math.max(0, maxLines));
  for (const entry of shown) lines.push(`- 目录：${entry.path}`);
  const hidden = scan.entries.length - shown.length;
  if (hidden > 0) lines.push(`- 目录：…（另有 ${hidden} 个）`);

  if (scan.skipped.length > 0) {
    lines.push(`- 跳过 ${scan.skipped.length} 个不合规或不可读条目（未删除）：`);
    const shownSkipped = scan.skipped.slice(0, Math.max(0, maxLines));
    for (const item of shownSkipped) lines.push(`  · ${item.path}（${item.reason}）`);
    const hiddenSkipped = scan.skipped.length - shownSkipped.length;
    if (hiddenSkipped > 0) lines.push(`  · …（另有 ${hiddenSkipped} 个）`);
  }

  lines.push("只清理 .member-resets 下的归档；团队定义、会话历史、共享上下文不受影响。");
  return lines.join("\n");
}

/** 纯函数：清理结果文案（含失败明细与释放空间；`skipped` 可附带扫描阶段的跳过项）。 */
export function formatArchiveCleanupResult(
  result: ArchiveCleanupResult,
  skipped: Array<{ path: string; reason: string }> = []
): string {
  const lines: string[] = [];
  if (result.deleted.length === 0 && result.failed.length === 0) {
    lines.push("没有可清理的成员重启归档。");
  } else {
    lines.push(
      `✅ 已清理 ${result.deleted.length} 个归档目录，释放 ${formatBytes(result.freedBytes)}。`
    );
    if (result.failed.length > 0) {
      lines.push(`⚠️ ${result.failed.length} 个未能删除：`);
      for (const failure of result.failed) {
        lines.push(`- ${failure.path}（${failure.reason}）`);
      }
    }
  }
  if (skipped.length > 0) {
    lines.push(`跳过 ${skipped.length} 个不合规或不可读条目（未删除）：`);
    for (const item of skipped) lines.push(`- ${item.path}（${item.reason}）`);
  }
  return lines.join("\n");
}

/** 列目录名（升序）；不存在/不可读 → []。默认只看真实目录，不跟符号链接；
 * 归档候选枚举时打开 includeSymlinks——符号链接条目必须被看见才能跳过并报告。 */
function listDirectoryNames(dir: string, opts?: { includeSymlinks?: boolean }): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() || (opts?.includeSymlinks === true && entry.isSymbolicLink())
    )
    .map((entry) => entry.name)
    .sort();
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
