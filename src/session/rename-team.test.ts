import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyTeamName, type ApplyTeamNameDeps } from "./rename-team";
import { endSession, getSessionState, startSession, addMemberToSession } from "./state";
import { ensureSharedContextFile } from "./shared-context";
import {
  getManifestPath,
  readManifestFile,
  resetManifestRuntimeContext,
  setManifestRuntimeContext,
  syncActiveManifest,
} from "./manifest";
import { buildMemberConfig } from "../setup/member-lifecycle";
import { DEFAULT_SETTINGS } from "../settings/settings";
import type { TeamDefinition } from "../team/definition";

const OLD = "_dynamic_1";
const NEW = "登录重构";
const SID = "s1";

let rootDir: string;

function team(name = OLD): TeamDefinition {
  return {
    name,
    description: "动态团队",
    members: [{ name: "analyst", label: "分析员", systemPrompt: "负责分析" }],
  };
}

function sessionDir(name: string): string {
  return join(rootDir, "sessions", name, SID);
}

function deps(overrides: Partial<ApplyTeamNameDeps> = {}): ApplyTeamNameDeps {
  return {
    rootDir,
    isDynamic: true,
    dynamicPhase: "design",
    hasRunningMember: () => false,
    ...overrides,
  };
}

function startDynamic(name = OLD): void {
  startSession(team(name), { sessionId: SID, origin: "user" });
  setManifestRuntimeContext({ isDynamic: true, dynamicPhase: "design", agentInitiatedTask: null });
  mkdirSync(sessionDir(name), { recursive: true });
  syncActiveManifest();
  ensureSharedContextFile(team(name), SID);
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "rename-team-"));
  process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
  endSession();
  resetManifestRuntimeContext();
});

afterEach(() => {
  endSession();
  resetManifestRuntimeContext();
  rmSync(rootDir, { recursive: true, force: true });
  delete process.env.TOP_NOTCH_TEAM_ROOT;
});

