import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { archiveFileName, applySync, isArchiveFileName, syncConflictsDir } from "./apply";
import type { GitResult } from "./git-runner";
import type { GitRun, PlanSnapshot, SyncContext, SyncPlan } from "./plan";

const AT = new Date(2026, 9, 17, 12, 1, 0); // 2026-10-17 12:01:00
const HASH = "[0-9a-f]{8}";

describe("归档目录与命名（偏差 1：复用阶段 4 的规则）", () => {
  it("归档目录固定为 <rootDir>/sync-conflicts（不在 teams/ 内）", () => {
    expect(syncConflictsDir("/home/u/.pi/top-notch-team")).toBe("/home/u/.pi/top-notch-team/sync-conflicts");
    expect(syncConflictsDir("/home/u/.pi/top-notch-team").includes("/teams/")).toBe(false);
  });

  it("命名 = <路径安全化>-<原路径短哈希>.<YYYYMMDD-HHmmss>", () => {
    expect(archiveFileName("README.md", AT)).toMatch(new RegExp(`^README\\.md-${HASH}\\.20261017-120100$`));
    expect(archiveFileName("refactoring.yaml", AT)).toMatch(new RegExp(`^refactoring\\.yaml-${HASH}\\.20261017-120100$`));
  });

  it("不同路径同秒不撞名（中文名必现碰撞的场景；保留可读名）", () => {
    const names = ["a b.txt", "a_b.txt", "说明.md", "指南.md", "我的 团队.txt", "归档文档.txt"].map((p) =>
      archiveFileName(p, AT)
    );
    expect(new Set(names).size).toBe(names.length); // 全部唯一
    expect(names[2]).toMatch(new RegExp(`^说明\\.md-${HASH}\\.20261017-120100$`)); // 中文不被折成 `_md`
    expect(names[4]).toMatch(new RegExp(`^我的 团队\\.txt-${HASH}\\.20261017-120100$`));
  });

  it("同一路径同一秒可用序号兜底（绝不覆盖已有留档）", () => {
    const first = archiveFileName("README.md", AT);
    const second = archiveFileName("README.md", AT, 2);
    expect(second).not.toBe(first);
    expect(second).toMatch(new RegExp(`^README\\.md-${HASH}-2\\.20261017-120100$`));
  });

  it("路径分隔符/非法字符安全化；前导点折叠、结尾点空格去除、空名兜底", () => {
    expect(archiveFileName("sub/notes.md", AT)).toMatch(new RegExp(`^sub_notes\\.md-${HASH}\\.`));
    expect(archiveFileName("weird\\name.yaml", AT)).toMatch(new RegExp(`^weird_name\\.yaml-${HASH}\\.`));
    expect(archiveFileName("../escape.yaml", AT)).toMatch(new RegExp(`^_escape\\.yaml-${HASH}\\.`));
    expect(archiveFileName("a b:c?.yaml", AT)).toMatch(new RegExp(`^a b_c_\\.yaml-${HASH}\\.`));
    expect(archiveFileName("", AT)).toMatch(new RegExp(`^file-${HASH}\\.`));
    expect(archiveFileName("notes.  ", AT)).toMatch(new RegExp(`^notes-${HASH}\\.`));
  });

  it("Windows 保留设备名加前缀规避", () => {
    for (const name of ["CON", "com1", "LPT9.txt", "aux.yaml"]) {
      expect(archiveFileName(name, AT)).toMatch(new RegExp(`^_${name.replace(".", "\\.")}-${HASH}\\.`));
    }
    expect(archiveFileName("console.txt", AT)).toMatch(new RegExp(`^console\\.txt-${HASH}\\.`)); // 非保留名不动
  });

  it("join 后仍位于归档目录内（无路径逃逸）", () => {
    const dir = syncConflictsDir("/root");
    for (const p of ["../escape.yaml", "../../etc/passwd", "/etc/passwd", "..", "."]) {
      expect(join(dir, archiveFileName(p, AT)).startsWith(`${dir}/`)).toBe(true);
    }
  });

  it("isArchiveFileName 识别本规则与阶段 4 形态，拒绝普通文件名", () => {
    expect(isArchiveFileName(archiveFileName("README.md", AT))).toBe(true);
    expect(isArchiveFileName("refactoring.20261017-1201.yaml")).toBe(true);
    expect(isArchiveFileName("说明.md-0a1b2c3d.20261017-120100")).toBe(true);
    expect(isArchiveFileName("README.md")).toBe(false);
    expect(isArchiveFileName("notes.txt")).toBe(false);
    expect(isArchiveFileName("20261017-1201.yaml")).toBe(false);
  });
});

// ── 阶段 4：keep-both 导入的防御分支（复审 #1 第二层 / #6）──────

const okGit = (stdout = ""): GitResult => ({
  ok: true,
  stdout,
  stderr: "",
  code: 0,
  timedOut: false,
  outputLimitExceeded: false,
  command: "git",
});

