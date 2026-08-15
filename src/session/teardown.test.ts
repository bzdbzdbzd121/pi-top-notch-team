import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { teardownTeamSession } from "./teardown";
import { startSession, endSession } from "./state";
import type { TeamContext } from "./context";

function createMockPi(): ExtensionAPI {
  return {
    getActiveTools: vi.fn().mockReturnValue(["start_member", "read", "bash"]),
    setActiveTools: vi.fn(),
  } as any;
}

function createMockTeamCtx(): TeamContext {
  return {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
    dynamicPhase: "design",
    agentInitiatedTask: null,
    resumedFrom: null,
    sessionEndedNotice: false,
    processManager: null,
    memberHandles: new Map(),
    getHandle: () => undefined,
    setHandle: () => {},
    clearHandles: vi.fn(),
    router: null,
    messageQueue: null,
    responseWaiter: null,
    tlToolNames: [],
    memberOperationalStates: null,
    onSessionEnd: vi.fn(),
    onEditEnd: vi.fn(),
    onCreateEnd: vi.fn(),
  };
}

describe("teardownTeamSession — sessionEndedNotice", () => {
  let rootDir: string;
  let pi: ExtensionAPI;
  let teamCtx: TeamContext;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "tn-team-teardown-"));
    process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
    pi = createMockPi();
    teamCtx = createMockTeamCtx();
  });

  afterEach(() => {
    endSession();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("sets sessionEndedNotice when a team session was active (informs the next turn that the session ended)", async () => {
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "do work" }],
    });
    expect(teamCtx.sessionEndedNotice).toBe(false);

    await teardownTeamSession(pi, teamCtx);

    // The one-shot notice is set so the next before_agent_start injects the
    // "session ended" banner (no new conversation is triggered by itself).
    expect(teamCtx.sessionEndedNotice).toBe(true);
  });

  it("does NOT set sessionEndedNotice when no session was active (bare /team stop must not produce a spurious banner)", async () => {
    await teardownTeamSession(pi, teamCtx);
    expect(teamCtx.sessionEndedNotice).toBe(false);
  });

  it("does not clear an existing pending notice when no session is active", async () => {
    teamCtx.sessionEndedNotice = true;
    await teardownTeamSession(pi, teamCtx);
    // The notice is still pending (belongs to an earlier session end); the
    // next before_agent_start will consume it.
    expect(teamCtx.sessionEndedNotice).toBe(true);
  });
});
