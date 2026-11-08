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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  archiveMemberSessionFiles,
  formatBytes,
  listMemberSessionFiles,
  probeResumedSession,
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