function teamYamlText(name: string, desc: string): string {
  return stringifyYaml({
    name,
    description: desc,
    members: [{ name: "m1", label: "成员", systemPrompt: "提示" }],
  });
}

function conflictFixture(rootDir: string): { ctx: SyncContext; plan: SyncPlan; snapshot: PlanSnapshot } {
  const teamsDir = join(rootDir, "teams");
  mkdirSync(teamsDir, { recursive: true });
  const remoteYaml = teamYamlText("a", "云端描述");
  const ctx: SyncContext = {
    rootDir,
    teamsDir,
    config: { enabled: true, remoteUrl: "/tmp/remote.git", branch: "" },
    runGit: (async (args: string[]) => {
      if (args[0] === "cat-file") return okGit(remoteYaml);
      // TOCTOU 复核需要与快照一致的引用值（否则会在任何写盘前中止，看不到决策结果）
      if (args[0] === "rev-parse" && args.includes("FETCH_HEAD")) return okGit(`${"r".repeat(40)}\n`);
      if (args[0] === "rev-parse" && args.some((a) => a.startsWith("refs/heads/")))
        return okGit(`${"l".repeat(40)}\n`);
      if (args[0] === "hash-object") return okGit(`${"hl-a"}\n`);
      if (args[0] === "read-tree" || args[0] === "add" || args[0] === "write-tree") return okGit("t".repeat(40));
      return okGit("");
    }) as GitRun,
  };
  const plan: SyncPlan = {
    flags: { firstAttach: false, emptyRemote: false, remoteUrlChanged: false },
    actions: [{ kind: "conflict", path: "a.yaml", options: ["keep-local", "take-remote", "keep-both"] }],
    ignored: { nestedYaml: [], nonYamlLocalModified: [] },
    invalidLocalTeams: [],
    remoteSha: "r".repeat(40),
    branch: "main",
  };
  const snapshot: PlanSnapshot = {
    branch: "main",
    gitDir: join(teamsDir, ".git"),
    remoteSha: "r".repeat(40),
    localSha: "l".repeat(40),
    baseTree: "b".repeat(40),
    remoteTree: "rt".repeat(20),
    localTree: "lt".repeat(20),
    firstAttach: false,
    emptyRemote: false,
    remoteUrlChanged: false,
    baseEntries: [{ path: "a.yaml", mode: "100644", blob: "bl-a" }],
    remoteEntries: [{ path: "a.yaml", mode: "100644", blob: "br-a" }],
    localEntries: [{ path: "a.yaml", mode: "100644", blob: "hl-a" }],
    localFiles: { "a.yaml": { hash: "hl-a", size: 10, mtimeMs: 1 } },
    fingerprints: {},
  };
  writeFileSync(join(teamsDir, "a.yaml"), teamYamlText("a", "本机描述"), "utf-8");
  return { ctx, plan, snapshot };
}

describe("阶段 4 apply 防御：keep-both 导入", () => {
  it("决策缺导入名 → 明确 importError（不静默退化为 keep-local、不写文件）", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "apply-import-"));
    const { ctx, plan, snapshot } = conflictFixture(rootDir);
    const result = await applySync({ ctx, plan, snapshot, decisions: [{ path: "a.yaml", choice: "keep-both" }] });
    const decision = result.summary.conflictDecisions[0];
    expect(decision?.importError).toContain("缺少导入名");
    expect(result.summary.importedTeams).toHaveLength(0);
    expect(readFileSync(join(rootDir, "teams", "a.yaml"), "utf-8")).toContain("本机描述"); // keep-local 语义
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("导入目标已存在 → 不覆盖（仅留档 + importError）", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "apply-import-"));
    const { ctx, plan, snapshot } = conflictFixture(rootDir);
    const existing = join(rootDir, "teams", "a-remote-20261017.yaml");
    writeFileSync(existing, teamYamlText("a-remote-20261017", "既有导入文件"), "utf-8");
    const result = await applySync({
      ctx,
      plan,
      snapshot,
      decisions: [{ path: "a.yaml", choice: "keep-both", importName: "a-remote-20261017" }],
    });
    expect(result.summary.conflictDecisions[0]?.importError).toContain("导入目标已存在");
    expect(readFileSync(existing, "utf-8")).toContain("既有导入文件"); // 未被顶掉
    expect(result.summary.importedTeams).toHaveLength(0);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("缺少决策（冲突未决策）→ 直接中止、零改动", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "apply-import-"));
    const { ctx, plan, snapshot } = conflictFixture(rootDir);
    const result = await applySync({ ctx, plan, snapshot });
    expect(result.ok).toBe(false);
    expect(result.failure?.classification.message).toContain("尚未决策");
    rmSync(rootDir, { recursive: true, force: true });
  });
});
