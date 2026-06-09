import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transitionState } from "./session/state-machine";
import type { MemberOperationalState } from "./session/state-machine";

// ── Helpers ────────────────────────────────────────────────

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

// ── Integration tests ──────────────────────────────────────

describe("index.ts default export (integration)", () => {
  let pi: ExtensionAPI;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    pi = createMockPi();
  });

  it("registers the /team command on load", async () => {
    const mod = await import("../index");
    mod.default(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "team",
      expect.objectContaining({
        description: expect.any(String),
      })
    );
  });

  it("registers team management tools on load", async () => {
    const mod = await import("../index");
    mod.default(pi);

    // Should register multiple tools (create_team_definition, update_team_definition,
    // plus all TL tools via registerTlTools)
    expect(pi.registerTool).toHaveBeenCalled();
    const registeredCalls = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls;
    const toolNames = registeredCalls.map((c: any) => c[0].name);

    // team_send_and_wait and get_member_status should be among registered tools
    expect(toolNames).toContain("team_send_and_wait");
    expect(toolNames).toContain("get_member_status");
    expect(toolNames).toContain("start_member");
    expect(toolNames).toContain("stop_member");
  });

  it("registers pi.on for tool_call handler", async () => {
    const mod = await import("../index");
    mod.default(pi);

    expect(pi.on).toHaveBeenCalled();
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const eventNames = onCalls.map((c: any) => c[0]);
    expect(eventNames).toContain("tool_call");
    expect(eventNames).toContain("session_start");
    expect(eventNames).toContain("before_agent_start");
  });

  it("returns early without registering tools when TEAM_ROLE is set", async () => {
    process.env.TEAM_ROLE = "worker";
    try {
      const mod = await import("../index");
      mod.default(pi);

      // When TEAM_ROLE is set, index.ts should return early
      // so registerTool/registerCommand shouldn't have been called
      expect(pi.registerTool).not.toHaveBeenCalled();
      expect(pi.registerCommand).not.toHaveBeenCalled();
    } finally {
      delete process.env.TEAM_ROLE;
    }
  });

  it("calls pi.on with before_agent_start handler", async () => {
    const mod = await import("../index");
    mod.default(pi);

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const beforeAgentStart = onCalls.find((c: any) => c[0] === "before_agent_start");
    expect(beforeAgentStart).toBeDefined();

    // The handler should be an async function
    const handler = beforeAgentStart![1];
    expect(typeof handler).toBe("function");
  });
});

// ── transitionState integration with real module ──────────

describe("transitionState (imported from state-machine)", () => {
  it("imports the pure function correctly", () => {
    expect(transitionState("idle", { type: "task_started" })).toBe("working");
    expect(transitionState("working", { type: "task_completed" })).toBe("idle");
    expect(transitionState("working", { type: "process_exit", isCrashLoop: false })).toBe("stopped");
    expect(transitionState("working", { type: "process_exit", isCrashLoop: true })).toBe("crashed");
    expect(transitionState("crashed", { type: "started" })).toBe("idle");
    expect(transitionState("working", { type: "stopped" })).toBe("stopped");
  });
});

// ── MemberOperationalState type tests ─────────────────────

describe("MemberOperationalState type (imported from state-machine)", () => {
  it("accepts valid state values", () => {
    const idle: MemberOperationalState = "idle";
    const working: MemberOperationalState = "working";
    const crashed: MemberOperationalState = "crashed";
    const stopped: MemberOperationalState = "stopped";
    expect([idle, working, crashed, stopped]).toHaveLength(4);
  });
});
