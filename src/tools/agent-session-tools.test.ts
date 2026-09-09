import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import {
  registerStartTeamSessionTool,
  registerStopTeamSessionTool,
} from "./agent-session-tools";
import {
  START_TEAM_SESSION_TOOL_NAME,
  STOP_TEAM_SESSION_TOOL_NAME,
} from "./agent-session-tool-names";
import { endSession, getSessionState, startSession } from "../session/state";
import { getGoalState, resetGoal } from "./goal-tools";
import { DEFAULT_SETTINGS, type TeamSettings } from "../settings/settings";
import type { TeamContext } from "../session/context";

function createTeamContext(): TeamContext {
  return {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
    dynamicPhase: "design",
    agentInitiatedTask: null,
    sessionEndedNotice: false,
    processManager: null,
    memberHandles: new Map(),
    getHandle: vi.fn(),
    setHandle: vi.fn(),
    clearHandles: vi.fn(),
    router: { route: vi.fn(), updateMembers: vi.fn() } as any,
    messageQueue: { enqueue: vi.fn(), drain: vi.fn(), length: vi.fn(), stop: vi.fn() } as any,
    responseWaiter: { waitForResponse: vi.fn(), resolveIfWaiting: vi.fn(), cancelAll: vi.fn(), cancelByCorrId: vi.fn() } as any,
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait", "wait_and_get_member_status", "write_shared_context", "set_goal", "finish_goal"],
    memberOperationalStates: null,
  };
}

function getRegisteredTool(pi: ReturnType<typeof createMockExtensionAPI>, name: string) {
  const call = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.find(
    ([def]: any) => def.name === name
  );
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[0] as any;
}

const TASK = "分析 src/channel 并产出重构方案；验收：方案文档落盘、测试全绿";

describe("start_team_session (ADR-0003)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-session-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession();
    resetGoal();
  });

  afterEach(() => {
    endSession();
    resetGoal();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects an empty task", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    registerStartTeamSessionTool({ pi, teamCtx });
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", { task: "  " }, undefined, undefined, createMockContext());
    expect(result.content[0].text).toContain("需要非空的 task");
    expect(getSessionState().active).toBe(false);
  });

  it("rejects when a session is already active (re-entry)", async () => {
    startSession({ name: "existing", description: "", members: [] });
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    registerStartTeamSessionTool({ pi, teamCtx });
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", { task: TASK }, undefined, undefined, createMockContext());
    expect(result.content[0].text).toContain("已有活跃团队会话");
    expect(getSessionState().teamDefinition!.name).toBe("existing");
  });

  it("bootstraps an agent-origin dynamic session with goal, task, and tools", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    teamCtx.onSessionStart = vi.fn();
    registerStartTeamSessionTool({ pi, teamCtx });
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);
    const ctx = createMockContext();

    const result = await tool.execute("id", { task: TASK }, undefined, undefined, ctx);

    // Session state: active, agent origin, dynamic design phase
    const state = getSessionState();
    expect(state.active).toBe(true);
    expect(state.origin).toBe("agent");
    expect(state.teamDefinition!.name).toMatch(/^_dynamic_/);
    expect(teamCtx.isDynamicSession).toBe(true);
    expect(teamCtx.dynamicPhase).toBe("design");
    expect(teamCtx.agentInitiatedTask).toBe(TASK);

    // Goal auto-seeded from task
    expect(getGoalState()?.text).toBe(TASK);
    expect(getGoalState()?.completed).toBe(false);

    // Session directory + shared-context stub created
    expect(existsSync(join(tmpDir, "sessions", state.teamDefinition!.name))).toBe(true);

    // Widget/session-start hook fired; add_dynamic_member registered
    expect(teamCtx.onSessionStart).toHaveBeenCalled();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "add_dynamic_member" })
    );

    // Activation: session tools + add_dynamic_member + stop_team_session
    const activated = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string[];
    for (const name of teamCtx.tlToolNames) expect(activated).toContain(name);
    expect(activated).toContain("add_dynamic_member");
    expect(activated).toContain(STOP_TEAM_SESSION_TOOL_NAME);

    // User visibility: 🤖 notify with task summary
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("🤖"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(TASK.slice(0, 40)),
      "info"
    );

    // Tool result guides the next steps
    expect(result.content[0].text).toContain("add_dynamic_member");
    expect(result.content[0].text).toContain("stop_team_session");
    expect(result.details.origin).toBe("agent");
  });
});

