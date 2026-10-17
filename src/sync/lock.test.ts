import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  acquireSyncLock,
  getSyncLockPath,
  isProcessAlive,
  isSyncLockStale,
  readSyncLock,
  type SyncLockInfo,
} from "./lock";

/** 取得一个已退出并被回收的 pid（用于「陈旧锁」场景）。 */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  return pid;
}

const writeLockFile = (path: string, info: Partial<SyncLockInfo>): void => {
  writeFileSync(
    path,
    JSON.stringify({ pid: 12345, startedAt: new Date().toISOString(), hostname: "test-host", ...info }),
    "utf-8"
  );
};

describe("isProcessAlive", () => {
  it("本进程存活", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("非法 pid（<=0 / NaN）视为不存活", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });

  it("已退出的进程不存活", async () => {
    const pid = await reapedPid();
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe("isSyncLockStale（陈旧判定，纯函数）", () => {
  const info: SyncLockInfo = { pid: 4242, startedAt: "2026-01-01T00:00:00.000Z", hostname: "host-a" };

  it("pid 不存活 → 陈旧", () => {
    expect(isSyncLockStale(info, { hostname: "host-a", pidAlive: () => false })).toBe(true);
  });

  it("pid 存活 → 不陈旧", () => {
    expect(isSyncLockStale(info, { hostname: "host-a", pidAlive: () => true })).toBe(false);
  });

  it("锁信息不可读（损坏）→ 陈旧", () => {
    expect(isSyncLockStale(null, { hostname: "host-a", pidAlive: () => true })).toBe(true);
  });

  it("来自其它主机的锁 → 保守视为不陈旧（无法校验远端 pid）", async () => {
    const pid = await reapedPid();
    expect(isSyncLockStale({ ...info, pid, hostname: "other-host" }, { hostname: "host-a" })).toBe(false);
  });
});

describe("acquireSyncLock / release", () => {
  let rootDir: string;
  let lockPath: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "sync-lock-test-"));
    lockPath = getSyncLockPath(rootDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("锁文件路径为 <rootDir>/sync.lock", () => {
    expect(lockPath).toBe(join(rootDir, "sync.lock"));
  });

  it("首次获取成功并写入 pid/时间/主机名", () => {
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const info = readSyncLock(lockPath)!;
    expect(info.pid).toBe(process.pid);
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(info.startedAt))).toBe(false);
    expect(result.lock.info.pid).toBe(process.pid);
  });

  it("rootDir 不存在时自动创建", () => {
    const nested = join(rootDir, "nested");
    expect(acquireSyncLock(nested).ok).toBe(true);
    expect(existsSync(getSyncLockPath(nested))).toBe(true);
  });

  it("已被持有 → 获取失败并返回持有者信息", () => {
    const first = acquireSyncLock(rootDir);
    expect(first.ok).toBe(true);

    const second = acquireSyncLock(rootDir);
    expect(second.ok).toBe(false);
    if (second.ok || second.reason !== "held") {
      throw new Error(`expected held, got ${JSON.stringify(second)}`);
    }
    expect(second.holder?.pid).toBe(process.pid);

    if (first.ok) first.lock.release();
  });

  it("释放后可重新获取", () => {
    const first = acquireSyncLock(rootDir);
    expect(first.ok).toBe(true);
    if (first.ok) first.lock.release();
    expect(existsSync(lockPath)).toBe(false);

    const second = acquireSyncLock(rootDir);
    expect(second.ok).toBe(true);
    if (second.ok) second.lock.release();
  });

  it("重复释放是幂等的", () => {
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.lock.release();
    expect(() => result.lock.release()).not.toThrow();
  });

  it("陈旧锁（pid 已死）可被夺取", async () => {
    const deadPid = await reapedPid();
    writeLockFile(lockPath, { pid: deadPid, hostname: hostname() });

    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    const info = readSyncLock(lockPath)!;
    expect(info.pid).toBe(process.pid);
    // 夺取过程不留 .stale-* 残留
    expect(readdirSync(rootDir).filter((f) => f.includes(".stale-"))).toEqual([]);
    if (result.ok) result.lock.release();
  });

  it("损坏的锁文件按陈旧处理（可夺取）", () => {
    writeFileSync(lockPath, "not-json{{{", "utf-8");
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    if (result.ok) result.lock.release();
  });

  it("来自其它主机的锁不会被夺取（保守失败）", () => {
    writeLockFile(lockPath, { pid: 2147483646, hostname: "some-other-host" });
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "held") {
      throw new Error(`expected held, got ${JSON.stringify(result)}`);
    }
    expect(result.holder?.hostname).toBe("some-other-host");
  });

  it("释放不会删除已被他人接手/替换的锁", () => {
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 模拟锁被替换为另一个进程的锁
    writeLockFile(lockPath, { pid: 999999, hostname: "test-host" });
    result.lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readSyncLock(lockPath)!.pid).toBe(999999);
  });

  it("锁文件内容为 JSON（可读回）", () => {
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = readFileSync(lockPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    result.lock.release();
  });
});
