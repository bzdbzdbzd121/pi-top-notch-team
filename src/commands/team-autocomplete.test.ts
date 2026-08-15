/**
 * Test getArgumentCompletions behavior for the /team command,
 * verifying that subcommand suggestions appear correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import { registerTeamCommand } from "./team";
import { startSession, endSession, isActive } from "../session/state";
import type { TeamContext } from "../session/context";
import type { TeamDefinition } from "../team/definition";

function createTeamContext(): TeamContext {
  return {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
    dynamicPhase: "design" as const,
    agentInitiatedTask: null,
    sessionEndedNotice: false,
    processManager: null,
    memberHandles: new Map(),
    getHandle: vi.fn(),
    setHandle: vi.fn(),
    clearHandles: vi.fn(),
    router: { route: vi.fn(), updateMembers: vi.fn() } as any,
    messageQueue: { enqueue: vi.fn(), drain: vi.fn(), length: vi.fn(), stop: vi.fn() } as any,
    responseWaiter: { waitForResponse: vi.fn(), resolveIfWaiting: vi.fn(), cancelAll: vi.fn() } as any,
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait"],
    memberOperationalStates: null,
    onSessionStart: vi.fn(),
    onSessionEnd: vi.fn(),
    onEditStart: vi.fn(),
    onEditEnd: vi.fn(),
    onCreateStart: vi.fn(),
    onCreateEnd: vi.fn(),
  };
}

describe("/team autocomplete (getArgumentCompletions)", () => {
  let tmpDir: string;
  let getArgCompletions: Function;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-autocomplete-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession();

    const pi = createMockExtensionAPI();
    registerTeamCommand(pi, createTeamContext());

    // Capture the registered getArgumentCompletions
    const callArgs = (pi.registerCommand as any).mock.calls[0];
    getArgCompletions = callArgs[1].getArgumentCompletions;
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
    endSession();
  });

  it("registers getArgumentCompletions callback", () => {
    expect(getArgCompletions).toBeDefined();
    expect(typeof getArgCompletions).toBe("function");
  });

  describe("outside team session (isActive = false)", () => {
    it("returns all subcommands when prefix is empty", () => {
      const result = getArgCompletions("");
      expect(Array.isArray(result)).toBe(true);
      expect(result!.length).toBeGreaterThan(0);
      const values = result!.map((r: any) => r.value);
      expect(values).toContain("create");
      expect(values).toContain("start");
      expect(values).toContain("stop");
      expect(values).toContain("list");
      expect(values).toContain("show");
      expect(values).toContain("delete");
      expect(values).toContain("status");
      expect(values).toContain("help");
    });

    it("filters subcommands by prefix", () => {
      const result = getArgCompletions("st");
      expect(Array.isArray(result)).toBe(true);
      const values = result!.map((r: any) => r.value);
      expect(values).toContain("start");
      expect(values).toContain("stop");
      expect(values).toContain("status");
      expect(values).not.toContain("list");
    });

    it("returns team names for start/stop/show/delete/edit", () => {
      const result = getArgCompletions("start ");
      if (result && result.length > 0) {
        expect(result[0]).toHaveProperty("value");
      }
    });
  });

  describe("inside team session (isActive = true)", () => {
    const baseTeam: TeamDefinition = {
      name: "test-team",
      description: "A test team",
      members: [
        { name: "worker", label: "Worker", systemPrompt: "You are a worker" },
      ],
    };

    beforeEach(() => {
      startSession(baseTeam);
      expect(isActive()).toBe(true);
    });

    it("returns stop, status, setting, help when prefix is empty", () => {
      const result = getArgCompletions("") as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(4);
      const values = result.map((r: any) => r.value);
      expect(values).toContain("stop");
      expect(values).toContain("status");
      expect(values).toContain("setting");
      expect(values).toContain("help");
    });

    it("filters to stop+status+setting when prefix is 's'", () => {
      const result = getArgCompletions("s") as any[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(3);
      const values = result.map((r: any) => r.value);
      expect(values).toContain("stop");
      expect(values).toContain("status");
      expect(values).toContain("setting");
      expect(values).not.toContain("help");
    });

    it("filters to stop+status when prefix is 'st'", () => {
      const result = getArgCompletions("st") as any[];
      expect(result.length).toBe(2);
      const values = result.map((r: any) => r.value);
      expect(values).toContain("stop");
      expect(values).toContain("status");
      expect(values).not.toContain("setting");
    });

    it("filters to setting when prefix is 'set'", () => {
      const result = getArgCompletions("set") as any[];
      expect(result.length).toBe(1);
      expect(result[0].value).toBe("setting");
    });

    it("filters to stop when prefix is 'sto'", () => {
      const result = getArgCompletions("sto") as any[];
      expect(result.length).toBe(1);
      expect(result[0].value).toBe("stop");
    });

    it("shows stop when prefix is 'stop'", () => {
      const result = getArgCompletions("stop") as any[];
      expect(result.length).toBe(1);
      expect(result[0].value).toBe("stop");
    });

    it("shows help when prefix is 'h'", () => {
      const result = getArgCompletions("h") as any[];
      expect(result.length).toBe(1);
      expect(result[0].value).toBe("help");
    });

    it("shows status when prefix is 'status'", () => {
      const result = getArgCompletions("status") as any[];
      expect(result.length).toBe(1);
      expect(result[0].value).toBe("status");
    });

    it("returns null for non-matching prefix (e.g. 'x')", () => {
      const result = getArgCompletions("x");
      expect(result).toBeNull();
    });

    it("returns null for create prefix (not allowed during session)", () => {
      const result = getArgCompletions("c");
      expect(result).toBeNull();
    });

    it("returns null for list prefix (not allowed during session)", () => {
      const result = getArgCompletions("l");
      expect(result).toBeNull();
    });
  });
});
