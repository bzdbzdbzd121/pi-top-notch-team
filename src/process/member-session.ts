import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
