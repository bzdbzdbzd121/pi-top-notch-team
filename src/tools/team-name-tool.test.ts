import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import { ensureSetTeamNameTool } from "./team-name-tool";
import { SET_TEAM_NAME_TOOL_NAME } from "./team-name-tool-names";
import { endSession, getSessionState, startSession, addMemberToSession } from "../session/state";
import { ensureSharedContextFile } from "../session/shared-context";
import {
  getManifestPath,
  readManifestFile,
  resetManifestRuntimeContext,
  setManifestRuntimeContext,
  syncActiveManifest,
} from "../session/manifest";
import type { TeamContext } from "../session/context";
import type { TeamDefinition } from "../team/definition";

const OLD = "_dynamic_1";
const SID = "s1";

let rootDir: string;

function team(): TeamDefinition {
  return {
    name: OLD,
    description: "动态团队",
    members: [{ name: "analyst", label: "分析员", systemPrompt: "负责分析" }],
  };
}

function sessionDir(name: string): string {
  return join(rootDir, "sessions", name, SID);
}

function makeTeamCtx(overrides: Partial<TeamContext> = {}): TeamContext {
  return {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: true,
    dynamicPhase: "design",
    agentInitiatedTask: null,
    sessionEndedNotice: false,
    processManager: null,
    memberHandles: new Map(),
    getHandle: vi.fn(),
    setHandle: vi.fn(),
    clearHandles: vi.fn(),
    router: { route: vi.fn(), updateMembers: vi.fn() } as any,
    messageQueue: null,
    responseWaiter: null,
    tlToolNames: ["start_member"],
    memberOperationalStates: null,
    ...overrides,
  } as TeamContext;
}

function startDynamic(): void {
  startSession(team(), { sessionId: SID, origin: "user" });
  setManifestRuntimeContext({ isDynamic: true, dynamicPhase: "design", agentInitiatedTask: null });
  mkdirSync(sessionDir(OLD), { recursive: true });
  syncActiveManifest();
  ensureSharedContextFile(team(), SID);
}

function register(overrides: Partial<TeamContext> = {}) {
  const pi = createMockExtensionAPI();
  const teamCtx = makeTeamCtx(overrides);
  ensureSetTeamNameTool(pi, teamCtx);
  const def = (pi.registerTool as any).mock.calls.find(
    ([d]: any) => d.name === SET_TEAM_NAME_TOOL_NAME
  )?.[0];
  return { pi, teamCtx, tool: def };
}

const ctx = () => createMockContext();

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "team-name-tool-"));
  process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
  endSession();
  resetManifestRuntimeContext();
  startDynamic();
});

afterEach(() => {
  endSession();
  resetManifestRuntimeContext();
  rmSync(rootDir, { recursive: true, force: true });
  delete process.env.TOP_NOTCH_TEAM_ROOT;
});

describe("set_team_name tool — 注册", () => {
  it("注册幂等（重复调用只注册一次）", () => {
    const pi = createMockExtensionAPI();
    // Faithful getAllTools: reflect what registerTool received (the shared mock
    // fixture returns [] unconditionally, which would hide the dedupe).
    (pi.getAllTools as any).mockImplementation(() =>
      (pi.registerTool as any).mock.calls.map(([def]: any) => def)
    );
    const teamCtx = makeTeamCtx();
    ensureSetTeamNameTool(pi, teamCtx);
    ensureSetTeamNameTool(pi, teamCtx);
    const calls = (pi.registerTool as any).mock.calls.filter(
      ([d]: any) => d.name === SET_TEAM_NAME_TOOL_NAME
    );
    expect(calls).toHaveLength(1);
  });

  it("description 与 promptGuidelines 说明可用范围与「成员启动后不可改名」", () => {
    const { tool } = register();
    expect(tool.description).toContain("design phase");
    expect(tool.description).toContain("frozen");
    expect(tool.promptGuidelines.join("\n")).toContain("set_team_name");
    expect(tool.promptGuidelines.join("\n")).toContain("不可改名");
  });
});