describe("stop_team_session (ADR-0003)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-session-stop-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession();
    resetGoal();
  });

  afterEach(() => {
    endSession();
    resetGoal();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("errors when no session is active", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    registerStopTeamSessionTool({ pi, teamCtx });
    const tool = getRegisteredTool(pi, STOP_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", {}, undefined, undefined, createMockContext());
    expect(result.content[0].text).toContain("无活跃团队会话");
  });

  it("refuses to stop a user-initiated session (lifecycle is user-owned)", async () => {
    startSession({ name: "user-team", description: "", members: [] }, { origin: "user" });
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    registerStopTeamSessionTool({ pi, teamCtx });
    const tool = getRegisteredTool(pi, STOP_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", {}, undefined, undefined, createMockContext());
    expect(result.content[0].text).toContain("/team stop");
    expect(getSessionState().active).toBe(true);
  });

  it("tears down an agent-initiated session", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    const stopAll = vi.fn().mockResolvedValue(undefined);
    teamCtx.processManager = { stopAll } as any;
    teamCtx.onSessionEnd = vi.fn();
    teamCtx.agentInitiatedTask = TASK;

    // Simulate an agent-initiated dynamic session
    startSession({ name: "_dynamic_999", description: "动态团队", members: [] }, { origin: "agent" });
    teamCtx.isDynamicSession = true;
    (pi.getActiveTools as any).mockReturnValue(["read", "start_member", STOP_TEAM_SESSION_TOOL_NAME, "add_dynamic_member"]);

    registerStopTeamSessionTool({ pi, teamCtx });
    const tool = getRegisteredTool(pi, STOP_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", {}, undefined, undefined, createMockContext());

    expect(stopAll).toHaveBeenCalled();
    expect(teamCtx.responseWaiter!.cancelAll).toHaveBeenCalled();
    expect(teamCtx.clearHandles).toHaveBeenCalled();
    expect(teamCtx.onSessionEnd).toHaveBeenCalled();

    // Session tools + agent tools removed from the active set
    const removed = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string[];
    expect(removed).toEqual(["read"]);

    // Session + dynamic flags + task cleared
    expect(getSessionState().active).toBe(false);
    expect(teamCtx.isDynamicSession).toBe(false);
    expect(teamCtx.agentInitiatedTask).toBeNull();

    expect(result.content[0].text).toContain("已结束");
    expect(result.content[0].text).toContain("会话数据已保留");
    expect(result.content[0].text).toContain("/team resume");
    expect(result.details.stopped).toBe(true);
  });
});

describe("start_team_session execute 门控 (L2 正确性硬闸门, 阶段②)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-session-gate-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession();
    resetGoal();
  });

  afterEach(() => {
    endSession();
    resetGoal();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 禁用态 deps：allowAgentInitiatedSessions = false（其余字段用 DEFAULT）。 */
  function disabledDeps(pi: any, teamCtx: TeamContext) {
    return {
      pi,
      teamCtx,
      getSettings: (): TeamSettings => ({
        ...structuredClone(DEFAULT_SETTINGS),
        allowAgentInitiatedSessions: false,
      }),
    };
  }

  it("禁用态：拒绝文案 + 零副作用（不 bootstrap、不置 Goal、不建目录、不动 activeTools）", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    teamCtx.onSessionStart = vi.fn();
    registerStartTeamSessionTool(disabledDeps(pi, teamCtx) as any);
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);
    const ctx = createMockContext();

    const result = await tool.execute("id", { task: TASK }, undefined, undefined, ctx);
    const text = result.content[0].text;
    // 拒绝文案骨架：信息一次给足 + 抑制重试 + 建设性出路（prose 建议不受拦截）
    expect(text).toContain("已被设置禁用");
    expect(text).toContain("请勿再次调用");
    expect(text).toContain("/team start");
    expect(text).toContain("/team dynamic");
    expect(text).toContain("/team setting");
    expect(text).toContain("自行完成任务");

    // 零副作用断言（最锋利的一条测试设计）
    expect(getSessionState().active).toBe(false);
    expect(getGoalState()).toBeNull();
    expect(existsSync(join(tmpDir, "sessions"))).toBe(false);
    expect(teamCtx.onSessionStart).not.toHaveBeenCalled();
    expect(teamCtx.agentInitiatedTask).toBeNull();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("启用态：现状回归（bootstrap 正常进行）", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    teamCtx.onSessionStart = vi.fn();
    registerStartTeamSessionTool({
      pi,
      teamCtx,
      getSettings: (): TeamSettings => structuredClone(DEFAULT_SETTINGS),
    } as any);
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);

    await tool.execute("id", { task: TASK }, undefined, undefined, createMockContext());
    expect(getSessionState().active).toBe(true);
    expect(getSessionState().origin).toBe("agent");
    expect(getGoalState()?.text).toBe(TASK);
  });

  it("getSettings 未注入 → 放行（现状路径零破坏）", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    teamCtx.onSessionStart = vi.fn();
    registerStartTeamSessionTool({ pi, teamCtx });
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);

    await tool.execute("id", { task: TASK }, undefined, undefined, createMockContext());
    expect(getSessionState().active).toBe(true);
    expect(getSessionState().origin).toBe("agent");
  });

  it("getSettings 求值异常 → fail-open 放行（防御纵深）", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    teamCtx.onSessionStart = vi.fn();
    registerStartTeamSessionTool({
      pi,
      teamCtx,
      getSettings: (): TeamSettings => {
        throw new Error("boom");
      },
    } as any);
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);

    await tool.execute("id", { task: TASK }, undefined, undefined, createMockContext());
    expect(getSessionState().active).toBe(true);
  });

  it("D6 顺序锁定：禁用 + task 空 → 返回设置禁用文案（策略先于参数校验）", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    registerStartTeamSessionTool(disabledDeps(pi, teamCtx) as any);
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", { task: "  " }, undefined, undefined, createMockContext());
    expect(result.content[0].text).toContain("已被设置禁用");
    expect(result.content[0].text).not.toContain("需要非空的 task");
    expect(getSessionState().active).toBe(false);
  });

  it("D6 顺序锁定：禁用 + 活跃会话 → 仍返回设置禁用文案（策略先于重入检查，会话不受扰动）", async () => {
    startSession({ name: "user-team", description: "", members: [] }, { origin: "user" });
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    registerStartTeamSessionTool(disabledDeps(pi, teamCtx) as any);
    const tool = getRegisteredTool(pi, START_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", { task: TASK }, undefined, undefined, createMockContext());
    expect(result.content[0].text).toContain("已被设置禁用");
    expect(result.content[0].text).not.toContain("已有活跃团队会话");
    // 会话不受影响：仍为原 user 会话（零副作用）
    expect(getSessionState().active).toBe(true);
    expect(getSessionState().teamDefinition!.name).toBe("user-team");
    expect(getSessionState().origin).toBe("user");
  });

  it("stop_team_session 不受开关影响（与开关正交）", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    registerStopTeamSessionTool(disabledDeps(pi, teamCtx) as any);
    const tool = getRegisteredTool(pi, STOP_TEAM_SESSION_TOOL_NAME);

    const result = await tool.execute("id", {}, undefined, undefined, createMockContext());
    expect(result.content[0].text).toContain("无活跃团队会话");
  });
});
