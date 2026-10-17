import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupSyncResiduals,
  describeSyncFailure,
  hasIndexLock,
  isTopLevelTeamYaml,
  listConflicts,
  listLocalDeletePaths,
  listRemoteDeletePaths,
  listWorktreeFiles,
  manualFailure,
  parseLsTreeZ,
  parseRemoteHeadNames,
  parseSymrefHead,
  type SyncContext,
  type SyncPlan,
} from "./plan";
import type { FileClass } from "./classify";

function makeCtx(rootDir: string): SyncContext {
  return {
    rootDir,
    teamsDir: join(rootDir, "teams"),
    config: { enabled: true, remoteUrl: "/tmp/remote.git", branch: "" },
    runGit: vi.fn(),
  };
}

describe("plan.ts 纯函数", () => {
  it("parseRemoteHeadNames 解析 ls-remote --heads", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/feature/x",
      "",
    ].join("\n");
    expect(parseRemoteHeadNames(stdout)).toEqual(["main", "feature/x"]);
    expect(parseRemoteHeadNames("")).toEqual([]);
  });

  it("parseSymrefHead 解析远端默认分支（空输出 → null，对应 HEAD 悬挂/空仓库）", () => {
    expect(parseSymrefHead("ref: refs/heads/main\tHEAD\n")).toBe("main");
    expect(parseSymrefHead("")).toBeNull();
    expect(parseSymrefHead("aaaaaaaa\tHEAD\n")).toBeNull();
  });

  it("parseLsTreeZ 只取 blob 条目并保留特殊路径", () => {
    const record = (mode: string, type: string, sha: string, path: string): string => `${mode} ${type} ${sha}\t${path}\0`;
    const stdout =
      record("100644", "blob", "aaaa", "我的 团队.yaml") +
      record("040000", "tree", "bbbb", "sub") +
      record("100644", "blob", "cccc", "sub/nested.yaml");
    expect(parseLsTreeZ(stdout)).toEqual([
      { mode: "100644", blob: "aaaa", path: "我的 团队.yaml" },
      { mode: "100644", blob: "cccc", path: "sub/nested.yaml" },
    ]);
  });

  it("isTopLevelTeamYaml 只认顶层 .yaml", () => {
    expect(isTopLevelTeamYaml("a.yaml")).toBe(true);
    expect(isTopLevelTeamYaml("我的 团队.yaml")).toBe(true);
    expect(isTopLevelTeamYaml("sub/a.yaml")).toBe(false);
    expect(isTopLevelTeamYaml("README.md")).toBe(false);
    expect(isTopLevelTeamYaml("a.yaml.bak")).toBe(false);
  });

  it("listWorktreeFiles 递归但排除 .git", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-files-"));
    try {
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "config"), "x");
      writeFileSync(join(dir, "a.yaml"), "x");
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "b.yaml"), "x");
      expect(listWorktreeFiles(dir).sort()).toEqual(["a.yaml", "sub/b.yaml"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败文案含原因与修法；无修法时只有原因", () => {
    expect(describeSyncFailure(manualFailure("出错了", "这么修"))).toBe("出错了。修法：这么修");
    expect(describeSyncFailure({ classification: { kind: "unknown", reason: "unknown", message: "未知", fix: null } })).toBe(
      "未知"
    );
  });
});

