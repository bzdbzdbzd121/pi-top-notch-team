import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemberProcessHandle } from "../process/member-process";
import type { MemberOperationalState } from "../session/context";

// ── Mock the channel modules that message-channel imports ──

const mockCreateRouter = vi.fn();
const mockCreateMessageQueue = vi.fn();
const mockCreateResponseWaiter = vi.fn();

vi.mock("../channel/router", () => ({
  createRouter: (...args: any[]) => mockCreateRouter(...args),
}));
vi.mock("../channel/message-queue", () => ({
  createMessageQueue: (...args: any[]) => mockCreateMessageQueue(...args),
}));
vi.mock("../channel/response-waiter", () => ({
  createResponseWaiter: (...args: any[]) => mockCreateResponseWaiter(...args),
  extractCorrelationId: vi.fn((content: string) => {
    const m = content.match(/<corr:([a-zA-Z0-9_-]+)>/);
    return m ? m[1] : null;
  }),
}));

// ── Test helpers ────────────────────────────────────────────

function createMockMemberHandles(): Map<string, MemberProcessHandle> {
  const map = new Map<string, MemberProcessHandle>();
  map.set("analyzer", {
    name: "analyzer",
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn(),
  });
  map.set("worker", {
    name: "worker",
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn(),
  });
  return map;
}

