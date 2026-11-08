/**
 * 阶段 2（方案 §3.2）：成员会话文件的枚举、归档、累计统计与会话状态查询。
 *
 * 归档布局（方案 §3.2.3，结构性地「离开探测范围」——不在成员自己的会话目录内，
 * 所以不依赖任何后缀约定）：
 *   <团队会话目录>/.member-resets/<成员>/<YYYYMMDD-HHMMSS[-n]>/<原相对路径>
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveMemberSessionFiles,
  deleteMemberSessionArchives,
  formatArchiveCleanupResult,
  formatArchiveScanPreview,
  formatBytes,
  isSafeArchiveEntry,
  listMemberSessionFiles,
  probeResumedSession,
  scanMemberSessionArchives,
} from "./member-session";
import { hasSessionFiles } from "./member-process";
import type { MemberProcessHandle } from "./member-process";

describe("listMemberSessionFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "member-session-list-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("目录不存在 → []", () => {
    expect(listMemberSessionFiles(join(dir, "missing"))).toEqual([]);
  });

  it("只有非 .jsonl 文件 → []", () => {
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "state.json"), "{}");
    expect(listMemberSessionFiles(dir)).toEqual([]);
  });

  it("递归列出顶层与嵌套的 .jsonl，relativePath 保留子目录", () => {
    writeFileSync(join(dir, "top.jsonl"), "{}\n");
    mkdirSync(join(dir, "proj", "deep"), { recursive: true });
    writeFileSync(join(dir, "proj", "a.jsonl"), "{}\n");
    writeFileSync(join(dir, "proj", "deep", "b.jsonl"), "{}\n");

    const files = listMemberSessionFiles(dir);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      "proj/a.jsonl",
      "proj/deep/b.jsonl",
      "top.jsonl",
    ]);
    expect(files.every((f) => f.path.startsWith(dir))).toBe(true);
    // 绝对/可直接使用的源路径
    expect(files.find((f) => f.relativePath === "proj/deep/b.jsonl")!.path).toBe(
      join(dir, "proj", "deep", "b.jsonl")
    );
  });

  it("枚举与 hasSessionFiles 一致（同一份遍历实现，双向断言）", () => {
    expect(listMemberSessionFiles(dir)).toEqual([]);
    expect(hasSessionFiles(dir)).toBe(false);

    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "s.jsonl"), "{}\n");
    expect(listMemberSessionFiles(dir).length).toBe(1);
    expect(hasSessionFiles(dir)).toBe(true);
  });
});

describe("archiveMemberSessionFiles", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "member-session-archive-"));
    // 团队会话目录 → 成员自己的会话目录（归档根与成员目录同级）
    sessionDir = join(root, "sessions", "team", "sid", "coder");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const now = new Date(2026, 10, 8, 10, 30, 0); // 2026-11-08 10:30:00（本地时间）

  it("单文件 → 归档目录存在、原文件消失、归档内文件名不变；成员目录内 .jsonl 归零", () => {
    writeFileSync(join(sessionDir, "2026-11-08T02-30-00-000Z_ab12cd34.jsonl"), "{}\n");

    const result = archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });

    expect(result.archiveDir).toBe(
      join(root, "sessions", "team", "sid", ".member-resets", "coder", "20261108-103000")
    );
    expect(existsSync(result.archiveDir!)).toBe(true);
    expect(result.moved).toEqual(["2026-11-08T02-30-00-000Z_ab12cd34.jsonl"]);
    expect(result.failed).toEqual([]);
    // 成员自己的会话目录内不再有 .jsonl（结构性「离开探测范围」）
    expect(listMemberSessionFiles(sessionDir)).toEqual([]);
    expect(
      existsSync(
        join(result.archiveDir!, "2026-11-08T02-30-00-000Z_ab12cd34.jsonl")
      )
    ).toBe(true);
    // 归档根是成员目录的同级，不在成员目录内
    expect(result.archiveDir!.startsWith(sessionDir)).toBe(false);
  });

  it("多文件（含嵌套）全部移动，嵌套保持相对路径", () => {
    writeFileSync(join(sessionDir, "a.jsonl"), "{}\n");
    mkdirSync(join(sessionDir, "proj"), { recursive: true });
    writeFileSync(join(sessionDir, "proj", "b.jsonl"), "{}\n");

    const result = archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });

    expect(result.moved.sort()).toEqual(["a.jsonl", "proj/b.jsonl"]);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(result.archiveDir!, "a.jsonl"))).toBe(true);
    expect(existsSync(join(result.archiveDir!, "proj", "b.jsonl"))).toBe(true);
    expect(listMemberSessionFiles(sessionDir)).toEqual([]);
  });

  it("没有可归档文件 → archiveDir: null、moved: []，且不创建归档目录", () => {
    writeFileSync(join(sessionDir, "notes.txt"), "x");

    const result = archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });

    expect(result.archiveDir).toBeNull();
    expect(result.moved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(
      existsSync(join(root, "sessions", "team", "sid", ".member-resets"))
    ).toBe(false);
  });

  it("同一秒两次归档 → 两个不同时间戳目录，不覆盖", () => {
    writeFileSync(join(sessionDir, "one.jsonl"), "{}\n");
    const first = archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });

    writeFileSync(join(sessionDir, "two.jsonl"), "{}\n");
    const second = archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });

    expect(first.archiveDir).not.toBe(second.archiveDir);
    expect(second.archiveDir!.endsWith("20261108-103000-1")).toBe(true);
    expect(existsSync(join(first.archiveDir!, "one.jsonl"))).toBe(true);
    expect(existsSync(join(second.archiveDir!, "two.jsonl"))).toBe(true);
  });

  it("非 .jsonl 文件留在原地", () => {
    writeFileSync(join(sessionDir, "keep.txt"), "keep");
    writeFileSync(join(sessionDir, "move.jsonl"), "{}\n");

    archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });

    expect(existsSync(join(sessionDir, "keep.txt"))).toBe(true);
    expect(existsSync(join(sessionDir, "move.jsonl"))).toBe(false);
  });

  it("归档失败 → failed 有明细、moved 只含成功项、绝不抛出", () => {
    writeFileSync(join(sessionDir, "ok.jsonl"), "{}\n");
    const result = archiveMemberSessionFiles({
      sessionDir,
      memberName: "coder",
      now,
      // 注入：不存在的源文件（等价于重命名失败）
      files: [
        { relativePath: "ok.jsonl", path: join(sessionDir, "ok.jsonl") },
        { relativePath: "ghost.jsonl", path: join(sessionDir, "ghost.jsonl") },
      ],
    });

    expect(result.moved).toEqual(["ok.jsonl"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].relativePath).toBe("ghost.jsonl");
    expect(result.failed[0].reason.length).toBeGreaterThan(0);
  });

  it("归档后自检：仍残留的 .jsonl 记入 failed（不阻断）", () => {
    writeFileSync(join(sessionDir, "moved.jsonl"), "{}\n");
    writeFileSync(join(sessionDir, "stuck.jsonl"), "{}\n");

    const result = archiveMemberSessionFiles({
      sessionDir,
      memberName: "coder",
      now,
      // 只归档其中一个 → 另一个成为残留
      files: [{ relativePath: "moved.jsonl", path: join(sessionDir, "moved.jsonl") }],
    });

    expect(result.moved).toEqual(["moved.jsonl"]);
    expect(result.failed.map((f) => f.relativePath)).toContain("stuck.jsonl");
    expect(existsSync(join(sessionDir, "stuck.jsonl"))).toBe(true);
  });

  it("累计统计：同成员两次归档 → count 2、字节数为两者之和", () => {
    writeFileSync(join(sessionDir, "a.jsonl"), "12345");
    const first = archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });
    expect(first.memberArchiveCount).toBe(1);
    expect(first.memberArchiveBytes).toBe(5);

    writeFileSync(join(sessionDir, "b.jsonl"), "123");
    const second = archiveMemberSessionFiles({ sessionDir, memberName: "coder", now });

    expect(second.memberArchiveCount).toBe(2);
    expect(second.memberArchiveBytes).toBe(8);
  });

  it("归档根与成员会话目录重合（成员名=归档根名）→ 跳过并记入 failed，不抛出、不动文件", () => {
    // 极端情况：动态成员名恰好是 .member-resets，它自己的会话目录就是归档根
    const degenerate = join(root, "sessions", "team", "sid", ".member-resets");
    mkdirSync(degenerate, { recursive: true });
    writeFileSync(join(degenerate, "live.jsonl"), "{}\n");

    const result = archiveMemberSessionFiles({
      sessionDir: degenerate,
      memberName: ".member-resets",
      now,
    });

    expect(result.archiveDir).toBeNull();
    expect(result.moved).toEqual([]);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(existsSync(join(degenerate, "live.jsonl"))).toBe(true);
    expect(readdirSync(degenerate)).toContain("live.jsonl");
  });

  it("成员名越出归档根目录（..）→ 跳过并记入 failed", () => {
    const nested = join(root, "sessions", "team", "sid", "coder");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "a.jsonl"), "{}\n");

    const result = archiveMemberSessionFiles({ sessionDir: nested, memberName: "../evil", now });

    expect(result.moved).toEqual([]);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(existsSync(join(nested, "a.jsonl"))).toBe(true);
  });
});

describe("与其它机制协作（阶段 2 验收）", () => {
  let root: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "member-session-collab-"));
    process.env.TOP_NOTCH_TEAM_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  });

  it("验收 2：归档后的下一次普通启动不再续接（旧文件已离开探测范围）", async () => {
    const { buildMemberConfig } = await import("../setup/member-lifecycle");
    const session = {
      active: true,
      teamDefinition: {
        name: "test-team",
        description: "t",
        members: [{ name: "coder", systemPrompt: "写代码" }],
      },
      startedAt: Date.now(),
      sessionId: "sid",
      sharedContextWritten: true,
      origin: "user" as const,
    };

    const before = buildMemberConfig("coder", session)!;
    mkdirSync(before.sessionDir, { recursive: true });
    writeFileSync(join(before.sessionDir, "old.jsonl"), "{}\n");
    // 有会话文件 → 自动续接（既有语义）
    expect(buildMemberConfig("coder", session)!.resume).toBe(true);

    // fresh 的归档动作：把旧文件移出成员会话目录
    const archive = archiveMemberSessionFiles({
      sessionDir: before.sessionDir,
      memberName: "coder",
    });
    expect(archive.moved).toEqual(["old.jsonl"]);
    expect(existsSync(archive.archiveDir!)).toBe(true);

    // 此后普通启动（不传 fresh）也是全新会话
    expect(buildMemberConfig("coder", session)!.resume).toBeUndefined();
  });

  it("验收 9：/team delete 删除团队会话目录时归档一并消失", async () => {
    const sessionDir = join(root, "sessions", "team", "sid", "coder");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "a.jsonl"), "{}\n");
    const result = archiveMemberSessionFiles({ sessionDir, memberName: "coder" });
    expect(existsSync(result.archiveDir!)).toBe(true);

    const { deleteTeamSessions } = await import("../team/store");
    expect(deleteTeamSessions("team", root)).toBe(true);

    expect(existsSync(result.archiveDir!)).toBe(false);
    expect(existsSync(sessionDir)).toBe(false);
  });
});

describe("probeResumedSession", () => {  function fakeHandle(sendCommandAndWait: any): MemberProcessHandle {
    return {
      name: "coder",
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue({ name: "coder", pid: 1, status: "running" }),
      onEvent: vi.fn(),
      sendCommand: vi.fn(),
      sendCommandAndWait,
    } as unknown as MemberProcessHandle;
  }

  const response = (data: any, success = true) => ({
    type: "response",
    command: "get_state",
    success,
    data,
  });

  it("messageCount > 0 → resumed（带条数）", async () => {
    const handle = fakeHandle(vi.fn().mockResolvedValue(response({ messageCount: 7, sessionId: "s1" })));
    const probe = await probeResumedSession(handle);
    expect(probe).toEqual({ status: "resumed", messageCount: 7, sessionId: "s1" });
  });

  it("messageCount === 0 → new", async () => {
    const handle = fakeHandle(vi.fn().mockResolvedValue(response({ messageCount: 0 })));
    const probe = await probeResumedSession(handle);
    expect(probe.status).toBe("new");
    expect(probe.messageCount).toBe(0);
  });

  it("success: false → unknown", async () => {
    const handle = fakeHandle(vi.fn().mockResolvedValue(response(undefined, false)));
    expect((await probeResumedSession(handle)).status).toBe("unknown");
  });

  it("查询抛出 / 超时 → unknown（不抛出）", async () => {
    const throwing = fakeHandle(
      vi.fn().mockRejectedValue(new Error('Command to "coder" timed out after 3000ms'))
    );
    await expect(probeResumedSession(throwing)).resolves.toEqual({ status: "unknown" });

    const syncThrow = fakeHandle(
      vi.fn(() => {
        throw new Error("boom");
      })
    );
    await expect(probeResumedSession(syncThrow)).resolves.toEqual({ status: "unknown" });
  });

  it("非 Promise 返回值也能判定（同步值）", async () => {
    const handle = fakeHandle(vi.fn().mockReturnValue(response({ messageCount: 2 })));
    expect((await probeResumedSession(handle)).status).toBe("resumed");
  });

  it("messageCount 非数字 → unknown", async () => {
    const handle = fakeHandle(vi.fn().mockResolvedValue(response({ messageCount: "7" })));
    expect((await probeResumedSession(handle)).status).toBe("unknown");
  });
});

describe("formatBytes", () => {
  it("边界：0 / B / KB / MB / GB / 超大值", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TB");
    // 防御：非法/负值按 0 处理，不输出 NaN
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

// ── 阶段 3：归档扫描 / 删除 / 纯函数格式化（方案 §3.3 / E.1 15-22）──

/** 建一个归档目录：<root>/sessions/<team>[/<sessionId>]/.member-resets/<member>/<stamp>/ */
function writeArchive(
  rootDir: string,
  opts: { team: string; sessionId?: string; member: string; stamp: string; bytes?: number }
): string {
  const base = opts.sessionId
    ? join(rootDir, "sessions", opts.team, opts.sessionId, ".member-resets", opts.member, opts.stamp)
    : join(rootDir, "sessions", opts.team, ".member-resets", opts.member, opts.stamp);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "s.jsonl"), "x".repeat(opts.bytes ?? 10));
  return base;
}

