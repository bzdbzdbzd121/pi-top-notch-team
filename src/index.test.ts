import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transitionState } from "./session/state-machine";
import type { MemberOperationalState } from "./session/context";
import { createMockContext } from "./test/fixtures/mock-extension-api";

// ── Helpers ────────────────────────────────────────────────

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
    expect(toolNames).toContain("write_shared_context");
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
      expect(result.systemPrompt).toContain("严格模式");
      expect(result.systemPrompt).toContain("不得跳过、调序、合并 stage");
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
      expect(result.systemPrompt).toContain("参考模式");
      expect(result.systemPrompt).toContain("默认按以下步骤顺序执行");
      expect(result.systemPrompt).toContain("【build】");
    });

    it("injects the activation banner near the top when the team has a workflow", async () => {
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
      // Banner appears above the team section (before the workflow detail)
      const bannerIdx = result.systemPrompt.indexOf("本团队定义了「团队工作流」");
      const workflowIdx = result.systemPrompt.indexOf("### 团队工作流");
      expect(bannerIdx).toBeGreaterThanOrEqual(0);
      expect(workflowIdx).toBeGreaterThan(bannerIdx);
      expect(result.systemPrompt).toContain("不得自己开工分析");
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
      expect(result.systemPrompt).not.toContain("本团队定义了「团队工作流」");
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

// ── agent_settled handler tests ───────────────────────────

describe("agent_settled handler", () => {
  let pi: ExtensionAPI;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
  });

  it("registers pi.on for agent_settled", async () => {
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const eventNames = onCalls.map((c: any) => c[0]);
    expect(eventNames).toContain("agent_settled");
  });

  it("clears stale status when session is not active (e.g. /team stop)", async () => {
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);

    const { endSession } = await import("./session/state");
    endSession();

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const handler = onCalls.find((c: any) => c[0] === "agent_settled")![1];

    const ui = createMockUi();
    await handler({}, { ui, signal: {} });

    // Should clear the stale status rather than returning silently
    expect(ui.setStatus).toHaveBeenCalledWith("team-members-running", undefined);
  });

  it("clears status when no members are running", async () => {
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);

    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({ name: "test", description: "", members: [] });

    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    const handler = onCalls.find((c: any) => c[0] === "agent_settled")![1];

    const ui = createMockUi();
    await handler({}, { ui, signal: { aborted: false } });

    expect(ui.setStatus).toHaveBeenCalledWith("team-members-running", undefined);
  });
});

// ── TL first-action protocol prompt injection ─────────────

describe("TL first-action protocol prompt injection", () => {
  let pi: ExtensionAPI;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);
  });

  function getHandler(name: string): Function {
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    return onCalls.find((c: any) => c[0] === name)![1];
  }

  it("injects first-action protocol above the detailed iron-rule section", async () => {
    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "do work" }],
    });

    const handler = getHandler("before_agent_start");
    const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
    expect(result.systemPrompt).toContain("第一动作协议");

    // protocol must appear before the detailed 铁律 section
    const idxProtocol = result.systemPrompt.indexOf("第一动作协议");
    const idxIronRule = result.systemPrompt.indexOf("铁律：你绝不能自己做");
    expect(idxProtocol).toBeGreaterThan(-1);
    expect(idxIronRule).toBeGreaterThan(-1);
    expect(idxProtocol).toBeLessThan(idxIronRule);
    endSession();
  });

  it("bounds the 'verify with code' rule to 1-2 files (removes contradiction with delegation)", async () => {
    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "do work" }],
    });

    const handler = getHandler("before_agent_start");
    const result = await handler({ systemPrompt: "BASE" }, { ui: createMockUi() });
    expect(result.systemPrompt).toContain("允许读取 1-2 个文件");
    // old wording gave the model a loophole to analyze code itself
    expect(result.systemPrompt).not.toContain("先查阅代码再给出结论");
    endSession();
  });
});

// ── TL pre-dispatch guard in tool_call handler ────────────────────