describe("applyTeamName — 成功路径", () => {
  beforeEach(() => startDynamic());

  it("把会话目录搬到新名，状态/清单/目录三处一致，并重写系统 stub", () => {
    const onRenamed = vi.fn();
    const out = applyTeamName(NEW, deps({ onRenamed }));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.name).toBe(NEW);
    expect(out.previousName).toBe(OLD);
    expect(out.moved).toBe(true);
    expect(out.adjusted).toBe(false);
    expect(out.stubRewrite).toBe("rewritten");
    expect(out.dir).toBe(sessionDir(NEW));

    // 内存状态（/team status、下一回合提示词均从这里重建）
    const state = getSessionState();
    expect(state.teamDefinition!.name).toBe(NEW);
    expect(state.sessionId).toBe(SID);
    expect(state.teamDefinition!.members.map((m) => m.name)).toEqual(["analyst"]);

    // 目录 + 旧父目录已空并被清理
    expect(existsSync(sessionDir(NEW))).toBe(true);
    expect(existsSync(join(rootDir, "sessions", OLD))).toBe(false);

    // 清单随目录搬迁并被改写为新名
    const manifest = readManifestFile(getManifestPath(rootDir, NEW, SID));
    expect(manifest?.teamName).toBe(NEW);
    expect(manifest?.sessionId).toBe(SID);
    expect(manifest?.members.map((m) => m.name)).toEqual(["analyst"]);

    // 收尾钩子（index.ts：重绑临时设置目录 + 刷新状态栏）
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(onRenamed).toHaveBeenCalledWith(NEW);

    // 共享上下文仍是系统 stub → 用新名重写
    const stub = readFileSync(join(sessionDir(NEW), ".shared-context.md"), "utf-8");
    expect(stub).toContain(`# Shared Context — ${NEW}`);
    expect(stub).not.toContain(OLD);
  });

  it("幂等：同一名字再调一次 → 成功且 moved=false，无文件系统动作", () => {
    applyTeamName(NEW, deps());
    const before = readdirSync(join(rootDir, "sessions"));
    const onRenamed = vi.fn();

    const out = applyTeamName(NEW, deps({ onRenamed }));

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.moved).toBe(false);
      expect(out.stubRewrite).toBe("not-attempted");
    }
    expect(onRenamed).not.toHaveBeenCalled();
    expect(readdirSync(join(rootDir, "sessions"))).toEqual(before);
    expect(getSessionState().teamDefinition!.name).toBe(NEW);
  });

  it("归一化改变输入时回显最终名并标记 adjusted", () => {
    const out = applyTeamName("v2 订单并发", deps());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.name).toBe("v2-订单并发");
    expect(out.adjusted).toBe(true);
    expect(existsSync(join(rootDir, "sessions", "v2-订单并发", SID))).toBe(true);
    expect(getSessionState().teamDefinition!.name).toBe("v2-订单并发");
  });

  it("旧父目录仍有其它会话时不删除（尽力而为）", () => {
    mkdirSync(join(rootDir, "sessions", OLD, "other-session"), { recursive: true });
    const out = applyTeamName(NEW, deps());
    expect(out.ok).toBe(true);
    expect(existsSync(join(rootDir, "sessions", OLD, "other-session"))).toBe(true);
  });

  it("TL 已写过的共享上下文逐字节不变，并标记 stubRewrite=not-stub", () => {
    const path = join(sessionDir(OLD), ".shared-context.md");
    const custom = "# 自定义共享上下文\n目标：重构登录\n";
    writeFileSync(path, custom, "utf-8");

    const out = applyTeamName(NEW, deps());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.stubRewrite).toBe("not-stub");
    expect(readFileSync(join(sessionDir(NEW), ".shared-context.md"), "utf-8")).toBe(custom);
  });

  it("先 add_dynamic_member 再改名：0 成员时生成的 stub 仍被识别，首行改为新名", () => {
    // Reproduce the review finding: the stub is written at bootstrap with no
    // members; add_dynamic_member grows the roster without rewriting it, so the
    // old byte comparison never matched and the header kept the fallback name.
    endSession();
    resetManifestRuntimeContext();
    const emptyTeam: TeamDefinition = { name: OLD, description: "动态团队", members: [] };
    startSession(emptyTeam, { sessionId: SID, origin: "user" });
    setManifestRuntimeContext({ isDynamic: true, dynamicPhase: "design", agentInitiatedTask: null });
    mkdirSync(sessionDir(OLD), { recursive: true });
    syncActiveManifest();
    ensureSharedContextFile(emptyTeam, SID);
    addMemberToSession({ name: "analyst", label: "分析员", systemPrompt: "负责分析" });
    syncActiveManifest();

    const out = applyTeamName(NEW, deps());

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.stubRewrite).toBe("rewritten");
    const stub = readFileSync(join(sessionDir(NEW), ".shared-context.md"), "utf-8");
    expect(stub.split("\n")[0]).toBe(`# Shared Context — ${NEW}`);
    expect(stub).toContain("- 名称：" + NEW);
    expect(stub).toContain("- analyst（分析员）");
    expect(stub).not.toContain(OLD);
  });

  it("共享上下文文件不存在 → stubRewrite=missing（不虚构原因）", () => {
    rmSync(join(sessionDir(OLD), ".shared-context.md"));
    const out = applyTeamName(NEW, deps());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.stubRewrite).toBe("missing");
    expect(existsSync(join(sessionDir(NEW), ".shared-context.md"))).toBe(false);
  });

  it("改名后 buildMemberConfig 的 --session-dir 落在新目录", () => {
    const out = applyTeamName(NEW, deps());
    expect(out.ok).toBe(true);

    const config = buildMemberConfig("analyst", getSessionState(), { settings: DEFAULT_SETTINGS });
    expect(config).not.toBeNull();
    expect(config!.sessionDir).toBe(join(sessionDir(NEW), "analyst"));
    expect(config!.teamName).toBe(NEW);
    expect(config!.sharedContextPath).toBe(join(sessionDir(NEW), ".shared-context.md"));
  });
});