describe("scanMemberSessionArchives", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "member-archive-scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function countsFixture(): string[] {
    return [
      writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000", bytes: 10 }),
      writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-104500", bytes: 20 }),
      writeArchive(root, { team: "teamA", sessionId: "sid2", member: "coder", stamp: "20261108-110000", bytes: 5 }),
      writeArchive(root, { team: "teamB", sessionId: "sid3", member: "worker", stamp: "20261108-120000", bytes: 7 }),
      writeArchive(root, { team: "teamB", sessionId: "sid3", member: "worker", stamp: "20261108-130000", bytes: 3 }),
    ];
  }

  it("跨团队跨会话统计：团队/会话/归档数与合计大小（含旧扁平布局）", () => {
    countsFixture();
    // 旧扁平布局（无 sessionId）
    const flat = writeArchive(root, { team: "legacy", member: "old", stamp: "20261108-140000", bytes: 11 });

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries).toHaveLength(6);
    expect(scan.teamCount).toBe(3);
    // teamA/sid1、teamA/sid2、teamB/sid3、legacy(扁平) = 4 个会话
    expect(scan.sessionCount).toBe(4);
    expect(scan.totalBytes).toBe(10 + 20 + 5 + 7 + 3 + 11);
    const flatEntry = scan.entries.find((e) => e.path === flat)!;
    expect(flatEntry.sessionId).toBeNull();
    expect(flatEntry.teamName).toBe("legacy");
    expect(flatEntry.memberName).toBe("old");
    expect(flatEntry.bytes).toBe(11);
    expect(flatEntry.mtimeMs).toBeGreaterThan(0);
    expect(scan.skipped).toEqual([]);
  });

  it("只读：扫描前后目录快照一致（预览 = 干跑）", () => {
    countsFixture();
    const before = readdirSync(root, { recursive: true }).map(String).sort();
    scanMemberSessionArchives(root);
    const after = readdirSync(root, { recursive: true }).map(String).sort();
    expect(after).toEqual(before);
  });

  it("不合规条目跳过并报告（不中断、不算入删除候选）", () => {
    const memberDir = join(root, "sessions", "t", "sid", ".member-resets", "coder");
    mkdirSync(join(memberDir, "not-a-stamp"), { recursive: true });
    mkdirSync(join(memberDir, "2026-11-08"), { recursive: true });
    writeArchive(root, { team: "t", sessionId: "sid", member: "coder", stamp: "20261108-103000" });

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries).toHaveLength(1);
    expect(scan.skipped.length).toBeGreaterThanOrEqual(2);
    expect(scan.skipped.map((s) => s.path)).toEqual(
      expect.arrayContaining([join(memberDir, "not-a-stamp"), join(memberDir, "2026-11-08")])
    );
    expect(scan.skipped.every((s) => s.reason.length > 0)).toBe(true);
  });

  it("符号链接：时间戳条目本身是链接、成员目录是链接 → 均跳过且不删除", () => {
    const external = join(root, "external");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "s.jsonl"), "x");

    // 条目本身是符号链接
    const memberDirA = join(root, "sessions", "t", "sid", ".member-resets", "coder");
    mkdirSync(memberDirA, { recursive: true });
    symlinkSync(external, join(memberDirA, "20261108-103000"), "dir");

    // 成员目录本身是符号链接
    const archiveRootB = join(root, "sessions", "t2", "sid", ".member-resets");
    mkdirSync(archiveRootB, { recursive: true });
    const externalMember = join(root, "external-member", "deep", "20261108-104500");
    mkdirSync(externalMember, { recursive: true });
    writeFileSync(join(externalMember, "s.jsonl"), "y");
    symlinkSync(join(root, "external-member", "deep"), join(archiveRootB, "worker"), "dir");

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries).toEqual([]);
    expect(scan.skipped.length).toBeGreaterThanOrEqual(2);
    expect(scan.skipped.some((s) => s.path.includes("20261108-103000"))).toBe(true);
    expect(scan.skipped.some((s) => s.path.includes("worker"))).toBe(true);
    // 外部目录毫发无损
    expect(existsSync(join(external, "s.jsonl"))).toBe(true);
    expect(existsSync(join(externalMember, "s.jsonl"))).toBe(true);
  });

  it("按团队过滤：只返回该团队；不存在的团队 → 空结果", () => {
    countsFixture();

    const onlyA = scanMemberSessionArchives(root, { teamName: "teamA" });
    expect(onlyA.entries).toHaveLength(3);
    expect(onlyA.entries.every((e) => e.teamName === "teamA")).toBe(true);
    expect(onlyA.teamCount).toBe(1);

    const missing = scanMemberSessionArchives(root, { teamName: "nope" });
    expect(missing.entries).toEqual([]);
    expect(missing.totalBytes).toBe(0);
    expect(missing.teamCount).toBe(0);

    // 其他团队的归档仍在（扫描本身不删）
    expect(existsSync(join(root, "sessions", "teamB", "sid3", ".member-resets"))).toBe(true);
  });

  it("没有 sessions 目录 → 空结果（不抛错）", () => {
    const scan = scanMemberSessionArchives(join(root, "missing-root"));
    expect(scan.entries).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });
});

