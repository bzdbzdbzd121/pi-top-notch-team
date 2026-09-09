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
      streamingBehavior: "followUp",
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
      }),
      { deliverAs: "nextTurn" }
    );
  });

  it("sendToTl should deliver team-message as nextTurn (no steer, no turn trigger)", async () => {
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
      id: "msg-next-1",
      from: "worker",
      to: "tl",
      content: "成员汇报：任务完成",
      timestamp: Date.now(),
    });

    // Member→TL messages must NOT steer the streaming TL turn and must NOT
    // trigger a new turn: deliverAs:"nextTurn" queues them into pi's
    // _pendingNextTurnMessages, injected at the next arbitrary turn start.
    // (Version check: peerDep 0.83.0 dist/core/agent-session.js
    // sendCustomMessage options.deliverAs === "nextTurn" → push; prompt()
    // injects _pendingNextTurnMessages and clears them.)
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-message",
        content: expect.stringContaining("任务完成"),
      }),
      { deliverAs: "nextTurn" }
    );
    // No triggerTurn — idle TL must NOT get a new turn spawned by member messages.
    expect(pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "nextTurn" });
  });

  it("sendToTl with unmatched correlationId still delivers as nextTurn", async () => {
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

    // CorrId present but no waiter is listening (late reply): the message must
    // still reach the TL context on the next turn — never a steer.
    routerConfig.sendToTl({
      id: "msg-late",
      from: "worker",
      to: "tl",
      content: "迟到的回复\n\n<corr:corr-late>",
      timestamp: Date.now(),
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "team-message" }),
      { deliverAs: "nextTurn" }
    );
  });

  // ── S3（阶段 3）：等待期缓冲 —— gate 活跃时非回复消息入缓冲而非 nextTurn ──

  it("S3: sendToTl buffers the message while a wait gate is active (no sendMessage)", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    const result = createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];

    // team_send_and_wait 在飞（gate active）
    result.tlWaitGate.beginWait();
    routerConfig.sendToTl({
      id: "msg-s3-1",
      from: "worker",
      to: "tl",
      content: "等待期间的补充汇报",
      timestamp: Date.now(),
    });

    // 不进 pi 的 nextTurn 队列（否则要等 TL 回合结束才可见）——入扩展侧缓冲
    expect(pi.sendMessage).not.toHaveBeenCalled();
    const buffered = result.tlWaitGate.drain();
    expect(buffered).toHaveLength(1);
    expect(buffered[0].content).toBe("等待期间的补充汇报");
    expect(result.tlWaitGate.drain()).toEqual([]); // drain 原子清空
  });

  it("S3: gate inactive → nextTurn 语义不变（等待结束后到达的消息）", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    const result = createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];

    // 等待已结束（endWait 后）：消息走 S2 nextTurn
    result.tlWaitGate.beginWait();
    result.tlWaitGate.endWait();
    routerConfig.sendToTl({
      id: "msg-s3-2",
      from: "worker",
      to: "tl",
      content: "等待结束后的消息",
      timestamp: Date.now(),
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "team-message", display: true }),
      { deliverAs: "nextTurn" }
    );
  });

  it("S3: corrId 回复仍由 waiter 消费（优先于缓冲，不重复投递）", async () => {
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

    const result = createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];

    result.tlWaitGate.beginWait();
    routerConfig.sendToTl({
      id: "msg-s3-3",
      from: "worker",
      to: "tl",
      content: "正式回复\n\n<corr:corr-1>",
      timestamp: Date.now(),
    });

    // 回复进工具结果（waiter 消费），既不缓冲也不 sendMessage
    expect(mockResponseWaiter.resolveIfWaiting).toHaveBeenCalled();
    expect(result.tlWaitGate.drain()).toEqual([]);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("onUnknownTarget should send team-route immediately (no nextTurn)", async () => {
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
    // Routing errors are operational notices: stay immediate, no nextTurn.
    expect(pi.sendMessage.mock.calls[0][1]).toBeUndefined();
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

  // ── P2：peer-messaging 强制层接线（方案 L2）──────────────

  it("P2 接线：deps.getPeerMessagingAllowed 原样传递为 router config.isPeerMessagingAllowed（per-route 实时查询）", async () => {
    const { createMessageChannel } = await loadModule();
    const getPeerMessagingAllowed = vi.fn(() => true);
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      getPeerMessagingAllowed,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    expect(routerConfig.isPeerMessagingAllowed).toBe(getPeerMessagingAllowed);
    expect(routerConfig.isPeerMessagingAllowed!()).toBe(true);
  });

  it("P2 接线 fail-open：getPeerMessagingAllowed 缺省 → isPeerMessagingAllowed 为 undefined（router 恒允许）", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    expect(routerConfig.isPeerMessagingAllowed).toBeUndefined();
  });

  it("P2 onPeerBlocked：TL 收 team-route 拦截通知（即时，含发送方/目标/指引；与 onUnknownTarget 同构）", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      getPeerMessagingAllowed: vi.fn(() => false),
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    routerConfig.onPeerBlocked!("analyzer", "mover");

    const call = pi.sendMessage.mock.calls[0];
    expect(call[0]).toEqual(
      expect.objectContaining({ customType: "team-route", display: true })
    );
    expect(call[0].content).toContain("analyzer");
    expect(call[0].content).toContain("mover");
    expect(call[0].content).toContain("成员互发");
    // 即时通知（操作性，不走 nextTurn/steer）
    expect(call[1]).toBeUndefined();
  });

  it("P2 onPeerBlocked：sender 回执直接派发（followUp 保序，不进 messageQueue；复用 dispatch 语义标 working）", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      getPeerMessagingAllowed: vi.fn(() => false),
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    routerConfig.onPeerBlocked!("analyzer", "mover");

    // 红线 3（结构上）：拦截发生在路由层，回执不经 messageQueue/coalescer——
    // 直接向发送方 handle 派发。mock 队列的 enqueue从未被调用。
    expect(mockCreateMessageQueue.mock.results[0].value.enqueue).not.toHaveBeenCalled();
    expect(memberHandles.get("analyzer")!.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "prompt",
        streamingBehavior: "followUp",
        message: expect.stringContaining("[系统通知（消息通道）]"),
      })
    );
    const ackText = (
      (memberHandles.get("analyzer")! as any).sendCommand as ReturnType<typeof vi.fn>
    ).mock.calls[0][0].message as string;
    expect(ackText).toContain("你发送给 mover 的消息未送达");
    expect(ackText).toContain("该团队已禁用成员互发");
    expect(ackText).toContain("直接回复 TL");
    // 回执按 TL→member 派发语义标 working（成员处理完通知后自然回 idle）
    expect(memberOpsStates.get("analyzer")).toBe("working");
  });

  it("P2 红线 10：per-from 回执上限 3 次——第 4 次起回执停发，TL 通知恒发", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      getPeerMessagingAllowed: vi.fn(() => false),
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    for (let i = 0; i < 4; i++) {
      routerConfig.onPeerBlocked!("analyzer", "mover");
    }
    expect(memberHandles.get("analyzer")!.sendCommand).toHaveBeenCalledTimes(3);
    expect(pi.sendMessage).toHaveBeenCalledTimes(4);
    expect(pi.sendMessage.mock.calls.every((c) => c[0].customType === "team-route")).toBe(true);
  });

  it("P2 红线 10 变体：上限内不同成员独立计数（mover 仍有完整额度）", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      getPeerMessagingAllowed: vi.fn(() => false),
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    for (let i = 0; i < 3; i++) {
      routerConfig.onPeerBlocked!("analyzer", "mover");
    }
    routerConfig.onPeerBlocked!("worker", "analyzer");
    // analyzer 已达上限（3/3），worker 是另一个发送方 → 回照常回执
    expect(memberHandles.get("worker")!.sendCommand).toHaveBeenCalledTimes(1);
    expect(memberHandles.get("analyzer")!.sendCommand).toHaveBeenCalledTimes(3);
  });

  it("P2 onPeerBlocked：成员 crashed/stopped → 回执静默放弃（TL 通知照发）", async () => {
    const { createMessageChannel } = await loadModule();
    memberOpsStates.set("analyzer", "crashed");
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      getPeerMessagingAllowed: vi.fn(() => false),
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    routerConfig.onPeerBlocked!("analyzer", "mover");

    expect(memberHandles.get("analyzer")!.sendCommand).not.toHaveBeenCalled();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    // ops 状态不被回执覆写（crashed 保持，绝不被标 working）
    expect(memberOpsStates.get("analyzer")).toBe("crashed");
  });

  it("P2 onPeerBlocked：未知发送方（无 handle）→ 仅 TL 通知（dispatch 静默 no-op）", async () => {
    const { createMessageChannel } = await loadModule();
    const deps = {
      pi: pi as any,
      memberOpsStates,
      lastPendingCorrId,
      memberHandles,
      getPeerMessagingAllowed: vi.fn(() => false),
    };

    createMessageChannel(deps as any);
    const routerConfig = mockCreateRouter.mock.calls[0][0];
    routerConfig.onPeerBlocked!("ghost", "mover");
    // TL 通知恒发（故障可观测性）；无 handle → 回执 no-op，零异常
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
