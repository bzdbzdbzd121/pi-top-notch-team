import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemberOperationalState } from "../session/context";
import type { MemberProcessHandle } from "../process/member-process";

// ── Test helpers ────────────────────────────────────────────

function createMockDeps(overrides?: Record<string, any>) {
  return {
    pi: { sendMessage: vi.fn() },
    memberOpsStates: new Map<string, MemberOperationalState>(),
    messageQueue: { enqueue: vi.fn() },
    responseWaiter: { resolveIfWaiting: vi.fn().mockReturnValue(false), cancelAll: vi.fn() },
    lastPendingCorrId: new Map<string, string>(),
    recentlyProcessedMessages: new Map<string, number>(),
    memberHandles: new Map<string, MemberProcessHandle>(),
    processManager: { handleExit: vi.fn() },
    ...overrides,
  };
}

async function loadModule() {
  return await import("./event-handler");
}

describe("parseTeamMessageTag", () => {
  it("should parse a valid team-message tag with to, subject, content", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag(
      '<team-message to="worker" subject="Task">Do the work</team-message>'
    );
    expect(result).toEqual({
      to: "worker",
      subject: "Task",
      content: "Do the work",
    });
  });

  it("should parse a valid tag without subject", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag(
      '<team-message to="worker">Just do it</team-message>'
    );
    expect(result).toEqual({
      to: "worker",
      subject: undefined,
      content: "Just do it",
    });
  });

  it("should parse a valid tag with empty subject", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag(
      '<team-message to="worker" subject="">Just do it</team-message>'
    );
    expect(result).toEqual({
      to: "worker",
      subject: undefined,
      content: "Just do it",
    });
  });

  it("should trim content", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag(
      '<team-message to="worker">  Hello world  </team-message>'
    );
    expect(result!.content).toBe("Hello world");
  });

  it("should return null for malformed tag", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag("this is not a team-message");
    expect(result).toBeNull();
  });

  it("should return null for tag with missing to attribute", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag("<team-message>content</team-message>");
    expect(result).toBeNull();
  });

  it("should return null when text is extremely long (exceeds max length)", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const longText = "A".repeat(200_000) + "</team-message>";
    const result = parseTeamMessageTag(longText);
    expect(result).toBeNull();
  });

  it("should handle content with nested angle brackets", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag(
      '<team-message to="worker">Use <template> tag</team-message>'
    );
    expect(result).toEqual({
      to: "worker",
      subject: undefined,
      content: "Use <template> tag",
    });
  });

  it("should handle content with embedded corr tag", async () => {
    const { parseTeamMessageTag } = await loadModule();
    const result = parseTeamMessageTag(
      '<team-message to="tl" subject="Reply">Done\n\n<corr:abc123></team-message>'
    );
    expect(result).toEqual({
      to: "tl",
      subject: "Reply",
      content: "Done\n\n<corr:abc123>",
    });
  });
});

