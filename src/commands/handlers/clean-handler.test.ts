/**
 * 阶段 3（方案 §3.3.3 / §5）：/team clean 的编排 —— 预览 → 确认 → 删除 → 汇总。
 * 只删 `.member-resets` 下的归档；不碰团队定义、会话历史、共享上下文、成员会话目录。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClean } from "./clean-handler";
import { scanMemberSessionArchives } from "../../process/member-session";
import { createMockContext } from "../../test/fixtures/mock-extension-api";
import { endSession, startSession } from "../../session/state";

function writeArchive(
  rootDir: string,
  opts: { team: string; sessionId: string; member: string; stamp: string; bytes?: number }
): string {
  const base = join(
    rootDir,
    "sessions",
    opts.team,
    opts.sessionId,
    ".member-resets",
    opts.member,
    opts.stamp
  );
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "s.jsonl"), "x".repeat(opts.bytes ?? 10));
  return base;
}

function notifications(ctx: any): string {
  return (ctx.ui.notify as any).mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

describe("/team clean（阶段 3）", () => {
  let root: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-handler-"));
    process.env.TOP_NOTCH_TEAM_ROOT = root;
    endSession();
  });

  afterEach(() => {
    endSession();
    rmSync(root, { recursive: true, force: true });
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  });

  it("有归档：预览数字与磁盘一致，确认后删除并报告释放空间", async () => {
    const a1 = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000", bytes: 10 });
    const a2 = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-104500", bytes: 20 });
    const b1 = writeArchive(root, { team: "teamB", sessionId: "sid2", member: "worker", stamp: "20261108-110000", bytes: 5 });
    const ctx = createMockContext();

    await handleClean(ctx as any, "");

    const preview = notifications(ctx);
    expect(preview).toContain("2 个团队 / 2 个会话 / 3 个归档 / 合计 35 B");
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "确认清理成员重启归档",
      expect.stringContaining("3 个归档目录")
    );
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "确认清理成员重启归档",
      expect.stringContaining("删除后不可恢复")
    );
    for (const dir of [a1, a2, b1]) {
      expect(existsSync(dir)).toBe(false);
    }
    expect(preview).toContain("已清理 3 个归档目录，释放 35 B");
    // 预览与结果同通道（notify），先给预览再给结果
    const calls = (ctx.ui.notify as any).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toContain("已清理");
  });

  it("取消确认 → 不删除任何东西，提示「已取消清理」", async () => {
    const dir = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000" });
    const ctx = createMockContext();
    (ctx.ui.confirm as any).mockResolvedValue(false);

    await handleClean(ctx as any, "");

    expect(existsSync(dir)).toBe(true);
    expect(notifications(ctx)).toContain("已取消清理");
    expect(notifications(ctx)).not.toContain("已清理");
  });

  it("无归档 → 单条提示，不弹确认框", async () => {
    const ctx = createMockContext();

    await handleClean(ctx as any, "");

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect((ctx.ui.notify as any).mock.calls).toHaveLength(1);
    expect(notifications(ctx)).toContain("没有可清理的成员重启归档。");
  });

  it("只删归档：共享上下文、会话清单、成员会话目录、团队定义全部保留", async () => {
    const sessionRoot = join(root, "sessions", "teamA", "sid1");
    const archiveDir = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000" });
    writeFileSync(join(sessionRoot, ".shared-context.md"), "# ctx\n");
    writeFileSync(join(sessionRoot, "session.json"), "{}\n");
    const memberDir = join(sessionRoot, "coder");
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "live.jsonl"), "{}\n");
    mkdirSync(join(root, "teams"), { recursive: true });
    writeFileSync(join(root, "teams", "teamA.yaml"), "name: teamA\n");
    writeFileSync(join(root, "sync.yaml"), "url: x\n");
    const ctx = createMockContext();

    await handleClean(ctx as any, "");

    expect(existsSync(archiveDir)).toBe(false);
    expect(existsSync(join(sessionRoot, ".shared-context.md"))).toBe(true);
    expect(existsSync(join(sessionRoot, "session.json"))).toBe(true);
    expect(existsSync(join(memberDir, "live.jsonl"))).toBe(true);
    expect(existsSync(join(root, "teams", "teamA.yaml"))).toBe(true);
    expect(existsSync(join(root, "sync.yaml"))).toBe(true);
  });

  it("/team clean <团队> 只清该团队；不存在的团队 → 提示且不动其他团队", async () => {
    const a = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000" });
    const b = writeArchive(root, { team: "teamB", sessionId: "sid2", member: "worker", stamp: "20261108-110000" });
    mkdirSync(join(root, "teams"), { recursive: true });
    writeFileSync(join(root, "teams", "teamA.yaml"), "name: teamA\n");

    const scoped = createMockContext();
    await handleClean(scoped as any, "teamA");
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(notifications(scoped)).toContain('范围：团队 "teamA"');

    const missing = createMockContext();
    await handleClean(missing as any, "nope");
    expect(missing.ui.confirm).not.toHaveBeenCalled();
    expect(notifications(missing)).toContain('团队 "nope" 不存在');
    expect(existsSync(b)).toBe(true);
  });

  it("单个目录删除失败 → 其余继续，结果逐条列出失败原因", async () => {
    const a1 = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000" });
    const a2 = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-104500" });
    const ctx = createMockContext();
    const remove = vi.fn(() => ({
      deleted: [a1],
      failed: [{ path: a2, reason: "EBUSY: resource busy or locked" }],
      freedBytes: 10,
    }));

    await handleClean(ctx as any, "", { remove });

    const text = notifications(ctx);
    expect(text).toContain("已清理 1 个归档目录");
    expect(text).toContain("⚠️ 1 个未能删除");
    expect(text).toContain(a2);
    expect(text).toContain("EBUSY: resource busy or locked");
    // 失败时以 warning 呈现
    const lastCall = (ctx.ui.notify as any).mock.calls.at(-1);
    expect(lastCall[1]).toBe("warning");
  });

  it("会话进行中调用可正常执行（不依赖会话状态）", async () => {
    const dir = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000" });
    startSession({
      name: "teamA",
      description: "d",
      members: [{ name: "coder", systemPrompt: "x" }],
    });
    const ctx = createMockContext();

    await handleClean(ctx as any, "");

    expect(existsSync(dir)).toBe(false);
    expect(notifications(ctx)).toContain("已清理 1 个归档目录");
  });

  it("扫描阶段跳过的条目在预览与结果里都报告，且不会被删除", async () => {
    const good = writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000" });
    const bogus = join(root, "sessions", "teamA", "sid1", ".member-resets", "coder", "not-a-stamp");
    mkdirSync(bogus, { recursive: true });
    const ctx = createMockContext();

    await handleClean(ctx as any, "");

    const text = notifications(ctx);
    expect(text).toContain("跳过 1 个不合规或不可读条目（未删除）");
    expect(text).toContain(bogus);
    expect(existsSync(bogus)).toBe(true);
    expect(existsSync(good)).toBe(false);
  });

  it("/team clean <团队>：存在但无归档 → 明确提示、不弹确认、不动其他团队", async () => {
    const other = writeArchive(root, { team: "teamB", sessionId: "sid2", member: "worker", stamp: "20261108-110000" });
    mkdirSync(join(root, "teams"), { recursive: true });
    writeFileSync(join(root, "teams", "teamA.yaml"), "name: teamA\n");
    const ctx = createMockContext();

    await handleClean(ctx as any, "teamA");

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(notifications(ctx)).toContain('没有可清理的成员重启归档（团队 "teamA"）。');
    expect(existsSync(other)).toBe(true);
  });

  it("注入扫描依赖：预览与确认里的数字同源（scan 返回值）", async () => {
    const fakePath = join(root, "sessions", "teamX", "sid", ".member-resets", "m", "20261108-103000");
    const ctx = createMockContext();
    const scan = vi.fn(() => ({
      rootDir: root,
      entries: [
        { teamName: "teamX", sessionId: "sid", memberName: "m", path: fakePath, bytes: 2048, mtimeMs: 1 },
      ],
      totalBytes: 2048,
      teamCount: 1,
      sessionCount: 1,
      skipped: [],
    }));
    const remove = vi.fn(() => ({ deleted: [fakePath], failed: [], freedBytes: 2048 }));

    await handleClean(ctx as any, "", { scan, remove });

    expect(scan).toHaveBeenCalledWith(root, undefined);
    expect(notifications(ctx)).toContain("1 个团队 / 1 个会话 / 1 个归档 / 合计 2.0 KB");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(notifications(ctx)).toContain("已清理 1 个归档目录，释放 2.0 KB");
  });

  it("真实扫描：确认框里的数量与 scan 返回一致", async () => {
    writeArchive(root, { team: "teamA", sessionId: "sid1", member: "coder", stamp: "20261108-103000" });
    const expected = scanMemberSessionArchives(root);
    const ctx = createMockContext();

    await handleClean(ctx as any, "");

    expect((ctx.ui.confirm as any).mock.calls[0][1]).toContain(
      `${expected.entries.length} 个归档目录`
    );
  });
});