describe("createMessageChannel", () => {
  let memberOpsStates: Map<string, MemberOperationalState>;
  let lastPendingCorrId: Map<string, string>;
  let memberHandles: Map<string, MemberProcessHandle>;
  let pi: { sendMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    memberOpsStates = new Map();
    lastPendingCorrId = new Map();
    memberHandles = createMockMemberHandles();
    pi = { sendMessage: vi.fn() };

    // Mock createResponseWaiter to return a simple object
    mockCreateResponseWaiter.mockReturnValue({
      waitForResponse: vi.fn(),
      resolveIfWaiting: vi.fn().mockReturnValue(false),
      cancelAll: vi.fn(),
    });

    // Mock createRouter to return a simple object
    mockCreateRouter.mockReturnValue({
      route: vi.fn(),
      updateMembers: vi.fn(),
    });

    // Mock createMessageQueue to return a simple object
    mockCreateMessageQueue.mockReturnValue({
      enqueue: vi.fn(),
      length: vi.fn().mockReturnValue(0),
      drain: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    });
  });

  async function loadModule() {
    return await import("./message-channel");
  }

  it("should return an object with router, messageQueue, responseWaiter", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    const result = createMessageChannel(deps as any);

    expect(result).toHaveProperty("router");
    expect(result).toHaveProperty("messageQueue");
    expect(result).toHaveProperty("responseWaiter");
  });

  it("should create responseWaiter first, then router, then messageQueue", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);

    // All three factory functions should have been called
    expect(mockCreateResponseWaiter).toHaveBeenCalledTimes(1);
    expect(mockCreateResponseWaiter).toHaveBeenCalledWith();
    expect(mockCreateRouter).toHaveBeenCalledTimes(1);
    expect(mockCreateMessageQueue).toHaveBeenCalledTimes(1);
  });

  it("should configure router with sendToMember, sendToTl, onUnknownTarget", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);

    // Check the router config
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    expect(routerConfig).toHaveProperty("sendToMember");
    expect(routerConfig).toHaveProperty("sendToTl");
    expect(routerConfig).toHaveProperty("onUnknownTarget");
    expect(routerConfig.memberNames).toEqual([]);
  });

  it("sendToMember should look up handle and send command", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    const handle = memberHandles.get("worker")!;

    routerConfig.sendToMember("worker", {
      id: "msg-1",
      from: "tl",
      to: "worker",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(memberOpsStates.get("worker")).toBe("working");
    expect(handle.sendCommand).toHaveBeenCalledWith({
      type: "prompt",
      message: expect.stringContaining("Hello"),
    });
  });

  it("sendToMember should warn when member handle not found", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];

    routerConfig.sendToMember("nonexistent", {
      id: "msg-1",
      from: "tl",
      to: "nonexistent",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        display: true,
      })
    );
  });

  it("sendToTl should delegate to responseWaiter when correlationId present", async () => {
    const mockResponseWaiter = {
      waitForResponse: vi.fn(),
      resolveIfWaiting: vi.fn().mockReturnValue(true),
      cancelAll: vi.fn(),
    };
    mockCreateResponseWaiter.mockReturnValue(mockResponseWaiter);

    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];

    lastPendingCorrId.set("worker", "corr-123");
    routerConfig.sendToTl({
      id: "msg-2",
      from: "worker",
      to: "tl",
      content: "Done\n\n<corr:corr-123>",
      timestamp: Date.now(),
    });

    expect(mockResponseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
      "corr-123",
      "worker",
      expect.stringContaining("Done"),
      undefined
    );
    // When resolved, should NOT send pi.sendMessage
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("sendToTl should send pi.sendMessage when no correlationId matches", async () => {
    const mockResponseWaiter = {
      waitForResponse: vi.fn(),
      resolveIfWaiting: vi.fn().mockReturnValue(false),
      cancelAll: vi.fn(),
    };
    mockCreateResponseWaiter.mockReturnValue(mockResponseWaiter);

    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];

    routerConfig.sendToTl({
      id: "msg-3",
      from: "worker",
      to: "tl",
      content: "普通消息，无 corr ID",
      timestamp: Date.now(),
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-message",
        display: true,
      })
    );
  });

  it("onUnknownTarget should send warning message", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];

    routerConfig.onUnknownTarget("worker", "ghost");

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        display: true,
      })
    );
    const messageArg = pi.sendMessage.mock.calls[0][0];
    expect(messageArg.content).toContain("ghost");
    expect(messageArg.content).toContain("worker");
  });

  it("messageQueue handler should call onRouteNotification for TL-sent messages", async () => {
    const mockRouter = { route: vi.fn(), updateMembers: vi.fn() };
    mockCreateRouter.mockReturnValue(mockRouter);
    const onRouteNotification = vi.fn();

    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      onRouteNotification,
    };

    createMessageChannel(deps as any);
    // Get the handler function passed to createMessageQueue
    const handler = mockCreateMessageQueue.mock.calls[0][0];

    await handler({
      id: "msg-4",
      from: "tl",
      to: "worker",
      content: "Task",
      timestamp: Date.now(),
    });

    // Should notify via UI-only callback, not pi.sendMessage
    expect(onRouteNotification).toHaveBeenCalledWith("worker");
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // Should route the message
    expect(mockRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-4" })
    );
  });

  it("messageQueue handler should route message without notification for non-TL messages", async () => {
    const mockRouter = { route: vi.fn(), updateMembers: vi.fn() };
    mockCreateRouter.mockReturnValue(mockRouter);
    const onRouteNotification = vi.fn();

    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      onRouteNotification,
    };

    createMessageChannel(deps as any);
    const handler = mockCreateMessageQueue.mock.calls[0][0];

    await handler({
      id: "msg-5",
      from: "analyzer",
      to: "worker",
      content: "Hey",
      timestamp: Date.now(),
    });

    // Should NOT notify for non-TL messages
    expect(onRouteNotification).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("messageQueue should have onHandlerError option", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const options = mockCreateMessageQueue.mock.calls[0][1];

    expect(options).toHaveProperty("onHandlerError");

    // When handler errors, onHandlerError should send notification
    const err = new Error("test error");
    options.onHandlerError(
      { id: "msg-err", from: "tl", to: "all", content: "fail", timestamp: Date.now() },
      err
    );

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        display: true,
      })
    );
  });

  it("sendToMember should handle sendCommand exception gracefully", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    const handle = memberHandles.get("worker")!;
    (handle.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Connection lost");
    });

    routerConfig.sendToMember("worker", {
      id: "msg-6",
      from: "tl",
      to: "worker",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        display: true,
      })
    );
  });
});