describe("set_team_name tool — 成功路径", () => {
  it("改名成功：状态/目录/清单一致，结果写最终名与生效范围", async () => {
    const onTeamRenamed = vi.fn();
    const { tool } = register({ onTeamRenamed });

    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());

    expect(result.content[0].text).toContain("登录重构");
    expect(result.content[0].text).toContain("状态栏");
    expect(result.content[0].text).toContain("/team resume");
    expect(result.details.teamName).toBe("登录重构");
    expect(result.details.moved).toBe(true);
    expect(result.details.previousName).toBe(OLD);

    expect(getSessionState().teamDefinition!.name).toBe("登录重构");
    expect(existsSync(sessionDir("登录重构"))).toBe(true);
    expect(readManifestFile(getManifestPath(rootDir, "登录重构", SID))?.teamName).toBe("登录重构");
    // 收尾钩子（index.ts 注入：重绑临时设置目录 + 刷新状态栏）
    expect(onTeamRenamed).toHaveBeenCalledWith("登录重构");
  });

  it("幂等：同名再调 → 成功且说明未做改动", async () => {
    const { tool } = register();
    await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    const second = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(second.content[0].text).toContain("未做任何改动");
    expect(second.details.moved).toBe(false);
  });

  it("归一化回显：说明输入已归一为最终名", async () => {
    const { tool } = register();
    const result = await tool.execute("id", { name: "v2 订单并发" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("v2-订单并发");
    expect(result.content[0].text).toContain("v2 订单并发");
    expect(result.content[0].text).toContain("归一");
  });

  it("共享上下文已被修改 → 附注「不是系统占位文件，未改写」且内容不变", async () => {
    const custom = "# 我写的共享上下文\n";
    writeFileSync(join(sessionDir(OLD), ".shared-context.md"), custom, "utf-8");

    const { tool } = register();
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());

    expect(result.content[0].text).toContain("write_shared_context");
    expect(result.content[0].text).toContain("不是系统自动生成的占位文件");
    // Must NOT claim the TL wrote it when that cannot be known.
    expect(result.content[0].text).not.toContain("TL 已写入");
    expect(result.details.stubRewrite).toBe("not-stub");
    expect(readFileSync(join(sessionDir("登录重构"), ".shared-context.md"), "utf-8")).toBe(custom);
  });

  it("先 add_dynamic_member 再 set_team_name：stub 被识别并重写，首行为新名", async () => {
    // Rebuild the exact review scenario: stub written at bootstrap with 0 members.
    endSession();
    resetManifestRuntimeContext();
    const emptyTeam: TeamDefinition = { name: OLD, description: "动态团队", members: [] };
    startSession(emptyTeam, { sessionId: SID, origin: "user" });
    setManifestRuntimeContext({ isDynamic: true, dynamicPhase: "design", agentInitiatedTask: null });
    mkdirSync(sessionDir(OLD), { recursive: true });
    syncActiveManifest();
    ensureSharedContextFile(emptyTeam, SID);
    addMemberToSession({ name: "analyst", label: "分析员", systemPrompt: "负责分析" });

    const { tool } = register();
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());

    expect(result.content[0].text).toContain("已按新团队名重写");
    expect(result.details.stubRewrite).toBe("rewritten");
    const stub = readFileSync(join(sessionDir("登录重构"), ".shared-context.md"), "utf-8");
    expect(stub.split("\n")[0]).toBe("# Shared Context — 登录重构");
    expect(stub).toContain("- analyst（分析员）");
  });

  it("共享上下文文件不存在 → 结果说明「不存在」（不虚构原因）", async () => {
    rmSync(join(sessionDir(OLD), ".shared-context.md"));
    const { tool } = register();
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("不存在");
    expect(result.details.stubRewrite).toBe("missing");
  });

  it("共享上下文不可读 → 结果如实说「无法判定」，不碰文件", async () => {
    // Replace the stub file with a directory → readFileSync throws EISDIR.
    rmSync(join(sessionDir(OLD), ".shared-context.md"));
    mkdirSync(join(sessionDir(OLD), ".shared-context.md"));
    const { tool } = register();
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("无法判定");
    expect(result.details.stubRewrite).toBe("undecidable");
  });

  it("start_member 失败残留 handle（非 running）之后仍可改名", async () => {
    const handle = { getState: () => ({ status: "stopped", pid: null }) } as any;
    const teamCtx = makeTeamCtx({ memberHandles: new Map([["analyst", handle]]) as any });
    const pi = createMockExtensionAPI();
    ensureSetTeamNameTool(pi, teamCtx);
    const tool = (pi.registerTool as any).mock.calls.find(
      ([d]: any) => d.name === SET_TEAM_NAME_TOOL_NAME
    )![0];

    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("✅");
    expect(getSessionState().teamDefinition!.name).toBe("登录重构");
  });
});

describe("set_team_name tool — 拒绝文案（每条含下一步）", () => {
  it("无活跃会话", async () => {
    endSession();
    const { tool } = register();
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("无活跃团队会话");
    expect(result.content[0].text).toContain("/team dynamic");
    expect(result.details.code).toBe("inactive");
  });

  it("预定义团队会话指向 /team edit", async () => {
    const { tool } = register({ isDynamicSession: false });
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("预定义团队");
    expect(result.content[0].text).toContain("/team edit");
  });

  it("执行阶段 → 名称冻结，说明原因与出路", async () => {
    const { tool } = register({ dynamicPhase: "execution" });
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("执行阶段");
    expect(result.content[0].text).toContain("冻结");
    expect(result.content[0].text).toContain("/team stop");
    expect(getSessionState().teamDefinition!.name).toBe(OLD);
  });

  it("仍有成员进程在运行", async () => {
    const handle = { getState: () => ({ status: "running", pid: 123 }) } as any;
    const { tool } = register({ memberHandles: new Map([["analyst", handle]]) as any });
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    // Truthful constraint: the name freezes once a member starts — stopping the
    // member does NOT unlock a rename in the same session (never suggest that).
    expect(result.content[0].text).toContain("冻结");
    expect(result.content[0].text).toContain("/team stop");
    expect(result.content[0].text).not.toContain("stop_member");
    expect(getSessionState().teamDefinition!.name).toBe(OLD);
  });

  it("非法名 → 规则说明 + 可立即重试", async () => {
    const { tool } = register();
    const result = await tool.execute("id", { name: "a/b" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("团队名规则");
    expect(result.content[0].text).toContain("重试");
  });

  it("与预定义团队同名 → 说明原因与重试", async () => {
    mkdirSync(join(rootDir, "teams"), { recursive: true });
    writeFileSync(join(rootDir, "teams", "登录重构.yaml"), "name: x\n", "utf-8");
    const { tool } = register();
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("同名");
    expect(result.content[0].text).toContain("重试");
  });

  it("已有团队列表读取失败 → 返回可读文案而不是抛异常", async () => {
    writeFileSync(join(rootDir, "teams"), "not a directory", "utf-8");
    const { tool } = register();
    const result = await tool.execute("id", { name: "登录重构" }, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("无法读取已有团队列表");
    expect(getSessionState().teamDefinition!.name).toBe(OLD);
  });

  it("缺少 name 参数时不崩且说明需要名字", async () => {
    const { tool } = register();
    const result = await tool.execute("id", {}, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("name 参数");
    expect(getSessionState().teamDefinition!.name).toBe(OLD);
  });
});