describe("isSafeArchiveEntry", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "member-archive-safe-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("合法形状通过（带 sessionId / 扁平布局）", () => {
    expect(
      isSafeArchiveEntry(root, join(root, "sessions", "t", "sid", ".member-resets", "coder", "20261108-103000"))
    ).toBe(true);
    expect(
      isSafeArchiveEntry(root, join(root, "sessions", "t", "sid", ".member-resets", "coder", "20261108-103000-1"))
    ).toBe(true);
    expect(
      isSafeArchiveEntry(root, join(root, "sessions", "t", ".member-resets", "coder", "20261108-103000"))
    ).toBe(true);
  });

  it("拒绝：时间戳不合规 / 成员段不是归档根 / 段数不符", () => {
    expect(
      isSafeArchiveEntry(root, join(root, "sessions", "t", "sid", ".member-resets", "coder", "2026-11-08"))
    ).toBe(false);
    expect(
      isSafeArchiveEntry(root, join(root, "sessions", "t", "sid", "not-archive", "coder", "20261108-103000"))
    ).toBe(false);
    // 成员段带分隔符 → 段数不符
    expect(
      isSafeArchiveEntry(root, join(root, "sessions", "t", "sid", ".member-resets", "a", "b", "20261108-103000"))
    ).toBe(false);
    // 少一段（指向成员目录而不是时间戳目录）
    expect(isSafeArchiveEntry(root, join(root, "sessions", "t", "sid", ".member-resets", "coder"))).toBe(false);
  });

  it("拒绝：<数据目录>/sessions 之外的路径", () => {
    expect(isSafeArchiveEntry(root, join(root, "teams", "t", ".member-resets", "coder", "20261108-103000"))).toBe(
      false
    );
    expect(isSafeArchiveEntry(root, join(tmpdir(), "elsewhere", "20261108-103000"))).toBe(false);
    // 指向 sessions 内但位于归档根之外的普通会话目录
    expect(isSafeArchiveEntry(root, join(root, "sessions", "t", "sid", "coder", "20261108-103000"))).toBe(false);
  });
});

