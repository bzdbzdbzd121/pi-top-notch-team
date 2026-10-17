import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { classifyFile, type ConflictOption } from "./classify";
import type { GitResult } from "./git-runner";
import type { GitRun, PlanSnapshot, SyncContext, SyncPlan } from "./plan";
import { validateTeamDefinition } from "../team/schema";
import {
  abandonedSideFor,
  buildImportedTeamYaml,
  conflictChoices,
  conflictEffectFor,
  conflictShapeFor,
  cleanupConflictDiffs,
  decisionSummary,
  formatConflictRpcOverview,
  formatFinalPlanSummary,
  loadConflictDiffs,
  nonInteractiveSyncMessage,
  passthroughOverwritePaths,
  resolveImportNames,
} from "./decide";

// ── 夹具 ───────────────────────────────────────────────────

const TEAM_YAML = (name: string, members = 1): string =>
  stringifyYaml({
    name,
    description: `${name} 描述`,
    members: Array.from({ length: members }, (_, i) => ({
      name: `m${i + 1}`,
      label: `成员${i + 1}`,
      systemPrompt: "你是一个成员。",
    })),
  });

function snapshotWith(input: {
  base?: string[];
  local?: string[];
  remote?: string[];
  files?: Record<string, { hash: string; size: number; mtimeMs: number }>;
}): PlanSnapshot {
  const entry = (path: string, blob: string) => ({ path, mode: "100644", blob });
  const localFiles: PlanSnapshot["localFiles"] = {};
  for (const path of input.local ?? []) {
    localFiles[path] = input.files?.[path] ?? { hash: `h-${path}`, size: 100, mtimeMs: 1_700_000_000_000 };
  }
  return {
    branch: "main",
    gitDir: "/tmp/git",
    remoteSha: "r".repeat(40),
    localSha: "l".repeat(40),
    baseTree: "b".repeat(40),
    remoteTree: "rt".repeat(20),
    localTree: "lt".repeat(20),
    firstAttach: false,
    emptyRemote: false,
    remoteUrlChanged: false,
    baseEntries: (input.base ?? []).map((p) => entry(p, `bl-${p}`)),
    remoteEntries: (input.remote ?? []).map((p) => entry(p, `br-${p}`)),
    localEntries: (input.local ?? []).map((p) => entry(p, `hl-${p}`)),
    localFiles,
    fingerprints: {},
  };
}

const planWith = (paths: string[]): SyncPlan => ({
  flags: { firstAttach: false, emptyRemote: false, remoteUrlChanged: false },
  actions: paths.map((path) => ({ kind: "conflict" as const, path, options: ["keep-local", "take-remote", "keep-both"] as ConflictOption[] })),
  ignored: { nestedYaml: [], nonYamlLocalModified: [] },
  invalidLocalTeams: [],
  remoteSha: "r".repeat(40),
  branch: "main",
});

// ── 冲突形态与选项集（验收 1）────────────────────────────────

