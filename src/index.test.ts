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

  it("registers ONLY start_team_session at load (ADR-0003 exception to session-scoped registration)", async () => {
    const mod = await import("../index");
    mod.default(pi);

    // In this fresh-load test, session-only tools (start_member …
    // wait_and_get_member_status, write_shared_context, set_goal/finish_goal,
    // stop_team_session) have not yet been registered. A real session starts
    // registration on-demand (onSessionStart → ensureSessionToolsRegistered);
    // after the first registration pi retains them because it has no unregister
    // API, while before_agent_start removes them from activeTools outside a
    // session. The single deliberate exception (ADR-0003): start_team_session
    // is registered at load so the agent can autonomously enter a session.
    const registered = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: any) => c[0].name
    );
    expect(registered).toEqual(["start_team_session"]);
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

// ── Agent-initiated session: full tool freedom (ADR-0003 revision) ────

// Sessions started via start_team_session (origin: "agent") no longer restrict
// the TL's tools: the early-exit branch fires BEFORE phase/whitelist resolution,
// so design + execution phases both allow write/edit (any extension), bash,
// ctx_execute, fetch_content, mcp, etc. — the same tool surface as normal mode.
// The single origin-independent rule that remains: .shared-context.md must be
// written via write_shared_context (the start_member hard gate depends on that
// tool setting the session flag — a mechanism contract, not a file-type
// restriction). User-origin sessions (/team start, /team dynamic) are untouched.

describe("agent-initiated session tool_call guard (ADR-0003 revision)", () => {
  let pi: ExtensionAPI;
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    tmpDir = mkdtempSync(join(tmpdir(), "agent-guard-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getHandler(name: string): Function {
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    return onCalls.find((c: any) => c[0] === name)![1];
  }

  async function startAgentSession() {
    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession(
      {
        name: "test-agent-team",
        description: "Test",
        members: [{ name: "worker", systemPrompt: "do work" }],
      },
      { origin: "agent" },
    );
  }

  /**
   * Start a REAL agent-initiated session via the load-time start_team_session
   * tool (the production entry point): bootstrapDynamicSession flips the
   * internal teamCtx to isDynamicSession=true + dynamicPhase="design" and
   * starts the session with origin "agent" — no state-manipulation hacks.
   */
  async function startAgentDesignPhase() {
    const { endSession } = await import("./session/state");
    endSession();
    const toolDef = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.find(
      ([def]: any) => def.name === "start_team_session"
    )![0];
    await toolDef.execute("id", { task: "测试使命：验证 agent 会话守卫" }, undefined, undefined, createMockContext());
  }

  it("design phase: write to a code file is allowed", async () => {
    await startAgentDesignPhase();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "write", input: { path: "/tmp/src/a.ts", content: "code" } })).toBeUndefined();
  });

  it("design phase: edit to a code file is allowed", async () => {
    await startAgentDesignPhase();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "edit", input: { path: "/tmp/src/a.ts", edits: [] } })).toBeUndefined();
  });

  it("design phase: bash is allowed (inverse of the user-origin design-phase block)", async () => {
    await startAgentDesignPhase();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "bash", input: { command: "cat src/a.ts" } })).toBeUndefined();
  });

  it("design phase: non-whitelist tools (fetch_content, ctx_execute) are allowed", async () => {
    await startAgentDesignPhase();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "fetch_content", input: { url: "https://example.com" } })).toBeUndefined();
    expect(toolCall({ toolName: "ctx_execute", input: { language: "bash", code: "ls" } })).toBeUndefined();
  });

  it("execution phase: write/edit to code files are allowed", async () => {
    await startAgentSession();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "write", input: { path: "src/lib.ts", content: "code" } })).toBeUndefined();
    expect(toolCall({ toolName: "edit", input: { path: "src/lib.ts", edits: [] } })).toBeUndefined();
  });

  it("execution phase: non-whitelist tool (ctx_execute) is allowed", async () => {
    await startAgentSession();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "ctx_execute", input: { language: "bash", code: "ls" } })).toBeUndefined();
  });

  it("design phase: write to .shared-context.md still blocked, redirected to write_shared_context", async () => {
    await startAgentDesignPhase();
    const toolCall = getHandler("tool_call");
    const blocked = toolCall({
      toolName: "write",
      input: { path: "/tmp/sessions/test-agent-team/abc/.shared-context.md", content: "# doc" },
    });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("write_shared_context");
  });

  it("execution phase: edit to .shared-context.md still blocked", async () => {
    await startAgentSession();
    const toolCall = getHandler("tool_call");
    const blocked = toolCall({
      toolName: "edit",
      input: { path: "sessions/test-agent-team/abc/.shared-context.md", edits: [] },
    });
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("write_shared_context");
  });

  it("write_shared_context itself is allowed", async () => {
    await startAgentSession();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "write_shared_context", input: { content: "# doc" } })).toBeUndefined();
  });

  it("management tools still pass through (dispatch tracking unaffected)", async () => {
    await startAgentSession();
    const toolCall = getHandler("tool_call");
    expect(toolCall({ toolName: "team_send_and_wait", input: { tasks: [{ to: "worker", content: "go" }] } })).toBeUndefined();
    expect(toolCall({ toolName: "list_members", input: {} })).toBeUndefined();
    expect(toolCall({ toolName: "start_member", input: { name: "worker" } })).toBeUndefined();
  });

  it("regression: user-origin sessions still block code writes and design-phase bash", async () => {
    const { startSession, endSession } = await import("./session/state");

    // user-origin execution phase: code write blocked
    endSession();
    startSession({ name: "test-team", description: "Test", members: [{ name: "w", systemPrompt: "x" }] });
    const toolCall = getHandler("tool_call");
    const blockedExec = toolCall({ toolName: "write", input: { path: "/tmp/src/a.ts", content: "code" } });
    expect(blockedExec).toEqual(expect.objectContaining({ block: true }));
    expect(blockedExec.reason).toContain("代码文件");

    // user-origin design phase (real /team dynamic): code write + bash blocked
    endSession();
    const cmdDef = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await cmdDef.handler("dynamic", createMockContext());
    const blockedDesign = toolCall({ toolName: "write", input: { path: "/tmp/src/a.ts", content: "code" } });
    expect(blockedDesign).toEqual(expect.objectContaining({ block: true }));
    expect(blockedDesign.reason).toContain("代码文件");
    expect(toolCall({ toolName: "bash", input: { command: "ls" } })).toEqual(expect.objectContaining({ block: true }));
  });
});

