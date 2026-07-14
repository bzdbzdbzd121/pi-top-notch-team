import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemberOperationalState } from "./session/context";

// ── Helper ────────────────────────────────────────────────

function createMockUi() {
  return {
    theme: {
      fg: (_style: string, text: string) => text,
    },
    setWidget: vi.fn(),
    setStatus: vi.fn(),
    notify: vi.fn(),
    requestRender: vi.fn(),
  };
}

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: vi.fn((def: any) => {
      tools.push(def);
    }),
    registerCommand: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn(),
    getAllTools: vi.fn().mockReturnValue(tools),
    getActiveTools: vi.fn().mockReturnValue(tools.map((t: any) => t.name)),
    setActiveTools: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn().mockReturnValue(undefined),
    setLabel: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getThinkingLevel: vi.fn().mockReturnValue("off"),
    setThinkingLevel: vi.fn(),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
    events: { on: vi.fn(), emit: vi.fn() } as any,
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
  } as any;
}

// ── agent_settled handler: mock-dependent tests ───────────

// NOTE: These tests use vi.mock at describe level because vitest hoists
// vi.mock calls to the top of the file. This isolated test file prevents
// the mock from interfering with other index.ts tests.

vi.mock("../src/process/manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process/manager")>();

  // Shared controllable map — each test can modify it before importing index.ts
  const testMap = new Map<string, MemberOperationalState>();

  return {
    ...actual,
    createProcessManager: vi.fn(() => {
      const real = actual.createProcessManager();
      return {
        ...real,
        getOperationalStateMap: () => testMap,
      };
    }),
  };
});

describe("agent_settled handler with running members", () => {
  let pi: ExtensionAPI;

  /**
   * Get the controllable map shared between this test file and the mock.
   * The vi.mock factory creates one map; all tests share it.
   */
  async function getTestMap(): Promise<Map<string, MemberOperationalState>> {
    const { createProcessManager } = await import("../src/process/manager");
    const mgr = createProcessManager();
    return mgr.getOperationalStateMap();
  }

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;

    // Clear the shared map so each test starts fresh
    const map = await getTestMap();
    map.clear();
  });

  it("shows notification and warning when members running and signal aborted", async () => {
    pi = createMockPi();

    // Populate the test map BEFORE importing index.ts
    const map = await getTestMap();
    map.set("worker", "working");

    const mod = await import("../index");
    mod.default(pi);

    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({ name: "test", description: "", members: [] });

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const handler = onCalls.find((c: any) => c[0] === "agent_settled")![1];

    const ui = createMockUi();
    await handler({}, { ui, signal: { aborted: true } });

    // Should call setStatus with a running-members warning
    const statusCalls = (ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any) => c[0] === "team-members-running"
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    const lastStatusArg = statusCalls[statusCalls.length - 1][1];
    expect(lastStatusArg).toContain("运行");

    // Should notify the user with a warning
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("运行"),
      "warning"
    );
  });

  it("shows subtle status when members running without abort", async () => {
    pi = createMockPi();

    const map = await getTestMap();
    map.set("worker", "idle");

    const mod = await import("../index");
    mod.default(pi);

    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({ name: "test", description: "", members: [] });

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const handler = onCalls.find((c: any) => c[0] === "agent_settled")![1];

    const ui = createMockUi();
    await handler({}, { ui, signal: { aborted: false } });

    // Subtle status (notify should NOT be called)
    expect(ui.setStatus).toHaveBeenCalledWith(
      "team-members-running",
      expect.stringContaining("运行")
    );
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("handles mixed states: working + stopped members", async () => {
    pi = createMockPi();

    const map = await getTestMap();
    map.set("worker", "working");
    map.set("done", "stopped");

    const mod = await import("../index");
    mod.default(pi);

    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({ name: "test", description: "", members: [] });

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const handler = onCalls.find((c: any) => c[0] === "agent_settled")![1];

    const ui = createMockUi();
    await handler({}, { ui, signal: { aborted: true } });

    // Only 1 running member (working), stopped not counted
    expect(ui.setStatus).toHaveBeenCalled();
    const statusCalls = (ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any) => c[0] === "team-members-running"
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    const lastStatusArg = statusCalls[statusCalls.length - 1][1];
    expect(lastStatusArg).toContain("1"); // Count should be 1
    expect(lastStatusArg).toContain("运行");
  });

  it("counts only idle/working members, not crashed/stopped", async () => {
    pi = createMockPi();

    const map = await getTestMap();
    map.set("worker", "working");
    map.set("helper", "idle");
    map.set("broken", "crashed");
    map.set("done", "stopped");

    const mod = await import("../index");
    mod.default(pi);

    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({ name: "test", description: "", members: [] });

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const handler = onCalls.find((c: any) => c[0] === "agent_settled")![1];

    const ui = createMockUi();
    await handler({}, { ui, signal: { aborted: true } });

    // Only 2 running (working + idle), crashed/stopped not counted
    const statusCalls = (ui.setStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any) => c[0] === "team-members-running"
    );
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    const lastStatusArg = statusCalls[statusCalls.length - 1][1];
    expect(lastStatusArg).toContain("2"); // Count should be 2
    expect(lastStatusArg).toContain("运行");
  });
});
