import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

describe("cleanupSyncResiduals（阶段 2 待办：硬杀残留清理）", () => {
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

  it("清理临时索引 / 配置临时文件 / 锁候选 / 工作区 tmp；不动 index.lock", () => {
    const gitDir = join(ctx.teamsDir, ".git");
    const files = [
      join(gitDir, "sync-index-123-1"),
      join(rootDir, "sync.yaml.tmp-999"),
      join(rootDir, "sync.lock.candidate-1-abcd"),
      join(ctx.teamsDir, "a.yaml.tmp-999"),
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