describe("阶段 4 冲突形态与选项集", () => {
  it("四种形态判定：两边都改 / 两边新增 / 本机删+云端改 / 本机改+云端删", () => {
    expect(
      conflictShapeFor(snapshotWith({ base: ["a.yaml"], local: ["a.yaml"], remote: ["a.yaml"] }), "a.yaml")
    ).toBe("both-modified");
    expect(conflictShapeFor(snapshotWith({ local: ["a.yaml"], remote: ["a.yaml"] }), "a.yaml")).toBe("add-add");
    expect(conflictShapeFor(snapshotWith({ base: ["a.yaml"], remote: ["a.yaml"] }), "a.yaml")).toBe("delete-modify");
    expect(conflictShapeFor(snapshotWith({ base: ["a.yaml"], local: ["a.yaml"] }), "a.yaml")).toBe("modify-delete");
  });

  it("三选项形态（两边都改 / add-add）给出三选项；删除混合形态只给两个", () => {
    for (const shape of ["both-modified", "add-add"] as const) {
      expect(conflictChoices(shape).map((c) => c.value)).toEqual(["keep-local", "take-remote", "keep-both"]);
    }
    expect(conflictChoices("delete-modify").map((c) => c.value)).toEqual(["take-remote", "keep-local"]);
    expect(conflictChoices("modify-delete").map((c) => c.value)).toEqual(["keep-local", "take-remote"]);
  });

  it("选项顺序与 classify.ts 的真值表输出一致（跨模块一致性锁定）", () => {
    const bothModified = classifyFile({ path: "a.yaml", base: "b", local: "l", remote: "r" });
    const addAdd = classifyFile({ path: "a.yaml", base: null, local: "l", remote: "r" });
    const deleteModify = classifyFile({ path: "a.yaml", base: "b", local: null, remote: "r" });
    const modifyDelete = classifyFile({ path: "a.yaml", base: "b", local: "l", remote: null });
    expect(conflictChoices("both-modified").map((c) => c.value)).toEqual(
      (bothModified as { options: ConflictOption[] }).options
    );
    expect(conflictChoices("add-add").map((c) => c.value)).toEqual(
      (addAdd as { options: ConflictOption[] }).options
    );
    expect(conflictChoices("delete-modify").map((c) => c.value)).toEqual(
      (deleteModify as { options: ConflictOption[] }).options
    );
    expect(conflictChoices("modify-delete").map((c) => c.value)).toEqual(
      (modifyDelete as { options: ConflictOption[] }).options
    );
  });

  it("决策 → 生效动作（写入/索引/导入）全形态", () => {
    expect(conflictEffectFor("both-modified", "keep-local")).toEqual({ write: "none", index: "add", importRemote: false });
    expect(conflictEffectFor("both-modified", "take-remote")).toEqual({ write: "remote", index: "add", importRemote: false });
    expect(conflictEffectFor("both-modified", "keep-both")).toEqual({ write: "none", index: "add", importRemote: true });
    expect(conflictEffectFor("add-add", "take-remote")).toEqual({ write: "remote", index: "add", importRemote: false });
    expect(conflictEffectFor("delete-modify", "take-remote")).toEqual({ write: "remote", index: "add", importRemote: false });
    expect(conflictEffectFor("delete-modify", "keep-local")).toEqual({ write: "none", index: "remove", importRemote: false });
    expect(conflictEffectFor("modify-delete", "keep-local")).toEqual({ write: "none", index: "add", importRemote: false });
    expect(conflictEffectFor("modify-delete", "take-remote")).toEqual({ write: "delete", index: "remove", importRemote: false });
  });

  it("被放弃的一侧（需要留档）判定（验收 2）", () => {
    expect(abandonedSideFor("both-modified", "keep-local")).toBe("remote");
    expect(abandonedSideFor("both-modified", "take-remote")).toBe("local");
    expect(abandonedSideFor("both-modified", "keep-both")).toBe("remote");
    expect(abandonedSideFor("delete-modify", "keep-local")).toBe("remote"); // 保持删除：放弃云端版本
    expect(abandonedSideFor("delete-modify", "take-remote")).toBeNull(); // 恢复云端：本地无内容可留
    expect(abandonedSideFor("modify-delete", "keep-local")).toBeNull(); // 保留本机：云端无内容可留
    expect(abandonedSideFor("modify-delete", "take-remote")).toBe("local"); // 接受删除：放弃本机版本
  });

  it("决策摘要文案含真实后果（三选项含「归档/导入」）", () => {
    expect(decisionSummary("both-modified", "keep-local")).toContain("云端版本");
    expect(decisionSummary("both-modified", "take-remote")).toContain("本机版本");
    expect(decisionSummary("both-modified", "keep-both")).toContain("导为");
    expect(decisionSummary("delete-modify", "keep-local")).toContain("保持删除");
    expect(decisionSummary("modify-delete", "take-remote")).toContain("接受删除");
  });
});

// ── 新团队导入（验收 3）────────────────────────────────────

