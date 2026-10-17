/**
 * 进程级同步锁（方案 §7.A / §7.D 前置条件）。
 *
 * 同一时刻只允许一个同步流程（含人工在终端跑 git 的场景由 git 自身的
 * `index.lock` 兜底）。锁文件为 `<rootDir>/sync.lock`，内容记录 pid、
 * 起始时间与主机名：
 *  - pid 仍存活 → 锁有效，后来者拿到「另一实例正在同步」的可读提示；
 *  - pid 已死（上次异常退出）→ 判定陈旧，可被安全夺取；
 *  - 来自其它主机的锁无法校验 pid → 保守视为有效（不夺取）。
 *
 * 夺取使用 `rename` 抢占（只有一个进程能成功）后再创建新锁，避免两个
 * 进程同时判定陈旧后互相覆盖。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface SyncLockInfo {
  /** 持有锁的进程 pid。 */
  pid: number;
  /** 获取时间（ISO 8601，用于诊断与「释放的是不是自己的锁」校验）。 */
  startedAt: string;
  /** 持有锁的主机名（跨主机共享目录时无法校验 pid，保守处理）。 */
  hostname: string;
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

/** 读取锁文件；缺失/损坏/字段非法 → null（按陈旧处理）。 */
export function readSyncLock(path: string): SyncLockInfo | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof data !== "object" || data === null) return null;
    const { pid, startedAt, hostname: host } = data as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof startedAt !== "string" || startedAt.length === 0) return null;
    if (typeof host !== "string" || host.length === 0) return null;
    return { pid, startedAt, hostname: host };
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

function createLockFile(path: string, info: SyncLockInfo): boolean {
  try {
    // wx = 独占创建：已存在即失败，天然防止两个进程同时写锁
    writeFileSync(path, JSON.stringify(info), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
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
      // 只释放「自己的」锁：锁被陈旧夺取或替换后不得误删他人的锁
      if (!current || current.pid !== info.pid || current.startedAt !== info.startedAt) {
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
 * 失败原因：`held`（另一实例运行中，附持有者信息）/ `error`（文件系统问题）。
 */
export function acquireSyncLock(rootDir: string): AcquireSyncLockResult {
  const path = getSyncLockPath(rootDir);
  const info: SyncLockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };

  try {
    mkdirSync(rootDir, { recursive: true });

    if (createLockFile(path, info)) {
      return { ok: true, lock: makeLock(path, info) };
    }

    const holder = readSyncLock(path);
    if (!isSyncLockStale(holder)) {
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
