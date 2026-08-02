import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTlTools, WAIT_IDLE_CHECK_INTERVAL_MS, WAIT_IDLE_REQUIRED_CONSECUTIVE } from "./tl-tools";
import { startSession, endSession, markSharedContextWritten } from "../session/state";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { ResponseWaiter, WaitResult } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { MemberOperationalState } from "../session/context";

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: vi.fn((def: any) => {
      tools.push(def);
    }),
    getAllTools: vi.fn().mockReturnValue(tools),
    getActiveTools: vi.fn().mockReturnValue(tools.map((t: any) => t.name)),
    setActiveTools: vi.fn(),
  } as any;
}

function createMockManager(): ProcessManager {
  const opsMap = new Map<string, any>();
  return {
    listStatus: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    handleExit: vi.fn(),
    addHandle: vi.fn(),
    setOperationalState: vi.fn((name, state) => opsMap.set(name, state)),
    getOperationalState: vi.fn((name) => opsMap.get(name)),
    getOperationalStateMap: vi.fn(() => opsMap),
  };
}

function createMockResponseWaiter(): ResponseWaiter {
  return {
    waitForResponse: vi.fn(),
    resolveIfWaiting: vi.fn().mockReturnValue(false),
    cancelAll: vi.fn(),
    cancelByCorrId: vi.fn(),
  };
}