describe("applyTeamName — 拒绝矩阵（每条零副作用）", () => {
  beforeEach(() => startDynamic());

  /**
   * Run a rejection scenario: setup first (it may create the obstacle), then
   * snapshot, then apply — so the "no side effect" comparison is exact.
   */
  function expectRejected(name: string, setup: () => ApplyTeamNameDeps, code: string, messagePart: string): void {
    const d = setup();
    const beforeDirs = readdirSync(join(rootDir, "sessions"));
    const beforeManifest = existsSync(getManifestPath(rootDir, OLD, SID))
      ? readFileSync(getManifestPath(rootDir, OLD, SID), "utf-8")
      : null;
    const beforeName = getSessionState().teamDefinition?.name ?? null;

    const out = applyTeamName(name, d);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(code);
    expect(out.message).toContain(messagePart);
    // Zero side effects: state, directories and manifest are untouched.
    expect(getSessionState().teamDefinition?.name ?? null).toBe(beforeName);
    expect(readdirSync(join(rootDir, "sessions"))).toEqual(beforeDirs);
    if (beforeManifest !== null) {
      expect(readFileSync(getManifestPath(rootDir, OLD, SID), "utf-8")).toBe(beforeManifest);
    }
    expect(existsSync(sessionDir(OLD))).toBe(true);
  }

  it("无活跃会话（inactive）", () => {
    expectRejected(NEW, () => {
      endSession();
      return deps();
    }, "inactive", "无活跃团队会话");
  });

  it("预定义团队会话（not-dynamic）", () => {
    expectRejected(NEW, () => deps({ isDynamic: false }), "not-dynamic", "/team edit");
  });

  it("执行阶段（phase-execution）", () => {
    expectRejected(NEW, () => deps({ dynamicPhase: "execution" }), "phase-execution", "执行阶段");
  });

  it("仍有成员运行（member-running）", () => {
    expectRejected(NEW, () => deps({ hasRunningMember: () => true }), "member-running", "运行");
  });

  it("非法名（invalid）", () => {
    expectRejected("a/b", () => deps(), "invalid", "不允许的字符");
  });

  it("与预定义团队同名（taken）", () => {
    expectRejected(NEW, () => {
      mkdirSync(join(rootDir, "teams"), { recursive: true });
      writeFileSync(join(rootDir, "teams", `${NEW}.yaml`), "name: x\n", "utf-8");
      return deps();
    }, "taken", "同名");
  });

  it("目标会话目录已存在（io，绝不覆盖）", () => {
    expectRejected(NEW, () => {
      mkdirSync(sessionDir(NEW), { recursive: true });
      return deps();
    }, "io", "已存在");
  });

  it("listTeams 抛错（teams 不是目录）→ 可读的 io 文案，零副作用且不抛异常", () => {
    expectRejected(NEW, () => {
      // A regular file at <root>/teams makes listTeams' readdirSync throw ENOTDIR.
      writeFileSync(join(rootDir, "teams"), "not a directory", "utf-8");
      return deps();
    }, "io", "无法读取已有团队列表");
  });

  it("invalid 走名字规则：拒绝时附规则说明，可立即重试", () => {
    const out = applyTeamName("a/b", deps());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid");
    expect(out.message).toContain("团队名规则");
  });
});

describe("applyTeamName — 失败注入与回滚", () => {
  beforeEach(() => startDynamic());

  it("moveDir 抛错 → io，状态未变，空的新父目录被清理", () => {
    const out = applyTeamName(NEW, deps({ moveDir: () => { throw new Error("EACCES: permission denied"); } }));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("io");
    expect(out.message).toContain("EACCES");
    expect(existsSync(join(rootDir, "sessions", NEW))).toBe(false);
    expect(existsSync(sessionDir(OLD))).toBe(true);
    expect(getSessionState().teamDefinition!.name).toBe(OLD);
  });

  it("清单写入失败 → 目录与内存回滚到旧名（钩子不触发：目录未搬）", () => {
    const onRenamed = vi.fn();
    const out = applyTeamName(NEW, deps({ syncManifest: () => false, onRenamed }));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("io");
    expect(out.message).toContain("回滚");
    expect(getSessionState().teamDefinition!.name).toBe(OLD);
    expect(existsSync(sessionDir(OLD))).toBe(true);
    expect(existsSync(join(rootDir, "sessions", NEW))).toBe(false);
    expect(readManifestFile(getManifestPath(rootDir, OLD, SID))?.teamName).toBe(OLD);
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("回滚再失败 → partial，文案指向 /team resume 自愈，内存与磁盘目录一致（新名）", () => {
    const moveDir = vi
      .fn()
      .mockImplementationOnce((from: string, to: string) => renameSync(from, to))
      .mockImplementationOnce(() => { throw new Error("rollback denied"); });

    const onRenamed = vi.fn();
    const out = applyTeamName(NEW, deps({ syncManifest: () => false, moveDir, onRenamed }));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("partial");
    expect(out.message).toContain("/team resume");
    expect(existsSync(sessionDir(NEW))).toBe(true);
    expect(getSessionState().teamDefinition!.name).toBe(NEW);
    // The directory HAS moved → the settings binding + widget must follow,
    // otherwise a later settings write recreates a stray old-name directory.
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(onRenamed).toHaveBeenCalledWith(NEW);
  });
});
