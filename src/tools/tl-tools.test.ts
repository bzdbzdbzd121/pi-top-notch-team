import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTlTools } from "./tl-tools";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { ResponseWaiter } from "../channel/response-waiter";
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

  it("registers 6 tools", () => {
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

  it("registers stop_member tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "stop_member" })
    );
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

  it("registers get_member_status tool", () => {
    callRegisterTlTools();
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "get_member_status" })
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
    it("team_send_and_wait parameters include required content", () => {
      let toolDef: any = null;
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          toolDef = def;
        }
      });

      callRegisterTlTools();

      expect(toolDef.parameters.required).toContain("to");
      expect(toolDef.parameters.required).toContain("content");
      expect(toolDef.parameters.properties.content).toBeDefined();
      expect(toolDef.parameters.properties.content.type).toBe("string");
    });

    it("team_send_and_wait execute sends message and waits for response", async () => {
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

      const result = await executeFn("call-1", { to: "worker", content: "Do the task" });

      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "worker" })
      );
      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("Task done");
      expect(result.details).toEqual({});
    });

    it("team_send_and_wait execute returns timeout result after timeout", async () => {
      const mockResponseWaiter = createMockResponseWaiter();
      mockResponseWaiter.waitForResponse = vi.fn().mockResolvedValue({
        status: "timeout",
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

      const result = await executeFn("call-2", { to: "worker", content: "Hello" });

      expect(result.content[0].text).toContain("Timeout");
      expect(result.details).toHaveProperty("correlationId");
    });

    it("team_send_and_wait re-wait reuses correlationId", async () => {
      responseWaiter.waitForResponse = vi.fn().mockResolvedValue({
        status: "response",
        from: "worker",
        content: "Reply on re-wait",
      });

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-3", {
        to: "worker",
        correlationId: "existing-corr-id",
      });

      expect(result.content[0].text).toContain("Reply on re-wait");
    });

    it("team_send_and_wait returns all_idle when all members become idle", async () => {
      memberOpsStates.set("analyzer", "idle");
      memberOpsStates.set("worker", "idle");

      const mockResponseWaiter = createMockResponseWaiter();
      mockResponseWaiter.waitForResponse = vi.fn().mockResolvedValue({
        status: "timeout",
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

      const result = await executeFn("call-4", { to: "worker", content: "Hello" });

      expect(result.details).toHaveProperty("correlationId");
    });
  });

  describe("get_member_status", () => {
    it("get_member_status returns empty message when no members", async () => {
      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-1");
      expect(result.content[0].text).toContain("还没有启动任何团队成员");
    });

    it("get_member_status returns member states", async () => {
      memberOpsStates.set("analyzer", "idle");
      memberOpsStates.set("worker", "working");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const result = await executeFn("call-2");
      expect(result.content[0].text).toContain("analyzer");
      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("idle");
      expect(result.content[0].text).toContain("working");
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

  it("returns error when createMember throws", async () => {
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