describe("createMemberEventHandler", () => {
  it("should return a function", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);
    expect(typeof handler).toBe("function");
  });

  it("should set state to working on agent_start", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);
    handler({ type: "agent_start" });
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("should set state to idle on agent_end", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);
    deps.memberOpsStates.set("worker", "working");
    handler({ type: "agent_end" });
    expect(deps.memberOpsStates.get("worker")).toBe("idle");
  });

  it("should enqueue message on tool_execution_end for team_send_message", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "tool_execution_end",
      toolName: "team_send_message",
      result: {
        details: {
          teamMessage: {
            from: "worker",
            to: "tl",
            content: "Task done",
            subject: "Report",
            timestamp: 1234567890,
          },
        },
      },
    });

    expect(deps.messageQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "worker",
        to: "tl",
        content: "Task done",
        subject: "Report",
        timestamp: 1234567890,
      })
    );
  });

  it("should auto-populate correlation ID for TL-directed messages", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-abc");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "tool_execution_end",
      toolName: "team_send_message",
      result: {
        details: {
          teamMessage: {
            from: "worker",
            to: "tl",
            content: "Done",
            timestamp: Date.now(),
          },
        },
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    expect(enqueued.content).toContain("<corr:corr-abc>");
  });

  it("should override wrong corr tag with stored corr for TL-directed messages", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    // Member writes a WRONG corr tag
    deps.lastPendingCorrId.set("worker", "corr-correct");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "tool_execution_end",
      toolName: "team_send_message",
      result: {
        details: {
          teamMessage: {
            from: "worker",
            to: "tl",
            content: "Done\n\n<corr:wrong123>",
            timestamp: Date.now(),
          },
        },
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    // The wrong corr should be stripped and replaced with the correct one
    expect(enqueued.content).toContain("<corr:corr-correct>");
    expect(enqueued.content).not.toContain("<corr:wrong123>");
  });

  it("should set correlationId field on TeamMessage for TL-directed messages", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-abc");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "tool_execution_end",
      toolName: "team_send_message",
      result: {
        details: {
          teamMessage: {
            from: "worker",
            to: "tl",
            content: "Done",
            timestamp: Date.now(),
          },
        },
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    expect(enqueued.correlationId).toBe("corr-abc");
  });

  it("should set correlationId even when member provides a wrong corr tag", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-correct");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "tool_execution_end",
      toolName: "team_send_message",
      result: {
        details: {
          teamMessage: {
            from: "worker",
            to: "tl",
            content: "Done\n\n<corr:wrong123>",
            timestamp: Date.now(),
          },
        },
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    // correlationId should reflect the stored (correct) ID, not the wrong one in content
    expect(enqueued.correlationId).toBe("corr-correct");
  });

  it("should NOT set correlationId for non-TL messages", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-abc");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "tool_execution_end",
      toolName: "team_send_message",
      result: {
        details: {
          teamMessage: {
            from: "worker",
            to: "analyzer",
            content: "Hey check this",
            timestamp: Date.now(),
          },
        },
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    expect(enqueued.correlationId).toBeUndefined();
  });

  it("should override wrong corr tag in backup message_end path", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-correct-backup");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "message_end",
      message: {
        role: "assistant",
        content: '<team-message to="tl" subject="Reply">Done\n\n<corr:wrong456></team-message>',
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    expect(enqueued.correlationId).toBe("corr-correct-backup");
    expect(enqueued.content).toContain("<corr:corr-correct-backup>");
    expect(enqueued.content).not.toContain("<corr:wrong456>");
  });

  it("should parse backup team-message tag in message_end assistant text", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "message_end",
      message: {
        role: "assistant",
        content: 'Some text <team-message to="analyzer">Please help</team-message> more text',
      },
    });

    expect(deps.messageQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "worker",
        to: "analyzer",
        content: "Please help",
      })
    );
  });

  it("should skip de-duplicated messages", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    // First call: add to recentlyProcessedMessages (as Map<string, number>)
    deps.recentlyProcessedMessages.set("worker:Please help", Date.now());

    // Second call: should be skipped due to dedup
    handler({
      type: "message_end",
      message: {
        role: "assistant",
        content: 'Some text <team-message to="analyzer">Please help</team-message> more text',
      },
    });

    expect(deps.messageQueue.enqueue).not.toHaveBeenCalled();
  });

  it("should set state to stopped on normal process_exit", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 0,
      wasRunning: false,
    });

    expect(deps.memberOpsStates.get("worker")).toBe("stopped");
  });

  it("should set state to crashed on abnormal process_exit", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 1,
      wasRunning: false,
    });

    expect(deps.memberOpsStates.get("worker")).toBe("crashed");
  });

  it("should notify TL on abnormal process_exit with wasRunning=true", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 1,
      wasRunning: true,
    });

    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-message",
        display: true,
      })
    );
  });

  it("should resolve pending wait on abnormal process_exit", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-123");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 1,
      wasRunning: true,
    });

    expect(deps.responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
      "corr-123",
      "worker",
      expect.stringContaining("崩溃")
    );
  });

  it("should set state to crashed on process_error", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ type: "process_error", memberName: "worker" });

    expect(deps.memberOpsStates.get("worker")).toBe("crashed");
  });

  it("should call processManager.handleExit on abnormal process_exit with wasRunning=true", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 1,
      wasRunning: true,
    });

    expect(deps.processManager.handleExit).toHaveBeenCalledWith("worker", 1);
  });

  it("should call processManager.handleExit on normal process_exit with wasRunning=true", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 0,
      wasRunning: true,
    });

    expect(deps.processManager.handleExit).toHaveBeenCalledWith("worker", 0);
  });

  it("should NOT call processManager.handleExit when wasRunning=false (intentional stop)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 1,
      wasRunning: false,
    });

    expect(deps.processManager.handleExit).not.toHaveBeenCalled();
  });

  it("should NOT call processManager.handleExit on process_error", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ type: "process_error", memberName: "worker" });

    expect(deps.processManager.handleExit).not.toHaveBeenCalled();
  });

  it("should not throw when processManager is not provided", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps({ processManager: undefined });
    const handler = createMemberEventHandler("worker", deps as any);

    expect(() => {
      handler({
        type: "process_exit",
        memberName: "worker",
        exitCode: 1,
        wasRunning: true,
      });
    }).not.toThrow();
  });

  it("should still notify TL on abnormal process_exit when processManager is present", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "process_exit",
      memberName: "worker",
      exitCode: 1,
      wasRunning: true,
    });

    // TL should still receive the crash notification
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-message",
        display: true,
      })
    );
  });

  it("should ignore unhandled event types", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ type: "unknown_event", data: "whatever" });

    expect(deps.messageQueue.enqueue).not.toHaveBeenCalled();
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("createMemberEventHandler prompt rejection surfacing", () => {
  // Channel prompts are sent fire-and-forget via sendCommand (no id attached,
  // no response consumer). If the member's pi RPC layer rejects the prompt
  // (e.g. agent busy in its post-agent_end settlement window), the error
  // response arrives as a plain event. Without explicit handling it would be
  // silently swallowed and the TL's team_send_and_wait would hang.
  const rejection = (error: string) => ({
    type: "response",
    command: "prompt",
    success: false,
    error,
  });

  it("should resolve the pending wait and notify TL when a channel prompt is rejected", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-rej-1");
    deps.responseWaiter.resolveIfWaiting.mockReturnValue(true);
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."));

    expect(deps.responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
      "corr-rej-1",
      "worker",
      expect.stringContaining("already processing")
    );
    expect(deps.lastPendingCorrId.has("worker")).toBe(false);
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        display: true,
        content: expect.stringContaining("worker"),
      })
    );
  });

  it("should notify TL even when no pending wait exists for the member", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("boom"));

    expect(deps.responseWaiter.resolveIfWaiting).not.toHaveBeenCalled();
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        content: expect.stringContaining("boom"),
      })
    );
  });

  it("should ignore rejections that carry an id (sendCommandAndWait callers handle their own errors)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.lastPendingCorrId.set("worker", "corr-rej-2");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ ...rejection("boom"), id: "req-123" });

    expect(deps.responseWaiter.resolveIfWaiting).not.toHaveBeenCalled();
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
    expect(deps.lastPendingCorrId.get("worker")).toBe("corr-rej-2");
  });

  it("should ignore successful prompt responses", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ type: "response", command: "prompt", success: true });

    expect(deps.responseWaiter.resolveIfWaiting).not.toHaveBeenCalled();
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("should ignore error responses for non-prompt commands", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ type: "response", command: "get_session_stats", success: false, error: "boom" });

    expect(deps.responseWaiter.resolveIfWaiting).not.toHaveBeenCalled();
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("createSendToMember", () => {
  it("should return a function", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps() as any;
    const fn = createSendToMember(deps);
    expect(typeof fn).toBe("function");
  });

  it("should send command to a known member handle", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps() as any;
    const mockHandle = {
      sendCommand: vi.fn(),
    };
    deps.memberHandles.set("worker", mockHandle);

    const fn = createSendToMember(deps);
    fn("worker", {
      id: "msg-1",
      from: "tl",
      to: "worker",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(mockHandle.sendCommand).toHaveBeenCalledWith({
      type: "prompt",
      message: expect.stringContaining("Hello"),
      streamingBehavior: "followUp",
    });
  });

  it("should include streamingBehavior followUp so a busy member queues instead of rejecting", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps() as any;
    const mockHandle = {
      sendCommand: vi.fn(),
    };
    deps.memberHandles.set("worker", mockHandle);
    // Member is busy (or in its post-agent_end settlement window — TL cannot
    // distinguish). Without streamingBehavior, pi RPC rejects the prompt and
    // the message is lost.
    deps.memberOpsStates.set("worker", "working");

    const fn = createSendToMember(deps);
    fn("worker", {
      id: "msg-busy-1",
      from: "tl",
      to: "worker",
      content: "Follow-up task",
      timestamp: Date.now(),
    });

    expect(mockHandle.sendCommand).toHaveBeenCalledWith({
      type: "prompt",
      message: expect.stringContaining("Follow-up task"),
      streamingBehavior: "followUp",
    });
  });

  it("should warn when member handle not found", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps() as any;
    const fn = createSendToMember(deps);

    fn("nonexistent", {
      id: "msg-2",
      from: "tl",
      to: "nonexistent",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        display: true,
      })
    );
  });

  it("should handle sendCommand exception gracefully", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps() as any;
    const mockHandle = {
      sendCommand: vi.fn().mockImplementation(() => {
        throw new Error("Connection lost");
      }),
    };
    deps.memberHandles.set("worker", mockHandle);

    const fn = createSendToMember(deps);
    fn("worker", {
      id: "msg-3",
      from: "tl",
      to: "worker",
      content: "Hello",
      timestamp: Date.now(),
    });

    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-route",
        display: true,
      })
    );
  });
});

