import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * 锁的并发正确性回归（审查 #2）：通过 mock `linkSync` 在“候选 → 目标”的
 * 原子链接时刻插桩，验证锁文件一旦出现就是完整 JSON——不存在被并发读者
 * 误判陈旧而夺取的中间态窗口。
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

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
    JSON.stringify({ pid: 12345, startedAt: new Date().toISOString(), hostname: "test-host", token: "test-token", ...info }),
    "utf-8"
  );
};

/** 把文件 mtime 拨回过去（越过创建宽限期，模拟真正的陈旧残留）。 */
const backdate = (path: string, ageMs = 60_000): void => {
  const past = new Date(Date.now() - ageMs);
  utimesSync(path, past, past);
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
  const info: SyncLockInfo = {
    pid: 4242,
    startedAt: "2026-01-01T00:00:00.000Z",
    hostname: "host-a",
    token: "tok-a",
  };

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

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(linkSync).mockImplementation(actual.linkSync);

    rootDir = mkdtempSync(join(tmpdir(), "sync-lock-test-"));
    lockPath = getSyncLockPath(rootDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("锁文件路径为 <rootDir>/sync.lock", () => {
    expect(lockPath).toBe(join(rootDir, "sync.lock"));
  });

  it("首次获取成功并写入 pid/时间/主机名/token，无候选文件残留", () => {
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const info = readSyncLock(lockPath)!;
    expect(info.pid).toBe(process.pid);
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(info.startedAt))).toBe(false);
    expect(info.token).toMatch(/^[0-9a-f]{24}$/);
    expect(result.lock.info.pid).toBe(process.pid);
    expect(readdirSync(rootDir).filter((f) => f.includes(".candidate-"))).toEqual([]);
  });

  it("加锁原子性：link 之前候选内容已完整、目标不存在；link 之后立即完整可读（审查 #2 并发窗口回归）", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let sawCompleteCandidate = false;

    vi.mocked(linkSync).mockImplementationOnce((...args: Parameters<typeof actual.linkSync>) => {
      const [candidate, target] = args;
      // 并发观察者视角：目标锁文件尚不存在，候选文件已含完整可解析内容
      expect(actual.existsSync(target)).toBe(false);
      const content = actual.readFileSync(candidate, "utf-8");
      expect(JSON.parse(content)).toMatchObject({ pid: process.pid });
      sawCompleteCandidate = true;
      actual.linkSync(candidate, target);
    });

    const result = acquireSyncLock(rootDir);
    expect(sawCompleteCandidate).toBe(true);
    expect(result.ok).toBe(true);
    // link 返回的瞬间锁文件即完整（不存在“文件存在但内容为空”的窗口）
    expect(readSyncLock(lockPath)).toMatchObject({ pid: process.pid });
    if (result.ok) result.lock.release();
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

  it("陈旧锁（pid 已死）可被夺取，且不留候选/陈旧残留", async () => {
    const deadPid = await reapedPid();
    writeLockFile(lockPath, { pid: deadPid, hostname: hostname() });

    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    const info = readSyncLock(lockPath)!;
    expect(info.pid).toBe(process.pid);
    expect(readdirSync(rootDir).filter((f) => f.includes(".stale-") || f.includes(".candidate-"))).toEqual([]);
    if (result.ok) result.lock.release();
  });

  it("空锁文件（创建中间态）→ 保守视为被持有，不夺取（审查 #2）", () => {
    writeFileSync(lockPath, "", "utf-8"); // 刚创建、内容未写完
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "held") {
      throw new Error(`expected held, got ${JSON.stringify(result)}`);
    }
    expect(result.holder).toBeNull();
    // 锁文件未被改写
    expect(readFileSync(lockPath, "utf-8")).toBe("");
  });

  it("空锁文件超过创建宽限期 → 按陈旧残留夺取", () => {
    writeFileSync(lockPath, "", "utf-8");
    backdate(lockPath);

    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    expect(readSyncLock(lockPath)).toMatchObject({ pid: process.pid });
    if (result.ok) result.lock.release();
  });

  it("损坏但陈旧的锁文件可夺取", () => {
    writeFileSync(lockPath, "not-json{{{", "utf-8");
    backdate(lockPath);

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

  it("释放不会删除已被他人接手/替换的锁（pid+startedAt 相同、token 不同）", () => {
    const result = acquireSyncLock(rootDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 模拟同进程同毫秒的另一把锁（token 不同）接管了该路径
    writeLockFile(lockPath, {
      pid: process.pid,
      startedAt: result.lock.info.startedAt,
      hostname: hostname(),
      token: "another-token",
    });
    result.lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readSyncLock(lockPath)!.token).toBe("another-token");
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