describe("deleteMemberSessionArchives", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "member-archive-delete-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("删除归档并释放字节；空 .member-resets 与空成员目录一并清理", () => {
    writeArchive(root, { team: "t", sessionId: "sid", member: "coder", stamp: "20261108-103000", bytes: 10 });
    writeArchive(root, { team: "t", sessionId: "sid", member: "coder", stamp: "20261108-104500", bytes: 20 });
    const sessionRoot = join(root, "sessions", "t", "sid");
    const scan = scanMemberSessionArchives(root);

    const result = deleteMemberSessionArchives(scan);

    expect(result.deleted).toHaveLength(2);
    expect(result.freedBytes).toBe(30);
    expect(result.failed).toEqual([]);
    expect(existsSync(join(sessionRoot, ".member-resets"))).toBe(false);
    // 会话目录本身与活数据目录不删
    expect(existsSync(sessionRoot)).toBe(true);
  });

  it("父目录非空时保留（只删时间戳目录）", () => {
    const keep = writeArchive(root, { team: "t", sessionId: "sid", member: "worker", stamp: "20261108-110000" });
    const gone = writeArchive(root, { team: "t", sessionId: "sid", member: "coder", stamp: "20261108-103000" });
    mkdirSync(join(root, "sessions", "t", "sid", "coder"), { recursive: true });
    writeFileSync(join(root, "sessions", "t", "sid", "coder", "live.jsonl"), "{}\n");
    const scan = scanMemberSessionArchives(root);
    const onlyGone = { ...scan, entries: scan.entries.filter((e) => e.path === gone) };

    const result = deleteMemberSessionArchives(onlyGone);

    expect(result.deleted).toEqual([gone]);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(join(root, "sessions", "t", "sid", ".member-resets"))).toBe(true);
  });

  it("单个失败不中断：其余继续、失败有明细、不抛错", () => {
    const real = writeArchive(root, { team: "t", sessionId: "sid", member: "coder", stamp: "20261108-103000" });
    writeArchive(root, { team: "t", sessionId: "sid", member: "coder", stamp: "20261108-104500" });
    const ghost = join(root, "sessions", "t", "sid", ".member-resets", "coder", "20261108-999999");
    const scan = scanMemberSessionArchives(root);
    // 注入一条已消失的条目（等价于删除失败/竞态）
    const withGhost = {
      ...scan,
      entries: [
        ...scan.entries,
        { teamName: "t", sessionId: "sid", memberName: "coder", path: ghost, bytes: 0, mtimeMs: 0 },
      ],
    };

    const result = deleteMemberSessionArchives(withGhost);

    expect(result.deleted).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe(ghost);
    expect(result.failed[0].reason.length).toBeGreaterThan(0);
    expect(existsSync(real)).toBe(false);
  });

  it("删除前复核形状：越界条目（不在归档根形状内）一律跳过并记入 failed", () => {
    const outside = join(root, "teams", "t", "20261108-103000");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "keep");
    const scan = scanMemberSessionArchives(root); // 空扫描，entries=[]
    const forged = {
      ...scan,
      entries: [
        { teamName: "t", sessionId: null, memberName: "m", path: outside, bytes: 1, mtimeMs: 0 },
      ],
    };

    const result = deleteMemberSessionArchives(forged);

    expect(result.deleted).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});