// ── Auto-Compaction on dispatch ────────────────────────────

describe("createSendToMember auto-compaction", () => {
  const enabledCfg = {
    enabled: true,
    thresholdPercent: 80,
    thresholdTokens: undefined,
    timeoutMinutes: 10,
    percentIsDefaultFallback: false,
  };

  function makeMsg(id = "msg-ac-1") {
    return { id, from: "tl", to: "worker", content: "Do work", timestamp: Date.now() };
  }

  function makeHandle(statsResponse?: any, compactResponse?: any) {
    return {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(statsResponse);
        if (cmd.type === "compact") return Promise.resolve(compactResponse);
        return Promise.reject(new Error("unexpected command"));
      }),
    };
  }

  function usageResponse(percent: number, tokens: number) {
    return { type: "response", command: "get_session_stats", success: true, data: { contextUsage: { percent, tokens, contextWindow: 200000 } } };
  }

  it("sends directly without stats query when getAutoCompact is not provided", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps() as any;
    const handle = makeHandle(usageResponse(95, 190000), { success: true });
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await new Promise((r) => setTimeout(r, 0));

    expect(handle.sendCommandAndWait).not.toHaveBeenCalled();
    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("sends directly when usage is below threshold", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(50, 100000), { success: true });
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    expect(handle.sendCommandAndWait).toHaveBeenCalledTimes(1); // stats only
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("compacts before dispatching when usage exceeds threshold (success is silent)", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(92, 184000), { type: "response", command: "compact", success: true, data: {} });
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());

    // Prompt must not be sent before compaction completes
    expect(handle.sendCommand).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    const commands = handle.sendCommandAndWait.mock.calls.map((c: any[]) => c[0].type);
    expect(commands).toEqual(["get_session_stats", "compact"]);
    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    // Success is silent — no TL notification
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("skips compaction entirely when member is not idle", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(95, 190000), { success: true });
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "working");

    createSendToMember(deps)("worker", makeMsg());
    await new Promise((r) => setTimeout(r, 0));

    expect(handle.sendCommandAndWait).not.toHaveBeenCalled();
    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
  });

  it("fails open and notifies TL when stats query fails", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "team-message", content: expect.stringContaining("无法查询") })
    );
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("fails open and notifies TL when compaction fails", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(92, 184000), { type: "response", command: "compact", success: false, error: "boom" });
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "team-message", content: expect.stringContaining("自动压缩") })
    );
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("fails open and notifies TL when compaction times out", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => ({ ...enabledCfg, timeoutMinutes: 1 }) }) as any;
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        return new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 10));
      }),
    };
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "team-message", content: expect.stringContaining("自动压缩") })
    );
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("queues messages arriving during compaction and flushes them after", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    let resolveCompact: (v: any) => void;
    const compactPromise = new Promise((r) => { resolveCompact = r; });
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        return compactPromise;
      }),
    };
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps);
    send("worker", { ...makeMsg("msg-1"), content: "First task" });
    // Wait until compaction has started (state visible synchronously after stats resolves)
    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("compacting"));

    // Second message arrives mid-compaction — must be queued, not sent
    send("worker", { ...makeMsg("msg-2"), content: "Second task" });
    expect(handle.sendCommand).not.toHaveBeenCalled();

    resolveCompact!({ type: "response", command: "compact", success: true, data: {} });
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalledTimes(2));

    const prompts = handle.sendCommand.mock.calls.map((c: any[]) => c[0].message as string);
    expect(prompts[0]).toContain("First task");
    expect(prompts[1]).toContain("Second task");
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("sets compacting state synchronously to close the dispatch race", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(92, 184000), { success: true });
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    // Synchronously after dispatch decision, the member must not appear idle
    expect(deps.memberOpsStates.get("worker")).toBe("compacting");
  });

  it("queues mid-compaction messages into the SHARED runtime when one is provided", async () => {
    // Phase 1 contract: the runtime passed in via deps is the single source
    // of truth for pending/flush — the inline path must never fall back to a
    // private closure queue once a shared runtime exists (that would orphan
    // messages when the pre-check barrier compacts in phase 3).
    const { createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;

    let resolveCompact: (v: any) => void;
    const compactPromise = new Promise((r) => { resolveCompact = r; });
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        return compactPromise;
      }),
    };
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps);
    send("worker", { ...makeMsg("msg-1"), content: "First task" });
    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("compacting"));

    // Mid-compaction arrival — must land in the shared runtime's queue.
    // Drain to inspect, then push back so the compaction finally flushes it.
    send("worker", { ...makeMsg("msg-2"), content: "Second task" });
    const drained = runtime.flushPending("worker");
    expect(drained.map((m: any) => m.content)).toEqual(["Second task"]);
    for (const m of drained) runtime.queueDuringCompaction("worker", m);

    resolveCompact!({ type: "response", command: "compact", success: true, data: {} });
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalledTimes(2));

    // Order locked by the existing contract: current message first, then
    // pending flushed from the runtime (FIFO) — and the runtime queue is now empty.
    const prompts = handle.sendCommand.mock.calls.map((c: any[]) => c[0].message as string);
    expect(prompts[0]).toContain("First task");
    expect(prompts[1]).toContain("Second task");
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(runtime.flushPending("worker")).toEqual([]);
  });

  it("flushes multiple mid-compaction messages in FIFO order via the shared runtime", async () => {
    const { createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;

    let resolveCompact: (v: any) => void;
    const compactPromise = new Promise((r) => { resolveCompact = r; });
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        return compactPromise;
      }),
    };
    deps.memberHandles.set("worker", handle);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps);
    send("worker", { ...makeMsg("msg-1"), content: "First task" });
    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("compacting"));

    send("worker", { ...makeMsg("msg-2"), content: "Second task" });
    send("worker", { ...makeMsg("msg-3"), content: "Third task" });

    resolveCompact!({ type: "response", command: "compact", success: true, data: {} });
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalledTimes(3));

    const prompts = handle.sendCommand.mock.calls.map((c: any[]) => c[0].message as string);
    expect(prompts[0]).toContain("First task");
    expect(prompts[1]).toContain("Second task");
    expect(prompts[2]).toContain("Third task");
  });
});