function createMockMessageQueue(): MessageQueue {
  return {
    enqueue: vi.fn(),
    length: vi.fn().mockReturnValue(0),
    drain: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
}

describe("registerTlTools", () => {
  let pi: ExtensionAPI;
  let manager: ProcessManager;
  let responseWaiter: ResponseWaiter;
  let memberOpsStates: Map<string, MemberOperationalState>;
  let lastPendingCorrId: Map<string, string>;
  let messageQueue: MessageQueue;

  beforeEach(() => {
    vi.restoreAllMocks();
    pi = createMockPi();
    manager = createMockManager();
    responseWaiter = createMockResponseWaiter();
    memberOpsStates = new Map();
    lastPendingCorrId = new Map();
    messageQueue = createMockMessageQueue();
  });

  function callRegisterTlTools(overrides?: {
    createMember?: any;
    buildMemberConfig?: any;
    getMemberLog?: any;
  }) {
    registerTlTools({
      pi,
      manager,
      responseWaiter,
      memberOpsStates,
      lastPendingCorrId,
      messageQueue,
      createMember: overrides?.createMember,
      buildMemberConfig: overrides?.buildMemberConfig,
      getMemberLog: overrides?.getMemberLog,
    });
  }

  /** Open the start_member gate: an active session whose shared context was written. */
  function openStartMemberGate() {
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "analyzer", systemPrompt: "analyze" }],
    });
    markSharedContextWritten();
  }

  it("registers 6 tools (add_dynamic_member is registered dynamically in /team dynamic)", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledTimes(6);
  });

  it("registers start_member tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "start_member" })
    );
  });

  it("start_member execute calls createMember when buildMemberConfig returns a config", async () => {
    openStartMemberGate();
    const createMember = vi.fn().mockReturnValue({
      name: "analyzer",
      start: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue({ name: "analyzer", pid: 12345, status: "running" }),
      stop: vi.fn(),
      onEvent: vi.fn(),
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn(),
    });
    const buildConfig = vi.fn().mockReturnValue({
      name: "analyzer",
      role: "analyzer",
      teamName: "test",
    });

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") {
        executeFn = def.execute;
      }
    });

    callRegisterTlTools({ createMember, buildMemberConfig: buildConfig });

    const result = await executeFn("call-1", { name: "analyzer" });
    expect(buildConfig).toHaveBeenCalledWith("analyzer");
    expect(createMember).toHaveBeenCalled();
    expect(result.content[0].text).toContain("已启动");
  });

  it("start_member returns error when buildMemberConfig returns null", async () => {
    openStartMemberGate();
    const buildConfig = vi.fn().mockReturnValue(null);

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") {
        executeFn = def.execute;
      }
    });

    callRegisterTlTools({ buildMemberConfig: buildConfig });

    const result = await executeFn("call-2", { name: "nonexistent" });
    expect(result.content[0].text).toContain("无法启动");
  });

  it("start_member is BLOCKED when the shared context has not been written", async () => {
    // Session active but write_shared_context never called → gate closed
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "analyzer", systemPrompt: "analyze" }],
    });

    const createMember = vi.fn();
    const buildConfig = vi.fn().mockReturnValue({ name: "analyzer", role: "analyzer", teamName: "test" });

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") {
        executeFn = def.execute;
      }
    });

    callRegisterTlTools({ createMember, buildMemberConfig: buildConfig });

    const result = await executeFn("call-1", { name: "analyzer" });
    expect(result.content[0].text).toContain("共享上下文尚未写入");
    expect(result.content[0].text).toContain("write_shared_context");
    // Must NOT proceed to member creation
    expect(buildConfig).not.toHaveBeenCalled();
    expect(createMember).not.toHaveBeenCalled();
  });

  it("start_member is BLOCKED outside an active session even if the flag was set", async () => {
    // Flag was set in a previous session, then the session ended
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "analyzer", systemPrompt: "analyze" }],
    });
    markSharedContextWritten();
    endSession();

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") {
        executeFn = def.execute;
      }
    });

    callRegisterTlTools({ buildMemberConfig: vi.fn() });

    const result = await executeFn("call-2", { name: "analyzer" });
    expect(result.content[0].text).toContain("共享上下文尚未写入");
  });

  it("registers stop_member tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "stop_member" })
    );
  });

  it("registers start_member with promptGuidelines mentioning the shared context gate", () => {
    callRegisterTlTools();
    const def = pi.registerTool.mock.calls.find((c: any[]) => c[0].name === "start_member")![0];
    expect(def.promptGuidelines.join("\n")).toContain("Shared Context");
  });

  it("registers list_members tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "list_members" })
    );
  });

  it("registers get_member_log tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "get_member_log" })
    );
  });

  it("registers team_send_and_wait tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "team_send_and_wait" })
    );
  });

  it("registers wait_and_get_member_status tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "wait_and_get_member_status" })
    );
  });

  it("get_member_log tool parameters include maxContentLength", () => {
    let toolDef: any = null;
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "get_member_log") {
        toolDef = def;
      }
    });

    callRegisterTlTools();

    expect(toolDef).not.toBeNull();
    expect(toolDef.parameters.properties.maxContentLength).toBeDefined();
    expect(toolDef.parameters.properties.maxContentLength.type).toBe("number");
  });

  it("get_member_log execute passes maxContentLength to getMemberLog", async () => {
    const getMemberLogMock = vi.fn().mockResolvedValue("[user] hello\n[assistant] world");
    manager.getStatus = vi.fn().mockReturnValue({ name: "coder", status: "running", pid: 123 });

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "get_member_log") {
        executeFn = def.execute;
      }
    });

    callRegisterTlTools({ getMemberLog: getMemberLogMock });

    const result = await executeFn("call-1", { name: "coder", lines: 5, maxContentLength: 20 });
    expect(getMemberLogMock).toHaveBeenCalledWith("coder", 5, 20);
    expect(result.content[0].text).toContain("最近对话");
  });

  it("get_member_log execute defaults maxContentLength when not provided", async () => {
    const getMemberLogMock = vi.fn().mockResolvedValue("[user] hello");
    manager.getStatus = vi.fn().mockReturnValue({ name: "coder", status: "running", pid: 123 });

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "get_member_log") {
        executeFn = def.execute;
      }
    });

    callRegisterTlTools({ getMemberLog: getMemberLogMock });

    const result = await executeFn("call-2", { name: "coder", lines: 10 });
    expect(getMemberLogMock).toHaveBeenCalledWith("coder", 10, undefined);
    expect(result.content[0].text).toContain("最近对话");
  });

  describe("team_send_and_wait", () => {
    it("team_send_and_wait parameters include tasks and nextSteps", () => {
      let toolDef: any = null;
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          toolDef = def;
        }
      });

      callRegisterTlTools();

      expect(toolDef.parameters.required).toContain("tasks");
      expect(toolDef.parameters.required).toContain("nextSteps");
      expect(toolDef.parameters.properties.tasks).toBeDefined();
      expect(toolDef.parameters.properties.tasks.oneOf).toBeDefined();
      expect(toolDef.parameters.properties.tasks.oneOf[0].type).toBe("array");
      expect(toolDef.parameters.properties.tasks.oneOf[0].items.properties.to).toBeDefined();
      expect(toolDef.parameters.properties.tasks.oneOf[0].items.properties.content).toBeDefined();
      expect(toolDef.parameters.properties.tasks.oneOf[0].items.required).toContain("to");
      expect(toolDef.parameters.properties.tasks.oneOf[0].items.required).toContain("content");
      expect(toolDef.parameters.properties.tasks.oneOf[1].type).toBe("string");
      expect(toolDef.parameters.properties.nextSteps).toBeDefined();
      expect(toolDef.parameters.properties.nextSteps.type).toBe("string");
      // Old fields removed
      expect(toolDef.parameters.properties.to).toBeUndefined();
      expect(toolDef.parameters.properties.content).toBeUndefined();
    });

    it("team_send_and_wait execute sends single task and waits for response", async () => {
      memberOpsStates.set("worker", "idle");

      const mockResponseWaiter = createMockResponseWaiter();
      mockResponseWaiter.waitForResponse = vi.fn().mockResolvedValue({
        status: "response",
        from: "worker",
        content: "Task done",
      });

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      registerTlTools({
        pi,
        manager,
        responseWaiter: mockResponseWaiter,
        memberOpsStates,
        lastPendingCorrId,
        messageQueue,
      });

      const result = await executeFn("call-1", {
        tasks: [{ to: "worker", content: "Do the task" }],
        nextSteps: "Check the result and assign the next task",
      });

      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "worker" })
      );
      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("Task done");
      expect(result.content[0].text).toContain("下一步计划");
      expect(result.details).toEqual({ nextSteps: "Check the result and assign the next task" });
    });

    it("team_send_and_wait execute sends batch tasks and waits for all responses", async () => {
      memberOpsStates.set("security-reviewer", "idle");
      memberOpsStates.set("perf-reviewer", "idle");

      const mockResponseWaiter = createMockResponseWaiter();
      // Each waitForResponse call returns a promise; we resolve them in order
      const resolveFns: Array<(value: WaitResult) => void> = [];
      mockResponseWaiter.waitForResponse = vi.fn(() => new Promise<WaitResult>((resolve) => {
        resolveFns.push(resolve);
      }));

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      registerTlTools({
        pi,
        manager,
        responseWaiter: mockResponseWaiter,
        memberOpsStates,
        lastPendingCorrId,
        messageQueue,
      });

      const resultPromise = executeFn("call-1", {
        tasks: [
          { to: "security-reviewer", content: "审查安全" },
          { to: "perf-reviewer", content: "审查性能" },
        ],
        nextSteps: "合并审查意见",
      });

      // Verify both messages were enqueued
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "security-reviewer" })
      );
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "perf-reviewer" })
      );

      // Resolve both waiters
      resolveFns[0]({ status: "response", from: "security-reviewer", content: "安全无问题" });
      resolveFns[1]({ status: "response", from: "perf-reviewer", content: "发现 O(n²) 循环" });

      const result = await resultPromise;

      expect(result.content[0].text).toContain("security-reviewer");
      expect(result.content[0].text).toContain("安全无问题");
      expect(result.content[0].text).toContain("perf-reviewer");
      expect(result.content[0].text).toContain("发现 O(n²) 循环");
      expect(result.content[0].text).toContain("下一步计划");
      expect(result.details).toEqual({ nextSteps: "合并审查意见" });
    });

    it("team_send_and_wait returns partial results when all members become idle", {"timeout": 15000}, async () => {
      memberOpsStates.set("security-reviewer", "idle");
      memberOpsStates.set("perf-reviewer", "idle");

      const mockResponseWaiter = createMockResponseWaiter();
      // One resolves, one never resolves
      mockResponseWaiter.waitForResponse = vi.fn((corrId: string) => {
        if (corrId.includes("resolve")) {
          return Promise.resolve({ status: "response", from: "security-reviewer", content: "完成" });
        }
        return new Promise<WaitResult>(() => {}); // never resolves
      });

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      // We need to intercept corrId generation. The test uses mock so we can't control it.
      // Instead, use a different approach: use the existing mock that never resolves
      // and rely on all-idle detection.
      // Actually let's use a simpler approach — use the existing responseWaiter mock
      // with a never-resolving promise for all tasks, then all-idle wins.
      responseWaiter.waitForResponse = vi.fn(() => new Promise<WaitResult>(() => {}));

      callRegisterTlTools();

      const result = await executeFn("call-2", {
        tasks: [
          { to: "security-reviewer", content: "审查安全" },
          { to: "perf-reviewer", content: "审查性能" },
        ],
        nextSteps: "处理检查结果",
      });

      expect(result.details).toHaveProperty("allIdle");
      expect(result.details).toHaveProperty("partial");
      expect(result.details).toHaveProperty("nextSteps");
      expect(result.details.nextSteps).toBe("处理检查结果");
      // Should show both members with warning since none resolved
      expect(result.content[0].text).toContain("security-reviewer");
      expect(result.content[0].text).toContain("perf-reviewer");
      expect(result.content[0].text).toContain("⚠️");
    });

    it("team_send_and_wait returns error for empty tasks array", async () => {
      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-1", {
        tasks: [],
        nextSteps: "do something",
      });

      expect(result.content[0].text).toContain("无效");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it("team_send_and_wait auto-recovers from string-encoded tasks array", async () => {
      memberOpsStates.set("planner", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // Simulate LLM double-encoding: tasks is a JSON string instead of raw array
      const result = await executeFn("call-1", {
        tasks: JSON.stringify([{ to: "planner", content: "Do the plan" }]),
        nextSteps: "review the plan",
      });

      // Should still have sent the message
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
      // Response waiter should have been set up
      const callArg = messageQueue.enqueue.mock.calls[0][0];
      expect(callArg.content).toContain("Do the plan");
      expect(callArg.content).toMatch(/<corr:[a-z0-9]+>/);
    });

    it("team_send_and_wait auto-recovers from single-object tasks (non-array hallucination)", async () => {
      memberOpsStates.set("planner", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // Simulate LLM sending a single object instead of array
      const result = await executeFn("call-1", {
        tasks: { to: "planner", content: "Do the plan" },
        nextSteps: "review",
      });

      // Should still have sent the message
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
    });

    it("team_send_and_wait salvages complete tasks from a truncated string-encoded array", async () => {
      memberOpsStates.set("planner", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // Simulate LLM output truncation: first task complete, second task cut off mid-string
      const truncated =
        '[{"to": "planner", "content": "Do the plan"}, {"to": "analyst", "content": "现在kanban界面，全局视图和项目视图分成了两';

      const result = await executeFn("call-1", {
        tasks: truncated,
        nextSteps: "continue",
      });

      // The complete task should still be dispatched
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
      // The TL must be told about the salvage + the dropped truncated entry
      expect(result.content[0].text).toContain("已尽力恢复 1 个任务");
      expect(result.content[0].text).toContain("丢弃 1 个不完整条目");
    });

    it("team_send_and_wait salvages content containing raw newlines from string-encoded tasks", async () => {
      memberOpsStates.set("planner", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // Strict JSON forbids raw control chars in strings, but LLMs emit them when double-encoding
      const withRawNewline = '[{"to": "planner", "content": "line1\nline2"}]';
      expect(() => JSON.parse(withRawNewline)).toThrow(); // confirm strict parse really fails

      await executeFn("call-1", {
        tasks: withRawNewline,
        nextSteps: "continue",
      });

      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      const callArg = messageQueue.enqueue.mock.calls[0][0];
      expect(callArg.to).toBe("planner");
      expect(callArg.content).toContain("line1\nline2");
    });

    it("team_send_and_wait drops invalid entries from a raw array and warns", async () => {
      memberOpsStates.set("planner", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-1", {
        tasks: [{ to: "planner", content: "ok" }, { to: 123 }, "junk", {}],
        nextSteps: "continue",
      });

      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
      expect(result.content[0].text).toContain("3 个条目");
    });

    it("team_send_and_wait error for unrecoverable string includes JSON.parse failure detail", async () => {
      memberOpsStates.set("planner", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-1", {
        tasks: "not json at all",
        nextSteps: "continue",
      });

      expect(result.content[0].text).toContain("无效");
      expect(result.content[0].text).toContain("JSON.parse 失败原因");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it("team_send_and_wait returns error when no members are started", async () => {
      // memberOpsStates is empty — no members started

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-1", {
        tasks: [{ to: "worker", content: "Do something" }],
        nextSteps: "next",
      });

      expect(result.content[0].text).toContain("还没有启动任何团队成员");
      expect(result.content[0].text).toContain("start_member");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it("team_send_and_wait returns error when target member does not exist", async () => {
      memberOpsStates.set("existing-member", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-1", {
        tasks: [{ to: "nonexistent-member", content: "Do something" }],
        nextSteps: "next",
      });

      expect(result.content[0].text).toContain("不存在或未启动");
      expect(result.content[0].text).toContain("nonexistent-member");
      expect(result.content[0].text).toContain("existing-member");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("wait_and_get_member_status", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("wait_and_get_member_status returns empty message when no members", async () => {
      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-1");
      expect(result.content[0].text).toContain("还没有启动任何团队成员");
    });

    it("wait_and_get_member_status returns immediately when all members already idle", async () => {
      memberOpsStates.set("analyzer", "idle");
      memberOpsStates.set("worker", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-2");
      expect(result.content[0].text).toContain("analyzer");
      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("idle");
    });

    it("wait_and_get_member_status waits until all members become idle", { timeout: 5000 }, async () => {
      vi.useFakeTimers();

      memberOpsStates.set("analyzer", "idle");
      memberOpsStates.set("worker", "working");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // Start the execute (will block waiting for worker to become idle)
      const resultPromise = executeFn("call-3");

      // Advance timers partway — worker is still working, so no resolve yet
      await vi.advanceTimersByTimeAsync(WAIT_IDLE_CHECK_INTERVAL_MS * 2);

      // Now make worker idle
      memberOpsStates.set("worker", "idle");

      // Advance enough for 4 consecutive idle checks
      await vi.advanceTimersByTimeAsync(WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 1));

      const result = await resultPromise;
      expect(result.content[0].text).toContain("analyzer");
      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("idle");
    });

    it("wait_and_get_member_status does NOT hang when members are stopped", async () => {
      memberOpsStates.set("analyzer", "stopped");
      memberOpsStates.set("worker", "stopped");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // Should return immediately without waiting — "stopped" is not an active state
      const result = await executeFn("call-1");
      expect(result.content[0].text).toContain("analyzer");
      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("stopped");
    });

    it("wait_and_get_member_status does NOT hang when some members are stopped and some idle", async () => {
      memberOpsStates.set("analyzer", "stopped");
      memberOpsStates.set("worker", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-2");
      expect(result.content[0].text).toContain("analyzer");
      expect(result.content[0].text).toContain("worker");
    });

    it("wait_and_get_member_status does NOT hang when members are crashed", async () => {
      memberOpsStates.set("analyzer", "crashed");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // Should return immediately without waiting — "crashed" is not an active state
      const result = await executeFn("call-3");
      expect(result.content[0].text).toContain("analyzer");
      expect(result.content[0].text).toContain("crashed");
    });
  });
});

// ── Additional execute behavior tests ──────────────────────

describe("stop_member execute", () => {
  let pi: ExtensionAPI;
  let manager: ProcessManager;

  beforeEach(() => {
    pi = createMockPi();
    manager = createMockManager();
  });

  it("stop_member execute calls manager.stop", async () => {
    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "stop_member") executeFn = def.execute;
    });

    registerTlTools({
      pi,
      manager,
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map(),
      lastPendingCorrId: new Map(),
      messageQueue: createMockMessageQueue(),
    });

    const result = await executeFn("call-1", { name: "worker" });
    expect(manager.stop).toHaveBeenCalledWith("worker");
    expect(result.content[0].text).toContain("已停止");
  });
});