describe("TL pre-dispatch guard in tool_call handler", () => {
  let pi: ExtensionAPI;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);
  });

  function getHandler(name: string): Function {
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    return onCalls.find((c: any) => c[0] === name)![1];
  }

  async function startActiveSession() {
    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "do work" }],
    });
  }

  it("sticky-blocks after the 4th code read until dispatch happens", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    const read = (p: string) => toolCall({ toolName: "read", input: { path: p } });

    expect(read("src/a.ts")).toBeUndefined();
    expect(read("src/b.ts")).toBeUndefined();
    expect(read("src/c.ts")).toBeUndefined();

    const blocked = read("src/d.ts");
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("team_send_and_wait");

    // sticky: no escape hatch before dispatch — subsequent calls stay blocked
    expect(read("src/e.ts")).toEqual(expect.objectContaining({ block: true }));
    expect(read("src/f.ts")).toEqual(expect.objectContaining({ block: true }));
    expect(read("src/g.ts")).toEqual(expect.objectContaining({ block: true }));
  });

  it("unlocks after a dispatch: reads pass again", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    toolCall({ toolName: "read", input: { path: "src/a.ts" } });
    toolCall({ toolName: "read", input: { path: "src/b.ts" } });
    toolCall({ toolName: "read", input: { path: "src/c.ts" } });
    expect(toolCall({ toolName: "read", input: { path: "src/d.ts" } })).toEqual(
      expect.objectContaining({ block: true })
    );

    toolCall({ toolName: "team_send_and_wait", input: { tasks: [{ to: "worker", content: "go" }] } });
    expect(toolCall({ toolName: "read", input: { path: "src/e.ts" } })).toBeUndefined();
    expect(toolCall({ toolName: "bash", input: { command: "grep foo src/" } })).toBeUndefined();
  });

  it("notifies the user on the first block via ctx.ui", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    const ui = createMockUi();
    const ctx = { ui };

    toolCall({ toolName: "read", input: { path: "src/a.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/b.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/c.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/d.ts" } }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("team_send_and_wait"), "warning");
    expect(ui.setStatus).toHaveBeenCalledWith(
      "tl-pre-dispatch-guard",
      expect.stringContaining("拦截")
    );

    // after dispatch, status is cleared
    toolCall({ toolName: "team_send_and_wait", input: { tasks: [{ to: "worker", content: "go" }] } }, ctx);
    expect(ui.setStatus).toHaveBeenLastCalledWith("tl-pre-dispatch-guard", undefined);
  });

  it("never blocks .md reads", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    for (let i = 0; i < 6; i++) {
      expect(toolCall({ toolName: "read", input: { path: `doc${i}.md` } })).toBeUndefined();
    }
  });

  it("does not block code reads after a team_send_and_wait dispatch", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    toolCall({ toolName: "team_send_and_wait", input: { tasks: [{ to: "worker", content: "go" }] } });
    for (let i = 0; i < 6; i++) {
      expect(toolCall({ toolName: "read", input: { path: `src/f${i}.ts` } })).toBeUndefined();
    }
  });

  it("agent_start resets the per-turn budget", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    const agentStart = getHandler("agent_start");
    const read = (p: string) => toolCall({ toolName: "read", input: { path: p } });

    read("src/a.ts");
    read("src/b.ts");
    read("src/c.ts");
    expect(read("src/d.ts")).toEqual(expect.objectContaining({ block: true }));

    agentStart(); // new user-message turn → fresh budget
    expect(read("src/e.ts")).toBeUndefined();
  });

  it("counts bash calls too (not just read) — sticky-blocks when mixed calls exceed threshold", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");

    // 2 reads + 1 bash = 3 calls (at threshold), should pass
    expect(toolCall({ toolName: "read", input: { path: "src/a.ts" } })).toBeUndefined();
    expect(toolCall({ toolName: "bash", input: { command: "grep foo src/*.ts" } })).toBeUndefined();
    expect(toolCall({ toolName: "read", input: { path: "src/b.ts" } })).toBeUndefined();

    // 4th non-management call → block, and stays sticky
    const blocked = toolCall({ toolName: "bash", input: { command: "cat src/c.ts" } });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("team_send_and_wait");
    expect(toolCall({ toolName: "bash", input: { command: "rg foo src/" } })).toEqual(
      expect.objectContaining({ block: true })
    );
  });

  it("never blocks management tools (write, edit, team_send_and_wait, etc.)", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");

    // Many management calls should never trigger the guard
    for (let i = 0; i < 10; i++) {
      expect(toolCall({ toolName: "write", input: { path: "doc.md", content: "# test" } })).toBeUndefined();
      expect(toolCall({ toolName: "edit", input: { path: "doc.md", edits: [] } })).toBeUndefined();
      expect(toolCall({ toolName: "list_members", input: {} })).toBeUndefined();
      expect(toolCall({ toolName: "get_member_log", input: { name: "w" } })).toBeUndefined();
      expect(toolCall({ toolName: "wait_and_get_member_status", input: {} })).toBeUndefined();
    }
  });

  it("does nothing when no team session is active", async () => {
    const { endSession } = await import("./session/state");
    endSession();
    const toolCall = getHandler("tool_call");
    for (let i = 0; i < 6; i++) {
      expect(toolCall({ toolName: "read", input: { path: `src/f${i}.ts` } })).toBeUndefined();
    }
  });
});

// ── Design-phase read limiter (dynamic mode) in tool_call handler ────

