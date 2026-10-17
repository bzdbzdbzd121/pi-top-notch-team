/**
 * 进程级同步锁（方案 §7.A / §7.D 前置条件）。
 *
 * 同一时刻只允许一个同步流程（含人工在终端跑 git 的场景由 git 自身的
 * `index.lock` 兜底）。锁文件为 `<rootDir>/sync.lock`，内容记录 pid、
 * 起始时间、主机名与随机 token：
 *  - pid 仍存活 → 锁有效，后来者拿到「另一实例正在同步」的可读提示；
 *  - pid 已死（上次异常退出）→ 判定陈旧，可被安全夺取；
 *  - 来自其它主机的锁无法校验 pid → 保守视为有效（不夺取）。
 *
 * 加锁必须**原子且带完整内容**：先把锁信息写进同目录候选文件，再用
 * `linkSync` 抢占目标路径（已存在 → EEXIST）。这样锁文件一旦出现就是完整
 * JSON，不会出现「open 成功但内容未写完」的窗口被读者误判陈旧而夺取
 * （审查 #2 的并发缺陷）。夺取陈旧锁用 rename 抢占（只有一个进程能成功）。
 */
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * 不可解析的锁文件在创建后多久内仍保守视为「有人正在创建」（毫秒）。
 * 正常路径下不会出现不可解析的锁（原子 link 创建）；此宽限只用于兜底
 * 文件系统不支持硬链接时的降级写入、以及旧版本残留的中间态。
 */
const LOCK_CREATE_GRACE_MS = 2_000;

export interface SyncLockInfo {
  /** 持有锁的进程 pid。 */
  pid: number;
  /** 获取时间（ISO 8601）。 */
  startedAt: string;
  /** 持有锁的主机名（跨主机共享目录时无法校验 pid，保守处理）。 */
  hostname: string;
  /**
   * 随机身份 token。同进程同毫秒可能生成相同 pid+startedAt，token 用于
   * 区分「我的锁」与「别人的锁」（release 不误删）。
   */
  token: string;
}

export interface SyncLock {
  readonly path: string;
  readonly info: SyncLockInfo;
  /** 释放锁；幂等，且不会误删已被他人接手的锁。 */
  release(): void;
}

export type AcquireSyncLockResult =
  | { ok: true; lock: SyncLock }
  | { ok: false; reason: "held"; holder: SyncLockInfo | null }
  | { ok: false; reason: "error"; error: string };

export function getSyncLockPath(rootDir: string): string {
  return join(rootDir, "sync.lock");
}

/**
 * pid 是否存活。`EPERM` 表示进程存在但当前用户无权发信号 → 视为存活；
 * 其余错误（`ESRCH` / 非法参数）→ 不存活。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 读取锁文件；缺失/损坏/字段非法 → null。
 * 旧格式（无 token）按空 token 读取，兼容读取但不影响新锁的身份校验。
 */
export function readSyncLock(path: string): SyncLockInfo | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof data !== "object" || data === null) return null;
    const { pid, startedAt, hostname: host, token } = data as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof startedAt !== "string" || startedAt.length === 0) return null;
    if (typeof host !== "string" || host.length === 0) return null;
    return { pid, startedAt, hostname: host, token: typeof token === "string" ? token : "" };
  } catch {
    return null;
  }
}

/**
 * 陈旧判定（纯函数，可注入 pidAlive/hostname）：
 * 信息不可读、或本机且 pid 已死 → 陈旧；其它主机 → 不能校验，视为不陈旧。
 */
export function isSyncLockStale(
  info: SyncLockInfo | null,
  options?: { hostname?: string; pidAlive?: (pid: number) => boolean }
): boolean {
  if (!info) return true;
  const localHostname = options?.hostname ?? hostname();
  if (info.hostname !== localHostname) return false;
  const pidAlive = options?.pidAlive ?? isProcessAlive;
  return !pidAlive(info.pid);
}

/**
 * 原子独占创建：候选文件写全 → `linkSync` 到目标（已存在 → EEXIST）。
 * 不支持硬链接的文件系统降级为 `wx` 直写（会重新引入极小的中间态窗口，
 * 由 acquire 的新鲜度宽限兜底）。
 */
function createLockFile(path: string, info: SyncLockInfo): boolean {
  const content = JSON.stringify(info);
  const candidate = `${path}.candidate-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(candidate, content, { encoding: "utf-8", mode: 0o600 });
    try {
      linkSync(candidate, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      try {
        writeFileSync(path, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
        return true;
      } catch (fallbackErr) {
        if ((fallbackErr as NodeJS.ErrnoException).code === "EEXIST") {
          return false;
        }
        throw fallbackErr;
      }
    }
  } finally {
    rmSync(candidate, { force: true });
  }
}

/** 文件存在且「刚创建不久」（不可解析时的保守判定，防止抢走正在创建的锁）。 */
function isFreshlyCreated(path: string): boolean {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return false;
    return Date.now() - stat.mtimeMs < LOCK_CREATE_GRACE_MS;
  } catch {
    return false;
  }
}

function makeLock(path: string, info: SyncLockInfo): SyncLock {
  let released = false;
  return {
    path,
    info,
    release(): void {
      if (released) return;
      released = true;
      const current = readSyncLock(path);
      // 只释放「自己的」锁：token + pid 身份校验，锁被陈旧夺取或替换后
      // 不得误删他人的锁（审查 #8：pid+毫秒时间戳不足以区分同毫秒场景）。
      // read 与 unlink 之间无合法夺取窗口：pid 存活时其它进程不会判定陈旧；
      // 剩余风险仅限人为强制替换，token 校验已把这类的误删概率降到 0。
      if (!current || current.pid !== info.pid || current.token !== info.token) {
        return;
      }
      try {
        unlinkSync(path);
      } catch {
        /* 已不存在 */
      }
    },
  };
}

/**
 * 获取同步锁。rootDir 不存在时自动创建。
 * 失败原因：`held`（另一实例运行中，附持有者信息；holder=null 表示锁文件
 * 存在但暂时不可读）/ `error`（文件系统问题）。
 */
export function acquireSyncLock(rootDir: string): AcquireSyncLockResult {
  const path = getSyncLockPath(rootDir);
  const info: SyncLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    token: randomBytes(12).toString("hex"),
  };

  try {
    mkdirSync(rootDir, { recursive: true });

    if (createLockFile(path, info)) {
      return { ok: true, lock: makeLock(path, info) };
    }

    const holder = readSyncLock(path);
    if (holder === null) {
      // 不可解析：正常路径不可能（创建是原子的）。可能是降级写入/旧版本的
      // 中间态——刚创建的文件保守视为「有人正在创建」，不夺取。
      if (isFreshlyCreated(path)) {
        return { ok: false, reason: "held", holder: null };
      }
    } else if (!isSyncLockStale(holder)) {
      return { ok: false, reason: "held", holder };
    }

    // 陈旧锁：先原子改名抢占（只有一个进程能成功），再创建新锁
    const retirePath = `${path}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(path, retirePath);
    } catch {
      /* 已被其它进程接手：继续尝试创建，失败则如实返回 held */
    }
    rmSync(retirePath, { force: true });

    if (createLockFile(path, info)) {
      return { ok: true, lock: makeLock(path, info) };
    }
    return { ok: false, reason: "held", holder: readSyncLock(path) };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