describe("list_members execute", () => {
  let pi: ExtensionAPI;
  let manager: ProcessManager;

  beforeEach(() => {
    pi = createMockPi();
    manager = createMockManager();
  });

  it("shows empty message when no members started", async () => {
    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "list_members") executeFn = def.execute;
    });

    registerTlTools({
      pi,
      manager,
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map(),
      lastPendingCorrId: new Map(),
      messageQueue: createMockMessageQueue(),
    });

    const result = await executeFn("call-1");
    expect(result.content[0].text).toContain("还没有启动任何");
  });

  it("shows multi-member statuses", async () => {
    manager.listStatus = vi.fn().mockReturnValue([
      { name: "analyzer", pid: 12345, status: "running" },
      { name: "worker", pid: null, status: "stopped" },
    ]);

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "list_members") executeFn = def.execute;
    });

    registerTlTools({
      pi,
      manager,
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map(),
      lastPendingCorrId: new Map(),
      messageQueue: createMockMessageQueue(),
    });

    const result = await executeFn("call-2");
    expect(result.content[0].text).toContain("analyzer");
    expect(result.content[0].text).toContain("worker");
    expect(result.content[0].text).toContain("running");
    expect(result.content[0].text).toContain("stopped");
    expect(result.content[0].text).toContain("12345");
  });
});

