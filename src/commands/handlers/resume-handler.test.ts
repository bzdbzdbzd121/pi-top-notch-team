import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResume, type ResumeHandlerDeps } from "./resume-handler";
import { createMockExtensionAPI, createMockContext } from "../../test/fixtures/mock-extension-api";
import type { TeamContext } from "../../session/context";
import { getSessionState, endSession, startSession } from "../../session/state";
import { getGoalState, resetGoal } from "../../tools/goal-tools";
import { resetManifestRuntimeContext, readManifestFile, getManifestPath } from "../../session/manifest";
import type { TeamSessionManifest } from "../../session/manifest";

function makeTeamCtx(overrides?: Partial<TeamContext>): TeamContext {
  return {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
    dynamicPhase: "design",
    agentInitiatedTask: null,
    resumedFrom: null,
    processManager: null,
    memberHandles: new Map(),
    getHandle: vi.fn(),
    setHandle: vi.fn(),
    clearHandles: vi.fn(),
    tlToolNames: ["start_member", "stop_member"],
    router: { updateMembers: vi.fn() } as any,
    messageQueue: null,
    responseWaiter: null,
    memberOperationalStates: null,
    ...overrides,
  } as TeamContext;
}

function writeManifest(rootDir: string, m: Partial<TeamSessionManifest> & { teamName: string; sessionId: string }) {
  const dir = join(rootDir, "sessions", m.teamName, m.sessionId);
  mkdirSync(dir, { recursive: true });
  const full: TeamSessionManifest = {
    version: 1,
    origin: "user",
    isDynamic: false,
    dynamicPhase: "execution",
    status: "active",
    startedAt: Date.now() - 10000,
    lastActiveAt: Date.now() - 5000,
    sharedContextWritten: true,
    goal: null,
    agentInitiatedTask: null,
    members: [{ name: "analyst", label: "分析员", systemPrompt: "分析" }],
    startedMembers: ["analyst"],
    memberPids: {},
    ...m,
  };
  writeFileSync(join(dir, "session.json"), JSON.stringify(full));
  return full;
}

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "resume-handler-"));
  process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
});

afterEach(() => {
  endSession();
  resetGoal();
  resetManifestRuntimeContext();
  rmSync(rootDir, { recursive: true, force: true });
  delete process.env.TOP_NOTCH_TEAM_ROOT;
});

describe("/team resume", () => {
  it("refuses when a session is already active", async () => {
    startSession({ name: "x", description: "", members: [] }, { sessionId: "s0" });
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    await handleResume(pi as any, makeTeamCtx(), ctx as any, "", { startResumedMember: vi.fn() });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("已有活跃团队会话"), "warning");
  });

  it("notifies when no manifests exist", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    await handleResume(pi as any, makeTeamCtx(), ctx as any, "", { startResumedMember: vi.fn() });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("没有可恢复"), "info");
  });

  it("rehydrates state and restarts previously-started members", async () => {
    writeManifest(rootDir, {
      teamName: "think-tank",
      sessionId: "abc123-x",
      goal: { text: "完成分析", criteria: "- 报告产出" },
    });
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    const onSessionStart = vi.fn();
    const startResumedMember = vi.fn().mockResolvedValue(4242);
    const teamCtx = makeTeamCtx({ onSessionStart });

    await handleResume(pi as any, teamCtx, ctx as any, "", { startResumedMember });

    const s = getSessionState();
    expect(s.active).toBe(true);
    expect(s.teamDefinition?.name).toBe("think-tank");
    expect(s.sessionId).toBe("abc123-x");
    expect(s.sharedContextWritten).toBe(true);
    expect(getGoalState()?.text).toBe("完成分析");
    expect(onSessionStart).toHaveBeenCalled();
    expect(startResumedMember).toHaveBeenCalledWith("analyst");
    expect(teamCtx.resumedFrom?.restartedMembers).toEqual(["analyst"]);

    // Manifest re-stamped active
    const m = readManifestFile(getManifestPath(rootDir, "think-tank", "abc123-x"))!;
    expect(m.status).toBe("active");
  });

  it("matches by sessionId prefix and reports restart failures", async () => {
    writeManifest(rootDir, { teamName: "think-tank", sessionId: "prefix-1" });
    writeManifest(rootDir, { teamName: "other", sessionId: "zzzz-2", startedMembers: [] });
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    const startResumedMember = vi.fn().mockRejectedValue(new Error("spawn failed"));
    const teamCtx = makeTeamCtx();

    await handleResume(pi as any, teamCtx, ctx as any, "pref", { startResumedMember });

    expect(getSessionState().teamDefinition?.name).toBe("think-tank");
    expect(teamCtx.resumedFrom?.failedMembers).toEqual(["analyst"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("重启失败"), "info");
  });

  it("lets the user pick when multiple sessions match", async () => {
    writeManifest(rootDir, { teamName: "a-team", sessionId: "s-1", startedMembers: [], lastActiveAt: 1000 });
    writeManifest(rootDir, { teamName: "b-team", sessionId: "s-2", startedMembers: [], lastActiveAt: 2000 });
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    // Sorted by lastActiveAt desc → opts[0] is b-team (most recent)
    (ctx.ui.select as any).mockImplementation(async (_t: string, opts: string[]) => opts[0]);

    await handleResume(pi as any, makeTeamCtx(), ctx as any, "", { startResumedMember: vi.fn() });

    expect(ctx.ui.select).toHaveBeenCalled();
    expect(getSessionState().teamDefinition?.name).toBe("b-team");
  });

  it("restores dynamic session flags and agent origin extras", async () => {
    writeManifest(rootDir, {
      teamName: "_dynamic_123",
      sessionId: "dyn-1",
      isDynamic: true,
      dynamicPhase: "execution",
      origin: "agent",
      agentInitiatedTask: "自主任务",
      startedMembers: [],
    });
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    const teamCtx = makeTeamCtx();

    await handleResume(pi as any, teamCtx, ctx as any, "", { startResumedMember: vi.fn() });

    expect(teamCtx.isDynamicSession).toBe(true);
    expect(teamCtx.dynamicPhase).toBe("execution");
    expect(teamCtx.agentInitiatedTask).toBe("自主任务");
    expect(getSessionState().origin).toBe("agent");
    // add_dynamic_member + stop_team_session activated
    const active = (pi.setActiveTools as any).mock.calls.at(-1)?.[0] as string[];
    expect(active).toContain("add_dynamic_member");
    expect(active).toContain("stop_team_session");
  });
});
