import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import { registerTeamCommand } from "./team";
import { endSession, getSessionState } from "../session/state";
import type { TeamContext, SessionUI } from "../session/context";

function createTeamContext(): TeamContext {
  return {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
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
    ctx.ui.notify.mockClear();
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

  it("/team stop cleans up dynamic session and directory", async () => {
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
    ctx.ui.notify.mockClear();
    await cmdHandler.handler("stop", ctx);

    // Verify cleanup
    const afterState = getSessionState();
    expect(afterState.active).toBe(false);
    expect(teamCtx.isDynamicSession).toBe(false);
    expect(stopAllMock).toHaveBeenCalled();
    expect(teamCtx.onSessionEnd).toHaveBeenCalled();

    // Directory should be removed
    expect(existsSync(sessionDir)).toBe(false);
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