describe("阶段 4 新团队导入", () => {
  it("唯一名：仅字母数字与连字符，带日期戳；与已有团队/同批导入冲突时追加序号", () => {
    const names = resolveImportNames(
      ["refactoring.yaml", "my team.yaml", "refactoring-remote-20261017.yaml"],
      ["refactoring-remote-20261017"],
      new Date(2026, 9, 17)
    );
    expect(names["refactoring.yaml"]).toBe("refactoring-remote-20261017-2");
    expect(names["my team.yaml"]).toBe("my-team-remote-20261017");
    for (const name of Object.values(names)) {
      expect(name).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });

  it("已有同名团队（含 `X.remote` 形态）不被覆盖：生成唯一名", () => {
    const names = resolveImportNames(["refactoring.yaml"], ["refactoring", "refactoring.remote"], new Date(2026, 9, 17));
    expect(names["refactoring.yaml"]).toBe("refactoring-remote-20261017");
    expect(["refactoring", "refactoring.remote"]).not.toContain(names["refactoring.yaml"]);

    const taken = resolveImportNames(["refactoring.yaml"], ["refactoring-remote-20261017"], new Date(2026, 9, 17));
    expect(taken["refactoring.yaml"]).toBe("refactoring-remote-20261017-2");
  });

  it("导入名避开「远端/基准树已有、本机尚无」的名字（复审必改项 #1）", () => {
    // 远端已有 a-remote-20261017.yaml（A 机同日 keep-both 推送）、本机磁盘没有该文件
    const names = resolveImportNames(["a.yaml"], ["a", "a-remote-20261017"], new Date(2026, 9, 17));
    expect(names["a.yaml"]).toBe("a-remote-20261017-2");
  });

  it("导入名比较大小写不敏感（大小写不敏感文件系统上不会互相覆盖）", () => {
    const names = resolveImportNames(["A.yaml"], ["a-REMOTE-20261017"], new Date(2026, 9, 17));
    expect(names["A.yaml"]).toBe("A-remote-20261017-2");
  });

  it("内部 name 同步改写、其余字段保留、通过 validateTeamDefinition", () => {
    const remote = TEAM_YAML("refactoring", 2);
    const built = buildImportedTeamYaml(remote, "refactoring-remote-20261017");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = JSON.parse(JSON.stringify(built.definition));
    expect(parsed.name).toBe("refactoring-remote-20261017");
    expect(parsed.description).toBe("refactoring 描述");
    expect(parsed.members).toHaveLength(2);
    expect(validateTeamDefinition(parsed).valid).toBe(true);
  });

  it("远端版本不合法（YAML 解析失败 / 校验失败）→ 明确拒绝导入（不写入 teams/）", () => {
    expect(buildImportedTeamYaml("name: [unclosed", "new-team").ok).toBe(false);
    const invalid = buildImportedTeamYaml("name: bad\ndescription: x\nmembers: []\n", "bad-remote-20261017");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toContain("校验");
  });

  it("非字符串 name 的远端内容也拒绝（防注入到 teams/）", () => {
    expect(buildImportedTeamYaml("- 1\n- 2\n", "x-remote-20261017").ok).toBe(false);
  });
});

// ── 完整变更清单与降级文案（验收 4/6）────────────────────

describe("阶段 4 计划确认与降级文案", () => {
  const plan = planWith(["refactoring.yaml", "analyzer.yaml"]);
  const decided = [
    {
      path: "analyzer.yaml",
      shape: "both-modified" as const,
      decision: { path: "analyzer.yaml", choice: "keep-both" as const, importName: "analyzer-remote-20261017" },
    },
    { path: "refactoring.yaml", shape: "both-modified" as const, decision: { path: "refactoring.yaml", choice: "take-remote" as const } },
  ];

  it("未跟踪但同名会被覆盖的非团队文件也进入最终清单（复审建议 #8）", () => {
    const snapshot = snapshotWith({
      local: ["a.yaml", "README.md"],
      remote: ["a.yaml", "README.md"],
      files: { "README.md": { hash: "local-differs", size: 10, mtimeMs: 1 } },
    });
    const managedPlan = planWith(["a.yaml"]);
    const paths = passthroughOverwritePaths(managedPlan, snapshot);
    expect(paths).toEqual(["README.md"]); // 管理路径（a.yaml）不算透传覆盖
    const text = formatFinalPlanSummary(
      managedPlan,
      [{ path: "a.yaml", shape: "both-modified" as const, decision: { path: "a.yaml", choice: "keep-local" as const } }],
      { passthroughOverwrites: paths }
    );
    expect(text).toContain("非团队文件（云端为准，将覆盖本机版本并留档）：README.md");
  });

  it("最终计划摘要列出完整变更清单（含逐项冲突决策与新团队导入）", () => {
    const text = formatFinalPlanSummary(plan, decided);
    expect(text).toContain("云同步计划（分支 main）");
    expect(text).toContain("冲突决策：2");
    expect(text).toContain("analyzer.yaml：两边都留");
    expect(text).toContain("analyzer-remote-20261017");
    expect(text).toContain("refactoring.yaml：采用远端");
    expect(text).toContain("新团队导入：analyzer-remote-20261017");
  });

  it("RPC 降级概览：两侧大小/修改时间 + 可在另一终端执行的查看命令", () => {
    const text = formatConflictRpcOverview({
      path: "refactoring.yaml",
      shape: "both-modified",
      localExists: true,
      localSize: 1234,
      localMtimeMs: new Date(2026, 9, 17, 12, 30).getTime(),
      remoteExists: true,
      remoteSize: 2345,
      diffText: "",
      gitDir: "/root/teams/.git",
      remoteSha: "a".repeat(40),
      teamsDir: "/root/teams",
    });
    expect(text).toContain("refactoring.yaml");
    expect(text).toContain("本机版本：1234 字节");
    expect(text).toContain("云端版本：2345 字节");
    // 复审必改项 #2：工作区就是 teams/ 本身，树路径不带 teams/ 前缀；路径加引号可直接粘贴
    expect(text).toContain(`git --git-dir '/root/teams/.git' show '${"a".repeat(40)}:refactoring.yaml'`);
    expect(text).not.toContain(":teams/refactoring.yaml");
    expect(text).toContain(`cat '/root/teams/refactoring.yaml'`);
  });

  it("含空格/引号的路径在人工命令中可安全粘贴（引号转义）", () => {
    const text = formatConflictRpcOverview({
      path: "my team's.yaml",
      shape: "both-modified",
      localExists: true,
      localSize: 10,
      remoteExists: true,
      remoteSize: 20,
      diffText: "",
      gitDir: "/root/teams dir/.git",
      remoteSha: "b".repeat(40),
      teamsDir: "/root/teams dir",
    });
    expect(text).toContain(`git --git-dir '/root/teams dir/.git' show '${"b".repeat(40)}:my team'\\''s.yaml'`);
  });

  it("非交互拒绝文案的人工命令同样不带 teams/ 前缀", () => {
    const text = nonInteractiveSyncMessage();
    expect(text).toContain("show '<远端提交>:<名字>.yaml'");
    expect(text).not.toContain(":teams/");
  });

  it("无 UI 模式的拒绝文案含人工命令（不静默 no-op）", () => {
    const text = nonInteractiveSyncMessage();
    expect(text).toContain("冲突");
    expect(text).toContain("/team sync status");
    expect(text).toContain("git --git-dir");
  });
});

// ── 差异生成（§7.D 第 2 步）──────────────────────────────

describe("阶段 4 冲突差异生成", () => {
  const gitOk = (stdout: string, code = 0): GitResult => ({
    ok: code === 0,
    stdout,
    stderr: "",
    code,
    timedOut: false,
    outputLimitExceeded: false,
    command: "git diff --no-index",
  });

  it("两侧内容写入系统临时目录，经 `git diff --no-index --no-color` 生成文本（不写 teams/、不写归档目录）", async () => {
    const root = mkdtempSync(join(tmpdir(), "decide-test-"));
    const teamsDir = join(root, "teams");
    const calls: string[][] = [];
    const runGit: GitRun = async (args) => {
      calls.push(args);
      if (args.includes("cat-file")) return gitOk("remote content\n");
      if (args.includes("diff")) return gitOk("--- a\n+++ b\n+云端新增行\n", 1); // 有差异 = exit 1
      return gitOk("");
    };
    const ctx: SyncContext = {
      rootDir: root,
      teamsDir,
      config: { enabled: true, remoteUrl: "/tmp/remote.git", branch: "" },
      runGit,
    };
    const snapshot = snapshotWith({ base: ["a.yaml"], local: ["a.yaml"], remote: ["a.yaml"] });
    const loaded = await loadConflictDiffs({ ctx, snapshot, paths: ["a.yaml"] });
    try {
      const diff = loaded.diffs.get("a.yaml");
      expect(diff?.shape).toBe("both-modified");
      expect(diff?.localExists).toBe(false); // 夹具的 teams/ 目录里没有真实文件
      expect(diff?.remoteExists).toBe(true);
      expect(diff?.remoteSize).toBe(Buffer.byteLength("remote content\n"));
      expect(diff?.diffText).toContain("+云端新增行");
      const diffCall = calls.find((a) => a.includes("diff"));
      expect(diffCall).toBeDefined();
      expect(diffCall).toEqual(expect.arrayContaining(["--no-index", "--no-color"]));
      expect(existsSync(join(root, "sync-conflicts"))).toBe(false); // 不写归档目录
    } finally {
      cleanupConflictDiffs(loaded);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("云端 blob 读取失败 → 显式 error（不再静默按空内容，把「存在」显示成「已删除」）", async () => {
    const root = mkdtempSync(join(tmpdir(), "decide-test-"));
    const runGit: GitRun = async (args) => {
      if (args.includes("cat-file")) {
        return {
          ok: false,
          stdout: "",
          stderr: "fatal: bad object (injected)",
          code: 128,
          timedOut: false,
          outputLimitExceeded: false,
          command: "git cat-file blob <injected>",
        };
      }
      return gitOk("");
    };
    const ctx: SyncContext = {
      rootDir: root,
      teamsDir: join(root, "teams"),
      config: { enabled: true, remoteUrl: "/tmp/remote.git", branch: "" },
      runGit,
    };
    const loaded = await loadConflictDiffs({
      ctx,
      snapshot: snapshotWith({ base: ["a.yaml"], local: ["a.yaml"], remote: ["a.yaml"] }),
      paths: ["a.yaml"],
    });
    try {
      const diff = loaded.diffs.get("a.yaml");
      expect(diff?.remoteExists).toBe(true);
      expect(diff?.error).toContain("读取云端版本失败");
      expect(diff?.diffText).toBe("");
    } finally {
      cleanupConflictDiffs(loaded);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("diff 失败（例如 git 异常）→ 降级为 error，不抛错（视图仍可显示两侧信息）", async () => {
    const root = mkdtempSync(join(tmpdir(), "decide-test-"));
    const runGit: GitRun = async (args) => {
      if (args.includes("cat-file")) return gitOk("remote\n");
      if (args.includes("diff"))
        return { ok: false, stdout: "", stderr: "fatal: bad", code: 128, timedOut: false, outputLimitExceeded: false, command: "git diff" };
      return gitOk("");
    };
    const ctx: SyncContext = {
      rootDir: root,
      teamsDir: join(root, "teams"),
      config: { enabled: true, remoteUrl: "/tmp/remote.git", branch: "" },
      runGit,
    };
    const loaded = await loadConflictDiffs({
      ctx,
      snapshot: snapshotWith({ base: ["a.yaml"], local: ["a.yaml"], remote: ["a.yaml"] }),
      paths: ["a.yaml"],
    });
    try {
      const diff = loaded.diffs.get("a.yaml");
      expect(diff?.error).toBeTruthy();
      expect(diff?.diffText).toBe("");
    } finally {
      cleanupConflictDiffs(loaded);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("本机删除侧按空内容参与 diff（显示为整段删除）", async () => {
    const root = mkdtempSync(join(tmpdir(), "decide-test-"));
    const seen: string[] = [];
    const runGit: GitRun = async (args) => {
      if (args.includes("cat-file")) return gitOk("remote only\n");
      if (args.includes("diff")) {
        // 记录两个临时文件的大小：本机侧应为空
        const paths = args.filter((a) => a.startsWith("/"));
        if (paths[0]) seen.push(String(readFileSync(paths[0], "utf-8").length));
        return gitOk("--- a\n+++ b\n", 1);
      }
      return gitOk("");
    };
    const ctx: SyncContext = {
      rootDir: root,
      teamsDir: join(root, "teams"),
      config: { enabled: true, remoteUrl: "/tmp/remote.git", branch: "" },
      runGit,
    };
    const loaded = await loadConflictDiffs({
      ctx,
      snapshot: snapshotWith({ base: ["a.yaml"], remote: ["a.yaml"] }),
      paths: ["a.yaml"],
    });
    try {
      expect(loaded.diffs.get("a.yaml")?.shape).toBe("delete-modify");
      expect(seen[0]).toBe("0");
    } finally {
      cleanupConflictDiffs(loaded);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