// ── Session-ended banner in before_agent_start ─────────────────────

// After the user exits a team session (/team stop or stop_team_session), the
// TL's history still contains the Team Lead system prompt and team-tool usage
// patterns. The teardown sets the one-shot sessionEndedNotice flag; the next
// before_agent_start consumes it and injects a banner telling the agent the
// session is over — riding the next user-initiated turn, never triggering a
// conversation of its own.

describe("session-ended banner in before_agent_start", () => {
  let pi: ExtensionAPI;
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    tmpDir = mkdtempSync(join(tmpdir(), "session-ended-banner-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getHandler(name: string): Function {
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    return onCalls.find((c: any) => c[0] === name)![1];
  }

  function getTeamCommandHandler() {
    return (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
  }

  async function runStop() {
    const cmdDef = getTeamCommandHandler();
    await cmdDef.handler("stop", createMockContext());
  }

  async function runBeforeAgentStart(systemPrompt = "BASE", ctx: any = { ui: createMockUi() }) {
    const handler = getHandler("before_agent_start");
    return handler({ systemPrompt }, ctx);
  }

  it("injects the session-ended banner once on the next turn after /team stop (no new conversation)", async () => {
    // Enter a real team session via /team dynamic (no YAML needed on disk)
    const cmdDef = getTeamCommandHandler();
    await cmdDef.handler("dynamic", createMockContext());

    // Turn while the session is active: normal TL prompt, no banner
    let result = await runBeforeAgentStart();
    expect(result.systemPrompt).toContain("Team Lead");
    expect(result.systemPrompt).not.toContain("团队会话已结束");

    // User exits the session via /team stop
    await runStop();

    // Next turn: the one-shot banner tells the TL the session is over and the
    // team tools are deactivated — the TL stops acting as Team Lead
    result = await runBeforeAgentStart();
    expect(result.systemPrompt).toContain("团队会话已结束");
    expect(result.systemPrompt).toContain("team_send_and_wait");
    expect(result.systemPrompt).toContain("普通模式");
    // The banner asserts authority over the stale Team Lead traces in history
    // (the real-world root cause: the model trusted its historical successful
    // team tool calls over a plain "session ended" line).
    expect(result.systemPrompt).toContain("以本提示为准");
    expect(result.systemPrompt).toContain("痕迹均已失效");
    // The Team Lead prompt section is gone (only the banner's mention remains)
    expect(result.systemPrompt).not.toContain("当前任务：Team Lead");

    // Second turn: banner consumed — not repeated (no prompt modification at all)
    result = await runBeforeAgentStart();
    expect(result).toBeUndefined();
  });

  it("no banner when no team session was ever active", async () => {
    const result = await runBeforeAgentStart();
    expect(result).toBeUndefined();
  });

  it("drops the pending notice when a new session starts before it is consumed", async () => {
    // Exit one session, then immediately start another (/team dynamic again)
    // before any turn boundary — the stale notice must not leak into the new
    // session's prompt.
    const cmdDef = getTeamCommandHandler();
    await cmdDef.handler("dynamic", createMockContext());
    await runStop();
    await cmdDef.handler("dynamic", createMockContext());

    const result = await runBeforeAgentStart();
    expect(result.systemPrompt).toContain("Team Lead");
    expect(result.systemPrompt).not.toContain("团队会话已结束");
  });

  it("no banner in a fresh /new conversation — session_start reason 'new' clears the pending notice", async () => {
    // /team stop leaves the notice pending…
    const cmdDef = getTeamCommandHandler();
    await cmdDef.handler("dynamic", createMockContext());
    await runStop();

    // …then the user starts a brand-new conversation (/new): session_start
    // fires with reason "new" and must drop the stale notice.
    const sessionStart = getHandler("session_start");
    await sessionStart({ type: "session_start", reason: "new" }, createMockContext());

    // First turn of the new conversation: no banner (not even fail-open, the
    // flag is gone).
    const result = await runBeforeAgentStart();
    expect(result).toBeUndefined();
  });

  it("no banner when the current history has no team traces (e.g. /new without the session_start reason signal)", async () => {
    const cmdDef = getTeamCommandHandler();
    await cmdDef.handler("dynamic", createMockContext());
    await runStop();

    // Fresh-conversation history: only an ordinary user message, no team tools.
    const freshCtx = {
      ui: createMockUi(),
      sessionManager: {
        getEntries: () => [
          { type: "message", message: { role: "user", content: "hello" } },
        ],
      },
    };
    const result = await runBeforeAgentStart(undefined, freshCtx);
    expect(result).toBeUndefined();
  });

  it("banner fires when the history contains team traces (fork/resume of a team conversation)", async () => {
    const cmdDef = getTeamCommandHandler();
    await cmdDef.handler("dynamic", createMockContext());
    await runStop();

    // Copied/restored history: an assistant team tool call is a durable trace.
    const tracedCtx = {
      ui: createMockUi(),
      sessionManager: {
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "let me dispatch" },
                { type: "toolCall", id: "t1", name: "team_send_and_wait", arguments: {} },
              ],
            },
          },
        ],
      },
    };
    const result = await runBeforeAgentStart(undefined, tracedCtx);
    expect(result.systemPrompt).toContain("团队会话已结束");

    // Consumed exactly once.
    const again = await runBeforeAgentStart(undefined, tracedCtx);
    expect(again).toBeUndefined();
  });

  it("banner fires on routed member messages too (custom_message team-message trace)", async () => {
    const cmdDef = getTeamCommandHandler();
    await cmdDef.handler("dynamic", createMockContext());
    await runStop();

    const tracedCtx = {
      ui: createMockUi(),
      sessionManager: {
        getEntries: () => [
          { type: "custom_message", customType: "team-message", content: "member reply" },
        ],
      },
    };
    const result = await runBeforeAgentStart(undefined, tracedCtx);
    expect(result.systemPrompt).toContain("团队会话已结束");
  });
});