describe("design-phase read limiter in tool_call handler", () => {
  let pi: ExtensionAPI;
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    tmpDir = mkdtempSync(join(tmpdir(), "design-read-guard-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);
    // Enter the REAL design phase via /team dynamic (flips the internal
    // teamCtx to isDynamicSession=true + dynamicPhase="design").
    const cmdDef = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await cmdDef.handler("dynamic", createMockContext());
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getHandler(name: string): Function {
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    return onCalls.find((c: any) => c[0] === name)![1];
  }

  it("blocks non-whitelisted tools in the design phase (bash etc.)", () => {
    const toolCall = getHandler("tool_call");
    const blocked = toolCall({ toolName: "bash", input: { command: "ls" } });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("设计阶段");
  });

  it("allows read, then soft-blocks every 4th code read with a reminder (next read passes again)", () => {
    const toolCall = getHandler("tool_call");
    const read = (p: string) => toolCall({ toolName: "read", input: { path: p } });

    expect(read("src/a.ts")).toBeUndefined();
    expect(read("src/b.ts")).toBeUndefined();
    expect(read("src/c.ts")).toBeUndefined();

    const blocked = read("src/d.ts");
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("再次调用 read");

    // soft: genuinely needed reads are retryable — NOT sticky
    expect(read("src/e.ts")).toBeUndefined();
    expect(read("src/f.ts")).toBeUndefined();
    expect(read("src/g.ts")).toBeUndefined();
    expect(read("src/h.ts")).toEqual(expect.objectContaining({ block: true })); // 8th
  });

  it("never blocks .md reads in the design phase", () => {
    const toolCall = getHandler("tool_call");
    for (let i = 0; i < 6; i++) {
      expect(toolCall({ toolName: "read", input: { path: `docs/readme${i}.md` } })).toBeUndefined();
    }
  });

  it("notifies the user on the first design-phase read block via ctx.ui", () => {
    const toolCall = getHandler("tool_call");
    const ui = createMockUi();
    const ctx = { ui };

    toolCall({ toolName: "read", input: { path: "src/a.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/b.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/c.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/d.ts" } }, ctx);

    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("read"), "warning");
    expect(ui.setStatus).toHaveBeenCalledWith("tl-design-read-guard", expect.stringContaining("read"));

    // next blocked read (8th) does NOT re-notify (firstBlock only on first)
    ui.notify.mockClear();
    toolCall({ toolName: "read", input: { path: "src/e.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/f.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/g.ts" } }, ctx);
    toolCall({ toolName: "read", input: { path: "src/h.ts" } }, ctx);
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("agent_start resets the design-phase read budget", () => {
    const toolCall = getHandler("tool_call");
    const agentStart = getHandler("agent_start");
    const read = (p: string) => toolCall({ toolName: "read", input: { path: p } });

    read("src/a.ts");
    read("src/b.ts");
    read("src/c.ts");
    expect(read("src/d.ts")).toEqual(expect.objectContaining({ block: true }));

    agentStart(); // new user-message turn → fresh budget
    expect(read("src/e.ts")).toBeUndefined();
    expect(read("src/f.ts")).toBeUndefined();
    expect(read("src/g.ts")).toBeUndefined();
    expect(read("src/h.ts")).toEqual(expect.objectContaining({ block: true })); // 4th again
  });

  it("execution-phase sticky guard does not apply in the design phase", () => {
    const toolCall = getHandler("tool_call");
    // 4+ code reads: soft blocks only, never the sticky pre-dispatch guard
    for (let i = 0; i < 8; i++) {
      const v = toolCall({ toolName: "read", input: { path: `src/f${i}.ts` } });
      if (v) {
        expect(v.reason).toContain("设计阶段");
        expect(v.reason).not.toContain("team_send_and_wait");
      }
    }
  });
});

// ── write_shared_context gate: whitelist + direct-write interception ────

describe("write_shared_context in tool_call guard", () => {
  let pi: ExtensionAPI;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);
  });

  function getHandler(name: string): Function {
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    return onCalls.find((c: any) => c[0] === name)![1];
  }

  async function startActiveSession() {
    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "do work" }],
    });
  }

  it("write_shared_context is whitelisted during an active session", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    const verdict = toolCall({ toolName: "write_shared_context", input: { content: "# doc" } });
    expect(verdict).toBeUndefined(); // not blocked
  });

  it("blocks write to .shared-context.md and redirects to write_shared_context", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");

    const blocked = toolCall({
      toolName: "write",
      input: { path: "/tmp/sessions/test-team/abc/.shared-context.md", content: "# doc" },
    });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("write_shared_context");
  });

  it("blocks edit to .shared-context.md as well", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");

    const blocked = toolCall({
      toolName: "edit",
      input: { path: "sessions/test-team/abc/.shared-context.md", edits: [] },
    });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("write_shared_context");
  });

  it("still allows write to other .md files", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "write", input: { path: "/tmp/docs/adr-001.md", content: "# ADR" } })).toBeUndefined();
  });

  it("still blocks write to code files", async () => {
    await startActiveSession();
    const toolCall = getHandler("tool_call");
    const blocked = toolCall({ toolName: "write", input: { path: "/tmp/src/a.ts", content: "code" } });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("代码文件");
  });
});