describe("plan.ts 计划派生", () => {
  const plan = (actions: FileClass[]): SyncPlan => ({
    flags: { firstAttach: false, emptyRemote: false, remoteUrlChanged: false },
    actions,
    ignored: { nestedYaml: [], nonYamlLocalModified: [] },
    invalidLocalTeams: [],
    remoteSha: "x",
    branch: "main",
  });

  it("listConflicts 只取冲突项及其选项集", () => {
    const p = plan([
      { kind: "local-only", path: "a.yaml" },
      { kind: "conflict", path: "b.yaml", options: ["keep-local", "take-remote", "keep-both"] },
      { kind: "conflict", path: "c.yaml", options: ["keep-local", "take-remote"] },
    ]);
    expect(listConflicts(p)).toEqual([
      { path: "b.yaml", options: ["keep-local", "take-remote", "keep-both"] },
      { path: "c.yaml", options: ["keep-local", "take-remote"] },
    ]);
  });

  it("删除路径划分：本机删 / 云端删；both-deleted 两边都不列入（无提示）", () => {
    const p = plan([
      { kind: "remote-deleted", path: "remote-del.yaml" },
      { kind: "local-deleted", path: "local-del.yaml" },
      { kind: "both-deleted", path: "both-del.yaml" },
    ]);
    expect(listLocalDeletePaths(p)).toEqual(["remote-del.yaml"]);
    expect(listRemoteDeletePaths(p)).toEqual(["local-del.yaml"]);
  });

  it("hasIndexLock 只认真实文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-lock-"));
    try {
      expect(hasIndexLock(dir)).toBe(false);
      writeFileSync(join(dir, "index.lock"), "");
      expect(hasIndexLock(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanupSyncResiduals（孤儿残留清理，审查 #2）", () => {
  let rootDir: string;
  let ctx: SyncContext;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "plan-cleanup-"));
    ctx = makeCtx(rootDir);
    mkdirSync(join(ctx.teamsDir, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  /** 已退出并被回收的 pid（写入进程已死的确定性模拟）。 */
  async function reapedPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    return pid;
  }

  it("清理孤儿残留（写入进程已死）：临时索引/配置 tmp/候选锁/工作区 tmp；不动 index.lock", async () => {
    const pid = await reapedPid();
    const gitDir = join(ctx.teamsDir, ".git");
    const files = [
      join(gitDir, `sync-index-${pid}-1`),
      join(rootDir, `sync.yaml.tmp-${pid}`),
      join(rootDir, `sync.lock.candidate-${pid}-abcd`),
      join(ctx.teamsDir, `a.yaml.tmp-${pid}`),
    ];
    for (const f of files) writeFileSync(f, "x");
    const indexLock = join(gitDir, "index.lock");
    writeFileSync(indexLock, "");
    writeFileSync(join(gitDir, "config"), "keep");

    const removed = cleanupSyncResiduals(ctx);
    expect(removed.sort()).toEqual(files.sort());
    for (const f of files) expect(() => statSync(f)).toThrow();
    expect(statSync(indexLock).isFile()).toBe(true);
    expect(statSync(join(gitDir, "config")).isFile()).toBe(true);
  });

  it("保留合法文件：legit.tmp-1.yaml 与 sub/notes.tmp-keep.md（谓词只认 .tmp-<数字> 结尾）", () => {
    const legitTeam = join(ctx.teamsDir, "legit.tmp-1.yaml");
    mkdirSync(join(ctx.teamsDir, "sub"), { recursive: true });
    const legitNested = join(ctx.teamsDir, "sub", "notes.tmp-keep.md");
    writeFileSync(legitTeam, "name: legit.tmp-1\ndescription: d\nmembers: []\n");
    writeFileSync(legitNested, "notes");

    const removed = cleanupSyncResiduals(ctx);
    expect(removed).toEqual([]);
    expect(statSync(legitTeam).isFile()).toBe(true);
    expect(statSync(legitNested).isFile()).toBe(true);
  });

  it("保留在飞临时文件（pid 存活且新鲜）", () => {
    const inFlight = join(ctx.teamsDir, `a.yaml.tmp-${process.pid}`);
    writeFileSync(inFlight, "x");
    const removed = cleanupSyncResiduals(ctx);
    expect(removed).toEqual([]);
    expect(statSync(inFlight).isFile()).toBe(true);
  });

  it("pid 存活但文件超过宽限期 → 仍按孤儿清理（pid 复用场景）", () => {
    const staleInFlight = join(ctx.teamsDir, `a.yaml.tmp-${process.pid}`);
    writeFileSync(staleInFlight, "x");
    const past = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(staleInFlight, past, past);
    const removed = cleanupSyncResiduals(ctx);
    expect(removed).toEqual([staleInFlight]);
  });

  it("显式传入 gitDir（.git 为文件时也能清理临时索引，审查 #11）", () => {
    const fakeGitDir = join(rootDir, "gitdir");
    mkdirSync(fakeGitDir, { recursive: true });
    const tmpIndex = join(fakeGitDir, "sync-index-999-1");
    writeFileSync(tmpIndex, "x");

    const removed = cleanupSyncResiduals(ctx, { gitDir: fakeGitDir });
    expect(removed).toEqual([tmpIndex]);
  });

  it("陈旧锁残留（.stale-*）超过 24h 才清理；新鲜保留", () => {
    const fresh = join(rootDir, "sync.lock.stale-1-fresh");
    const old = join(rootDir, "sync.lock.stale-1-old");
    writeFileSync(fresh, "x");
    writeFileSync(old, "x");
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(old, past, past);

    cleanupSyncResiduals(ctx);
    expect(statSync(fresh).isFile()).toBe(true);
    expect(() => statSync(old)).toThrow();
  });

  it("空目录/不存在目录不抛错", () => {
    const empty = makeCtx(join(rootDir, "missing"));
    expect(cleanupSyncResiduals(empty)).toEqual([]);
  });
});
