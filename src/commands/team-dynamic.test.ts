import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import { registerTeamCommand } from "./team";
import { endSession, getSessionState, startSession } from "../session/state";
import { registerStartTeamSessionTool } from "../tools/agent-session-tools";
import { DEFAULT_SETTINGS, type TeamSettings } from "../settings/settings";
import type { TeamContext, SessionUI } from "../session/context";

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
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait", "wait_and_get_member_status"],
    memberOperationalStates: null,
  };
}

describe("/team dynamic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-dynamic-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession();
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts a session with 0 members and activates TL tools", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    teamCtx.onSessionStart = vi.fn();

    registerTeamCommand(pi, teamCtx);

    const cmdHandler = (pi.registerCommand as any).mock.calls[0][1];
    const ctx = createMockContext();

    await cmdHandler.handler("dynamic", ctx);

    const state = getSessionState();
    expect(state.active).toBe(true);
    expect(state.teamDefinition!.members).toHaveLength(0);
    expect(state.teamDefinition!.name).toMatch(/^_dynamic_/);
    expect(state.teamDefinition!.description).toBe("动态团队");
    expect(teamCtx.isDynamicSession).toBe(true);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "add_dynamic_member" })
    );
    expect(pi.setActiveTools).toHaveBeenCalled();
    expect(teamCtx.onSessionStart).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("动态团队模式已启动"),
      "info"
    );
  });

  it("rejects if session is already active", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();

    registerTeamCommand(pi, teamCtx);

    const cmdHandler = (pi.registerCommand as any).mock.calls[0][1];
    const ctx = createMockContext();

    // First call should succeed
    await cmdHandler.handler("dynamic", ctx);

    // Second call should reject
    (ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();
    await cmdHandler.handler("dynamic", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("团队会话期间仅支持"),
      "warning"
    );

    // Clean up
    endSession();
  });

  it("creates the session directory on start", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();

    registerTeamCommand(pi, teamCtx);

    const cmdHandler = (pi.registerCommand as any).mock.calls[0][1];
    const ctx = createMockContext();

    await cmdHandler.handler("dynamic", ctx);

    const state = getSessionState();
    const sessionDir = join(tmpDir, "sessions", state.teamDefinition!.name);
    const { existsSync } = await import("node:fs");
    expect(existsSync(sessionDir)).toBe(true);

    endSession();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("/team stop marks the dynamic session stopped and keeps the directory", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    const stopAllMock = vi.fn().mockResolvedValue(undefined);
    teamCtx.processManager = { stopAll: stopAllMock } as any;
    teamCtx.responseWaiter!.cancelAll = vi.fn();
    teamCtx.onSessionEnd = vi.fn();

    registerTeamCommand(pi, teamCtx);

    const cmdHandler = (pi.registerCommand as any).mock.calls[0][1];
    const ctx = createMockContext();

    // Start dynamic session
    await cmdHandler.handler("dynamic", ctx);
    const state = getSessionState();
    const teamName = state.teamDefinition!.name;
    const sessionDir = join(tmpDir, "sessions", teamName);

    // Verify dir exists
    const { existsSync } = await import("node:fs");
    expect(existsSync(sessionDir)).toBe(true);

    // Stop dynamic session
    (ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();
    await cmdHandler.handler("stop", ctx);

    // Verify cleanup
    const afterState = getSessionState();
    expect(afterState.active).toBe(false);
    expect(teamCtx.isDynamicSession).toBe(false);
    expect(stopAllMock).toHaveBeenCalled();
    expect(teamCtx.onSessionEnd).toHaveBeenCalled();

    // Directory is PRESERVED (session stays resumable via /team resume);
    // the manifest is marked stopped instead of being deleted (ADR-0004).
    expect(existsSync(sessionDir)).toBe(true);
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(join(sessionDir, state.sessionId!, "session.json"), "utf-8")
    );
    expect(manifest.status).toBe("stopped");
    expect(manifest.isDynamic).toBe(true);
  });

  it("appears in the help output", async () => {
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();

    registerTeamCommand(pi, teamCtx);

    const cmdHandler = (pi.registerCommand as any).mock.calls[0][1];
    const ctx = createMockContext();

    await cmdHandler.handler("help", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/team dynamic"),
      expect.any(String)
    );
  });
});

describe("红线守护（beta A4）：禁用态下 /team dynamic 仍可正常开会（阶段③ 随行落地）", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-dynamic-gate-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession();
  });

  afterEach(() => {
    endSession();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allowAgentInitiatedSessions=false 时：/team dynamic 会话正常 bootstrap（origin user）、成员可注册——开关只管 agent 启动相，手动入口零影响", async () => {
    // 环境全禁用态：磁盘全局设置写禁用 + L2 依赖注入禁用（与生产接线同构）
    writeFileSync(
      join(tmpDir, "settings.yaml"),
      "allowAgentInitiatedSessions: false\n",
      "utf-8"
    );
    const pi = createMockExtensionAPI();
    const teamCtx = createTeamContext();
    teamCtx.onSessionStart = vi.fn();
    registerStartTeamSessionTool({
      pi,
      teamCtx,
      getSettings: (): TeamSettings => ({
        ...structuredClone(DEFAULT_SETTINGS),
        allowAgentInitiatedSessions: false,
      }),
    });
    registerTeamCommand(pi, teamCtx);
    const cmdHandler = (pi.registerCommand as any).mock.calls[0][1];
    const ctx = createMockContext();

    // /team dynamic 正常开会（红线：无差别门控会在此红）
    await cmdHandler.handler("dynamic", ctx);
    const state = getSessionState();
    expect(state.active).toBe(true);
    expect(state.origin).toBe("user");
    expect(state.teamDefinition!.name).toMatch(/^_dynamic_/);
    expect(teamCtx.isDynamicSession).toBe(true);
    expect(teamCtx.dynamicPhase).toBe("design");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("动态团队模式已启动"), "info");

    // 开会继续：add_dynamic_member 已注册且实际可注册成员（getSessionState 返回深拷贝，重新读取）
    const addToolCall = (pi.registerTool as any).mock.calls.find(
      ([def]: any) => def.name === "add_dynamic_member"
    );
    expect(addToolCall).toBeDefined();
    await addToolCall[0].execute("id", { name: "analyzer", label: "分析员", systemPrompt: "负责分析" }, undefined, undefined, ctx);
    expect(getSessionState().teamDefinition!.members.map((m: any) => m.name)).toContain("analyzer");

    // 对照组：同环境下 L2 门控对 start_team_session 仍然生效（工具路径与命令路径分流）
    const startTool = (pi.registerTool as any).mock.calls.find(
      ([def]: any) => def.name === "start_team_session"
    );
    const rejected = await startTool[0].execute("id", { task: "测试任务" }, undefined, undefined, ctx);
    expect(rejected.content[0].text).toContain("已被设置禁用");
    // 且未扰动进行中的 user 会话
    expect(getSessionState().active).toBe(true);
    expect(getSessionState().origin).toBe("user");
  });
});