describe("formatArchiveScanPreview / formatArchiveCleanupResult", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "member-archive-format-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function scanOf(paths: string[], opts: { teamName?: string; skipped?: Array<{ path: string; reason: string }> } = {}) {
    return {
      rootDir: root,
      teamName: opts.teamName,
      entries: paths.map((path, index) => ({
        teamName: "t",
        sessionId: "sid",
        memberName: "coder",
        path,
        bytes: 10,
        mtimeMs: index,
      })),
      totalBytes: paths.length * 10,
      teamCount: paths.length > 0 ? 1 : 0,
      sessionCount: paths.length > 0 ? 1 : 0,
      skipped: opts.skipped ?? [],
    };
  }

  it("预览：范围、计数与大小、最多 6 条路径并折叠其余", () => {
    const paths = Array.from({ length: 9 }, (_, i) => join(root, "sessions", "t", "sid", ".member-resets", "coder", `20261108-10${i}000`));
    const text = formatArchiveScanPreview(scanOf(paths));

    expect(text).toContain("成员重启归档（范围：全部团队）");
    expect(text).toContain("1 个团队 / 1 个会话 / 9 个归档 / 合计 90 B");
    expect(text).toContain(paths[0]);
    expect(text).toContain(paths[5]);
    expect(text).not.toContain(paths[6]);
    expect(text).toContain("另有 3 个");
    expect(text).toContain("只清理 .member-resets 下的归档；团队定义、会话历史、共享上下文不受影响。");
  });

  it("预览：指定团队范围 + 跳过条目提示", () => {
    const text = formatArchiveScanPreview(
      scanOf([join(root, "sessions", "t", "sid", ".member-resets", "coder", "20261108-103000")], {
        teamName: "t",
        skipped: [{ path: join(root, "sessions", "t", "sid", ".member-resets", "coder", "bad"), reason: "形状不合规" }],
      })
    );

    expect(text).toContain('成员重启归档（范围：团队 "t"）');
    expect(text).toContain("跳过 1 个不合规或不可读条目（未删除）");
  });

  it("结果文案：成功 / 含失败明细 / 无归档", () => {
    expect(
      formatArchiveCleanupResult({ deleted: [join(root, "a"), join(root, "b")], failed: [], freedBytes: 20 })
    ).toContain("✅ 已清理 2 个归档目录，释放 20 B。");

    const withFailure = formatArchiveCleanupResult({
      deleted: [join(root, "a")],
      failed: [{ path: join(root, "c"), reason: "EBUSY: resource busy" }],
      freedBytes: 10,
    });
    expect(withFailure).toContain("已清理 1 个归档目录");
    expect(withFailure).toContain("⚠️ 1 个未能删除");
    expect(withFailure).toContain(join(root, "c"));
    expect(withFailure).toContain("EBUSY: resource busy");

    expect(formatArchiveCleanupResult({ deleted: [], failed: [], freedBytes: 0 })).toBe(
      "没有可清理的成员重启归档。"
    );
  });

  it("结果文案：附带扫描阶段跳过的条目", () => {
    const text = formatArchiveCleanupResult(
      { deleted: [join(root, "a")], failed: [], freedBytes: 10 },
      [{ path: join(root, "bogus"), reason: "形状不合规" }]
    );
    expect(text).toContain("已清理 1 个归档目录");
    expect(text).toContain("跳过 1 个不合规或不可读条目（未删除）");
    expect(text).toContain(join(root, "bogus"));
  });
});