describe("start_member error injection", () => {
  let pi: ExtensionAPI;
  let manager: ProcessManager;

  beforeEach(() => {
    pi = createMockPi();
    manager = createMockManager();
  });

  /** Open the start_member gate: an active session whose shared context was written. */
  function openStartMemberGate() {
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "work" }],
    });
    markSharedContextWritten();
  }

  it("returns error when createMember throws", async () => {
    openStartMemberGate();
    const createMember = vi.fn().mockImplementation(() => {
      throw new Error("Failed to spawn");
    });
    const buildConfig = vi.fn().mockReturnValue({ name: "worker", role: "worker", teamName: "test" });

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") executeFn = def.execute;
    });

    registerTlTools({
      pi,
      manager,
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map(),
      lastPendingCorrId: new Map(),
      messageQueue: createMockMessageQueue(),
      createMember,
      buildMemberConfig: buildConfig,
    });

    const result = await executeFn("call-1", { name: "worker" });
    expect(result.content[0].text).toContain("启动失败");
    expect(result.content[0].text).toContain("Failed to spawn");
  });

  it("returns error when handle.start() throws", async () => {
    openStartMemberGate();
    const createMember = vi.fn().mockReturnValue({
      name: "worker",
      start: vi.fn().mockRejectedValue(new Error("Connection refused")),
      getState: vi.fn(),
      stop: vi.fn(),
      onEvent: vi.fn(),
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn(),
    });
    const buildConfig = vi.fn().mockReturnValue({ name: "worker", role: "worker", teamName: "test" });

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") executeFn = def.execute;
    });

    registerTlTools({
      pi,
      manager,
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map(),
      lastPendingCorrId: new Map(),
      messageQueue: createMockMessageQueue(),
      createMember,
      buildMemberConfig: buildConfig,
    });

    const result = await executeFn("call-2", { name: "worker" });
    expect(result.content[0].text).toContain("启动失败");
    expect(result.content[0].text).toContain("Connection refused");
  });
});


