import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transitionState } from "./session/state-machine";
import type { MemberOperationalState } from "./session/context";

// ── Helpers ────────────────────────────────────────────────

function createMockUi() {
  return {
    theme: {
      fg: (_style: string, text: string) => text,
    },
    setWidget: vi.fn(),
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

    // team_send_and_wait and wait_and_get_member_status should be among registered tools
    expect(toolNames).toContain("team_send_and_wait");
    expect(toolNames).toContain("wait_and_get_member_status");
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

  // ── Workflow prompt injection tests ───────────────────

  describe("workflow prompt injection in before_agent_start", () => {
    beforeEach(async () => {
      vi.resetModules();
      delete process.env.TEAM_ROLE;
      pi = createMockPi();
      const mod = await import("../index");
      mod.default(pi);
    });

    function getBeforeAgentStartHandler(): Function {
      const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
      const entry = onCalls.find((c: any) => c[0] === "before_agent_start");
      return entry![1];
    }

    it("injects strict workflow prompt when workflow.strictness is strict", async () => {
      const { startSession, endSession } = await import("./session/state");
      endSession();
      startSession({
        name: "test-team",
        description: "Test",
        members: [{ name: "worker", systemPrompt: "do work" }],
        workflow: {
          strictness: "strict",
          stages: [{ member: "worker", name: "build", description: "Build the thing" }],
        },
      });

      const handler = getBeforeAgentStartHandler();
      const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
      expect(result.systemPrompt).toContain("严格按照以下步骤执行");
      expect(result.systemPrompt).toContain("【build】");
      expect(result.systemPrompt).toContain("Build the thing");
    });

    it("injects reference workflow prompt when workflow.strictness is reference", async () => {
      const { startSession, endSession } = await import("./session/state");
      endSession();
      startSession({
        name: "test-team",
        description: "Test",
        members: [{ name: "worker", systemPrompt: "do work" }],
        workflow: {
          strictness: "reference",
          stages: [{ member: "worker", name: "build", description: "Build the thing" }],
        },
      });

      const handler = getBeforeAgentStartHandler();
      const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
      expect(result.systemPrompt).toContain("作为工作流程参考");
      expect(result.systemPrompt).toContain("【build】");
    });

    it("does not inject workflow prompt when team has no workflow", async () => {
      const { startSession, endSession } = await import("./session/state");
      endSession();
      startSession({
        name: "test-team",
        description: "Test",
        members: [{ name: "worker", systemPrompt: "do work" }],
      });

      const handler = getBeforeAgentStartHandler();
      const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
      expect(result.systemPrompt).not.toContain("严格");
      expect(result.systemPrompt).not.toContain("参考");
      expect(result.systemPrompt).toContain("Team Lead");
    });

    it("does not inject workflow prompt when session is not active", async () => {
      const { endSession } = await import("./session/state");
      endSession();

      const handler = getBeforeAgentStartHandler();
      const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
      expect(result).toBeUndefined();
    });

    it("injects workflow prompt with loops", async () => {
      const { startSession, endSession } = await import("./session/state");
      endSession();
      startSession({
        name: "test-team",
        description: "Test",
        members: [{ name: "worker", systemPrompt: "do work" }, { name: "reviewer", systemPrompt: "review" }],
        workflow: {
          strictness: "reference",
          description: "Dev workflow",
          stages: [
            { member: "worker", name: "code", description: "Write code" },
            { member: "reviewer", name: "review", description: "Review code" },
          ],
          loops: [{ condition: "Review failed", stages: ["code", "review"] }],
        },
      });

      const handler = getBeforeAgentStartHandler();
      const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
      expect(result.systemPrompt).toContain("Review failed");
      expect(result.systemPrompt).toContain("code");
      expect(result.systemPrompt).toContain("review");
    });

    it("injects workflow prompt with onFailure", async () => {
      const { startSession, endSession } = await import("./session/state");
      endSession();
      startSession({
        name: "test-team",
        description: "Test",
        members: [{ name: "worker", systemPrompt: "do work" }],
        workflow: {
          strictness: "strict",
          stages: [{
            member: "worker",
            name: "code",
            description: "Write code",
            onFailure: { returnToStage: "code", condition: "tests fail" },
          }],
        },
      });

      const handler = getBeforeAgentStartHandler();
      const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
      expect(result.systemPrompt).toContain("tests fail");
      expect(result.systemPrompt).toContain("code");
    });

    it("injects workflow prompt with all optional fields", async () => {
      const { startSession, endSession } = await import("./session/state");
      endSession();
      startSession({
        name: "test-team",
        description: "Test",
        members: [{ name: "architect", systemPrompt: "design" }],
        workflow: {
          strictness: "reference",
          description: "Full workflow",
          stages: [{
            member: "architect",
            name: "design",
            description: "Create design",
            input: "Requirements",
            output: "Design doc",
            constraints: "Use approved patterns",
          }],
        },
      });

      const handler = getBeforeAgentStartHandler();
      const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
      expect(result.systemPrompt).toContain("【design】");
      expect(result.systemPrompt).toContain("Create design");
      expect(result.systemPrompt).toContain("Requirements");
      expect(result.systemPrompt).toContain("Design doc");
      expect(result.systemPrompt).toContain("Use approved patterns");
    });
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

describe("MemberOperationalState type (imported from context)", () => {
  it("accepts valid state values", () => {
    const idle: MemberOperationalState = "idle";
    const working: MemberOperationalState = "working";
    const crashed: MemberOperationalState = "crashed";
    const stopped: MemberOperationalState = "stopped";
    expect([idle, working, crashed, stopped]).toHaveLength(4);
  });
});