// ── 有界深度扫描（方案 v3：阶段 3 验收第 10 条 / §3.3.3）──
// 完备性要求（深度上限内）：任何时间戳形状的归档目录「要么可删、要么进 skipped」，
// 不存在静默漏见的第三种状态——包括成员名含路径分隔符产生的非标准层级。
describe("scanMemberSessionArchives 有界深度完备性（v3 验收 10）", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "member-archive-depth-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stampDir(...segments: string[]): string {
    const dir = join(root, "sessions", ...segments);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), "x");
    return dir;
  }

  it("非标准层级的归档（成员名含分隔符 → 深一层归档根）计入 skipped，不进删除清单、不删除", () => {
    // <团队>/<会话>/a/.member-resets/a/b/<时间戳>  ← 归档根在 sessions 下第 4 层
    const deep = stampDir("t", "sid", "a", ".member-resets", "a", "b", "20261108-103000");

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries).toEqual([]);
    expect(scan.skipped.map((s) => s.path)).toContain(deep);
    expect(scan.skipped.find((s) => s.path === deep)!.reason).toContain("非标准");
    // 标准条目一个都没有，但报告里有它 —— 不会被说成「什么都没有」
    expect(scan.teamCount).toBe(0);

    const result = deleteMemberSessionArchives(scan);
    expect(result.deleted).toEqual([]);
    expect(existsSync(deep)).toBe(true);
  });

  it("扁平布局下成员名含分隔符（归档根位置看似标准、成员分组多一层）同样计入 skipped", () => {
    // <团队>/a/.member-resets/a/b/<时间戳>  ← 根在第 3 层，但成员分组跨了 2 级
    const nested = stampDir("t", "a", ".member-resets", "a", "b", "20261108-104500");

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries).toEqual([]);
    expect(scan.skipped.map((s) => s.path)).toContain(nested);
    expect(scan.skipped.find((s) => s.path === nested)!.reason).toContain("非标准");
    expect(deleteMemberSessionArchives(scan).deleted).toEqual([]);
    expect(existsSync(nested)).toBe(true);
  });

  it("深度上限之内的标准归档仍正常发现（回归：与 skipped 共存）", () => {
    const standard = stampDir("t", "sid", ".member-resets", "coder", "20261108-103000");
    const deep = stampDir("t", "sid", "a", ".member-resets", "a", "b", "20261108-104500");

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries.map((e) => e.path)).toEqual([standard]);
    expect(scan.skipped.map((s) => s.path)).toContain(deep);
    expect(scan.teamCount).toBe(1);
    expect(scan.sessionCount).toBe(1);
  });

  it("深度上限之外的归档根不被发现、也不会被删除", () => {
    // <团队>/<会话>/a/b/.member-resets/c/<时间戳>  ← 归档根在第 5 层，超出有界深度
    const beyond = stampDir("t", "sid", "a", "b", ".member-resets", "c", "20261108-103000");

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries).toEqual([]);
    expect(scan.skipped.map((s) => s.path)).not.toContain(beyond);
    const result = deleteMemberSessionArchives(scan);
    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(existsSync(beyond)).toBe(true);
    // 上限之内的标准归档不受影响（同一团队里再放一个）
    const standard = stampDir("t", "sid", ".member-resets", "coder", "20261108-105500");
    expect(scanMemberSessionArchives(root).entries.map((e) => e.path)).toEqual([standard]);
  });

  it("成员目录内的空/不合规子目录仍计入 skipped（不中断扫描）", () => {
    const memberDir = join(root, "sessions", "t", "sid", ".member-resets", "coder");
    mkdirSync(join(memberDir, "not-a-stamp"), { recursive: true });
    mkdirSync(join(memberDir, "2026-11-08"), { recursive: true });
    stampDir("t", "sid", ".member-resets", "coder", "20261108-103000");

    const scan = scanMemberSessionArchives(root);

    expect(scan.entries).toHaveLength(1);
    expect(scan.skipped.map((s) => s.path)).toEqual(
      expect.arrayContaining([join(memberDir, "not-a-stamp"), join(memberDir, "2026-11-08")])
    );
  });
});
