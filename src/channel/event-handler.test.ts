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
    // Phase 1 deps: the shared auto-compaction runtime (compaction_end
    // branch + get_state correction). Absent = branches inert.
    autoCompact: undefined as any,
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

  it("N4: a throwing onMemberActivity must NOT break the state machine update that follows", async () => {
    // The activity observers (Member Inspector / activity tracker) sit at the
    // TOP of the handler, before the state machine if-chain — an observer bug
    // must be isolated so agent_start/agent_end transitions still happen.
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps({
      onMemberActivity: vi.fn().mockImplementation(() => {
        throw new Error("tracker boom");
      }),
    });
    const handler = createMemberEventHandler("worker", deps as any);
    // agent_start: state machine update must land despite the throw
    expect(() => handler({ type: "agent_start" })).not.toThrow();
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect((deps as any).onMemberActivity).toHaveBeenCalledTimes(1);
    // agent_end: the same isolation holds for the completing transition
    expect(() => handler({ type: "agent_end" })).not.toThrow();
    expect(deps.memberOpsStates.get("worker")).toBe("idle");
    expect((deps as any).onMemberActivity).toHaveBeenCalledTimes(2);
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

  it("member-to-member messages NEVER carry the skipAutoCompact marker", async () => {
    // Summarizer hard requirement: non-barrier paths (member inter-sends,
    // Inspector direct) must not produce marked messages — the marker is
    // exclusively set by the batch pre-check barrier in tl-tools.
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
            to: "analyzer",
            content: "Please check this",
            timestamp: Date.now(),
          },
        },
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    expect(enqueued.to).toBe("analyzer");
    expect(enqueued.skipAutoCompact).toBeUndefined();
  });

  it("backup <team-message> parse path NEVER carries the skipAutoCompact marker", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler({
      type: "message_end",
      message: {
        role: "assistant",
        content: '<team-message to="analyzer">Backup path message</team-message>',
      },
    });

    const enqueued = deps.messageQueue.enqueue.mock.calls[0][0];
    expect(enqueued.to).toBe("analyzer");
    expect(enqueued.skipAutoCompact).toBeUndefined();
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

// ── Prompt rejection state correction (Phase 1: get_state 判定) ──
// The most common rejection cause is a compaction still running on the
// member side (the TL-side timeout lease expired while the member-side
// compaction continued). The rejection branch must restore the operational
// state to what the member actually reports — never leave a fabricated
// `working` behind (that was the permanent-hang black hole).

describe("createMemberEventHandler prompt rejection state correction (Phase 1)", () => {
  const rejection = (error: string) => ({
    type: "response",
    command: "prompt",
    success: false,
    error,
  });

  function getStateResponse(isCompacting: boolean): any {
    return {
      type: "response",
      command: "get_state",
      success: true,
      data: { isCompacting },
    };
  }

  function makeHandle(getStateResult?: any) {
    return {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockResolvedValue(getStateResult),
    };
  }

  it("sets compacting when get_state reports isCompacting=true (exit = the compaction_end branch)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const handle = makeHandle(getStateResponse(true));
    deps.memberHandles.set("worker", handle as any);
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    deps.memberOpsStates.set("worker", "working"); // state left behind by the failed dispatch
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("Cannot submit a prompt while compaction is in progress"));

    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("compacting"));
    expect(handle.sendCommandAndWait).toHaveBeenCalledWith(
      { type: "get_state" },
      expect.any(Function),
      3000
    );
  });

  it("sets idle when get_state reports isCompacting=false (re-dispatch is safe — no double compaction)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const handle = makeHandle(getStateResponse(false));
    deps.memberHandles.set("worker", handle as any);
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    deps.memberOpsStates.set("worker", "working");
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("Agent is already processing"));

    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("idle"));
    // Successful query → only the rejection notice (no extra notification).
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sets idle + notifies when the get_state query fails (conservative fail-open)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    deps.memberOpsStates.set("worker", "working");
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("boom"));

    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("idle"));
    // Two notices: the rejection notice + the conservative-idle notice.
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(deps.pi.sendMessage.mock.calls[1][0].content).toContain("恢复为 idle");
  });

  it("leaves the state untouched when no handle/runtime is wired (legacy minimal setups)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps(); // no memberHandles / autoCompact
    deps.memberOpsStates.set("worker", "working");
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("boom"));
    await new Promise((r) => setTimeout(r, 0));

    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(1); // only the rejection notice
  });

  it("honest notification: the notice no longer claims the task was dispatched (it was LOST)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("boom"));

    const content = deps.pi.sendMessage.mock.calls[0][0].content as string;
    expect(content).toContain("消息未送达");
    expect(content).toContain("已丢失");
    expect(content).not.toContain("已直接派发");
  });

  // ── review fix（建议 2）：查询窗口内新状态不被陈旧答案覆盖 ──
  // The get_state query takes up to 3s. If a real turn starts (agent_start)
  // or the process dies during that window, the answer is STALE — applying
  // it would overwrite the newer state (e.g. a false idle over a running
  // turn, releasing the wait tools early). The correction applies only when
  // the state is unchanged since the rejection AND no state-affecting event
  // arrived.

  it("skips the correction when a real turn started during the get_state window (stale answer must not overwrite working)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    let resolveQuery!: (v: any) => void;
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockReturnValue(new Promise((r) => { resolveQuery = r; })),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    deps.memberOpsStates.set("worker", "working"); // rejection leftover
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("boom")); // get_state query in flight
    // A real turn starts while the query is pending.
    handler({ type: "agent_start" });
    resolveQuery!(getStateResponse(false)); // stale: isCompacting=false

    await new Promise((r) => setTimeout(r, 0)); // let the correction settle
    // The stale answer must NOT reset the running turn's working to idle.
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(1); // rejection notice only
  });

  it("skips the conservative-idle fallback when a turn started during the query window", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    deps.memberOpsStates.set("worker", "working");
    const handler = createMemberEventHandler("worker", deps as any);

    handler(rejection("boom"));
    handler({ type: "agent_start" });
    await vi.waitFor(() => expect(handle.sendCommandAndWait).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));

    // No conservative idle + no extra notice: the running turn owns the state.
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});

// ── compaction_end consumer branch (Phase 1: 事件驱动出口) ──
// compaction_end is the authoritative heartbeat: it fires on the member side
// whenever a compaction actually finishes (success or failure). The TL-side
// timeout lease says nothing about the member-side state — this branch is the
// event-driven counterpart of the lease: exit compacting + flush messages
// queued during the compaction.

describe("createMemberEventHandler compaction_end branch (Phase 1)", () => {
  function makeMsg(id = "p1") {
    return { id, from: "tl", to: "worker", content: `Queued task ${id}`, timestamp: Date.now() };
  }

  it("exits compacting and flushes queued messages on compaction_end — normal path stays silent", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handle = { sendCommand: vi.fn() };
    deps.memberHandles.set("worker", handle as any);
    const handler = createMemberEventHandler("worker", deps as any);

    deps.memberOpsStates.set("worker", "compacting");
    runtime.queueDuringCompaction("worker", makeMsg("p1"));
    runtime.queueDuringCompaction("worker", makeMsg("p2"));

    handler({ type: "compaction_end" });

    // Flushed messages were dispatched → the member is back to working
    // (task_started), full chain: compacting → idle → working.
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    const prompts = handle.sendCommand.mock.calls.map((c: any[]) => c[0].message as string);
    expect(prompts[0]).toContain("Queued task p1");
    expect(prompts[1]).toContain("Queued task p2");
    expect(prompts[0]).toContain("[消息通道 - 来自 tl]");
    // Normal path (no prior timeout) is silent — no notification.
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
    expect(runtime.flushPending("worker")).toEqual([]);
  });

  it("exits compacting to idle when nothing was queued", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    const handle = { sendCommand: vi.fn() };
    deps.memberHandles.set("worker", handle as any);
    const handler = createMemberEventHandler("worker", deps as any);

    deps.memberOpsStates.set("worker", "compacting");
    handler({ type: "compaction_end" });

    expect(deps.memberOpsStates.get("worker")).toBe("idle");
    expect(handle.sendCommand).not.toHaveBeenCalled();
  });

  it("notifies the TL when the compaction had previously timed out (lease expired → heartbeat arrived)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handle = { sendCommand: vi.fn() };
    deps.memberHandles.set("worker", handle as any);
    const handler = createMemberEventHandler("worker", deps as any);

    deps.memberOpsStates.set("worker", "compacting");
    runtime.queueDuringCompaction("worker", makeMsg("p1"));
    runtime.markCompactionTimeout("worker");

    handler({ type: "compaction_end" });

    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-message",
        display: true,
        content: expect.stringContaining("压缩已于"),
      })
    );
    const content = deps.pi.sendMessage.mock.calls[0][0].content as string;
    expect(content).toContain("结束");
    expect(content).toContain("积压消息已自动补发");
    // The mark is consumed exactly once.
    expect(runtime.takeCompactionTimeout("worker")).toBeUndefined();
    expect(deps.memberOpsStates.get("worker")).toBe("working"); // flushed → dispatched
  });

  it("is a no-op when no shared runtime is wired (legacy minimal setups)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const deps = createMockDeps();
    deps.memberOpsStates.set("worker", "compacting");
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ type: "compaction_end" });

    expect(deps.memberOpsStates.get("worker")).toBe("compacting"); // untouched
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("defers exit+flush while the compact lease is in flight — the owning flow keeps the locked order (review fix)", async () => {
    // Upstream ordering fact: the member emits compaction_end BEFORE the
    // compact response (agent-session.js emits, rpc-mode.js writes the
    // response afterwards). During a healthy in-lease compaction this branch
    // therefore runs while compactNow still awaits the response. It must NOT
    // reset/flush here — the inline finally owns the exit (endCompaction)
    // and the ORDERED flush (current message A first, then pending FIFO):
    //   (a) acting here would dispatch queued B before the triggering A
    //       (order inversion, violates the locked dispatch contract);
    //   (b) resetting compacting early opens a double-compaction window
    //       before the response settles (exactly what 1.2 eliminates).
    const enabledCfg = {
      enabled: true,
      thresholdPercent: 80,
      thresholdTokens: undefined,
      timeoutMinutes: 10,
      percentIsDefaultFallback: false,
    };
    const { createMemberEventHandler, createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg });
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    let resolveCompact!: (v: any) => void;
    const compactPromise = new Promise((r) => { resolveCompact = r; });
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") {
          return Promise.resolve({
            type: "response",
            command: "get_session_stats",
            success: true,
            data: { contextUsage: { percent: 92, tokens: 184000, contextWindow: 200000 } },
          });
        }
        return compactPromise;
      }),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps as any);
    const handler = createMemberEventHandler("worker", deps as any);

    // A triggers the inline compaction (stats + compact in flight).
    send("worker", { ...makeMsg("A"), content: "Current task A" });
    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("compacting"));
    // Wait until the compact lease is actually registered (in production the
    // command write precedes any member-side event, so the lease always
    // precedes compaction_end; the microtask resume needs an explicit wait in
    // the test).
    await vi.waitFor(() => expect(runtime.hasInFlightCompaction("worker")).toBe(true));
    // B arrives mid-compaction → queued, not sent.
    send("worker", { ...makeMsg("B"), content: "Queued task B" });
    expect(handle.sendCommand).not.toHaveBeenCalled();

    // The heartbeat arrives BEFORE the compact response (upstream order).
    handler({ type: "compaction_end" });

    // In-flight lease → defer: no early reset, no early flush.
    expect(deps.memberOpsStates.get("worker")).toBe("compacting");
    expect(handle.sendCommand).not.toHaveBeenCalled();
    // (b) a new dispatch during the window still queues — no second compact.
    send("worker", { ...makeMsg("C"), content: "Queued task C" });
    expect(handle.sendCommandAndWait).toHaveBeenCalledTimes(2); // stats + compact only
    expect(handle.sendCommand).not.toHaveBeenCalled();

    // The response settles → the inline finally owns the exit + ordered flush.
    resolveCompact!({ type: "response", command: "compact", success: true, data: {} });
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalledTimes(3));

    const prompts = handle.sendCommand.mock.calls.map((c: any[]) => c[0].message as string);
    expect(prompts[0]).toContain("Current task A");
    expect(prompts[1]).toContain("Queued task B");
    expect(prompts[2]).toContain("Queued task C");
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(runtime.flushPending("worker")).toEqual([]);
    // Normal path stays silent.
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves a working member untouched on compaction_end (inline path already exited; the prompt is being processed)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    const handle = { sendCommand: vi.fn() };
    deps.memberHandles.set("worker", handle as any);
    const handler = createMemberEventHandler("worker", deps as any);
    deps.memberOpsStates.set("worker", "working");

    handler({ type: "compaction_end" });

    expect(deps.memberOpsStates.get("worker")).toBe("working");
    expect(handle.sendCommand).not.toHaveBeenCalled();
    expect(deps.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("double-compaction protection: a compacting member's new message queues; compaction_end flushes it — NO second compact RPC", async () => {
    // Regression for the user scenario: compaction timeout → prompt rejected
    // → get_state corrected the state to compacting. A retry now must NOT
    // trigger a fresh stats/compact cycle (double compaction) — it queues and
    // is flushed by the compaction_end heartbeat.
    const enabledCfg = {
      enabled: true,
      thresholdPercent: 80,
      thresholdTokens: undefined,
      timeoutMinutes: 10,
      percentIsDefaultFallback: false,
    };
    const { createMemberEventHandler, createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg });
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handle = { sendCommand: vi.fn(), sendCommandAndWait: vi.fn() };
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "compacting"); // corrected after the rejection

    const send = createSendToMember(deps as any);
    send("worker", { ...makeMsg(), content: "Retry task" });
    // Queued — zero RPC, zero prompt.
    expect(handle.sendCommandAndWait).not.toHaveBeenCalled();
    expect(handle.sendCommand).not.toHaveBeenCalled();

    const handler = createMemberEventHandler("worker", deps as any);
    handler({ type: "compaction_end" });

    expect(handle.sendCommand).toHaveBeenCalledTimes(1);
    expect(handle.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Retry task") })
    );
    expect(handle.sendCommandAndWait).not.toHaveBeenCalled();
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });
});

// ── process_exit / process_error pending cleanup (Phase 2: 三出口之③) ──
// A member whose process dies while messages sit in its pending queue would
// orphan them forever (no compaction_end will ever flush). The exit branches
// drain the queue, resolve the pending corrIds, consume the timeout mark
// (no future heartbeat to notify) and notify the TL with a summary.

describe("createMemberEventHandler process-exit pending cleanup (Phase 2)", () => {
  function makePendingMsg(id: string, corrId?: string) {
    return { id, from: "tl", to: "worker", content: `Pending task ${id}`, correlationId: corrId, timestamp: Date.now() };
  }

  it("process_exit drains the pending queue, resolves corrIds and notifies with a summary (crash)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handler = createMemberEventHandler("worker", deps as any);

    deps.memberOpsStates.set("worker", "compacting");
    runtime.queueDuringCompaction("worker", makePendingMsg("p1", "corr-p1"));
    runtime.queueDuringCompaction("worker", makePendingMsg("p2")); // member inter-send, no corrId
    runtime.markCompactionTimeout("worker"); // mark must be consumed silently (no future heartbeat)
    deps.lastPendingCorrId.set("worker", "corr-p1");
    deps.responseWaiter.resolveIfWaiting.mockReturnValue(true);

    handler({ type: "process_exit", memberName: "worker", exitCode: 1, wasRunning: true });

    expect(runtime.flushPending("worker")).toEqual([]);
    expect(deps.responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
      "corr-p1", "worker", expect.stringContaining("消息未送达")
    );
    expect(deps.lastPendingCorrId.has("worker")).toBe(false);
    // Timeout mark consumed — a later compaction_end (from a NEW process) must not mis-fire.
    expect(runtime.takeCompactionTimeout("worker")).toBeUndefined();
    // Summary notice mentions the dropped content.
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Pending task p1") })
    );
  });

  it("process_exit drains pending even on an INTENTIONAL stop (wasRunning=false)", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handler = createMemberEventHandler("worker", deps as any);

    deps.memberOpsStates.set("worker", "compacting");
    runtime.queueDuringCompaction("worker", makePendingMsg("p1", "corr-p1"));

    handler({ type: "process_exit", memberName: "worker", exitCode: 0, wasRunning: false });

    expect(runtime.flushPending("worker")).toEqual([]);
    expect(deps.responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
      "corr-p1", "worker", expect.stringContaining("消息未送达")
    );
  });

  it("process_error drains the pending queue too", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handler = createMemberEventHandler("worker", deps as any);

    deps.memberOpsStates.set("worker", "compacting");
    runtime.queueDuringCompaction("worker", makePendingMsg("p1", "corr-p1"));

    handler({ type: "process_error", memberName: "worker" });

    expect(runtime.flushPending("worker")).toEqual([]);
    expect(deps.responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
      "corr-p1", "worker", expect.stringContaining("消息未送达")
    );
  });

  it("is a no-op when no pending messages exist", async () => {
    const { createMemberEventHandler } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps();
    deps.autoCompact = createAutoCompactRuntime(deps.memberOpsStates);
    const handler = createMemberEventHandler("worker", deps as any);

    handler({ type: "process_exit", memberName: "worker", exitCode: 1, wasRunning: true });

    expect(deps.pi.sendMessage).toHaveBeenCalledTimes(1); // crash notice only
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "team-message", content: expect.stringContaining("自动压缩") })
    );
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("Phase 2: on compact lease timeout the message is QUEUED (not dispatched), state stays compacting, honest notice", async () => {
    // Phase 1 dispatched anyway → the member-side compaction (still running)
    // rejected the prompt → message lost + working black hole. Phase 2: the
    // lease expiry says nothing about the member-side state — keep compacting,
    // queue the message, let the compaction_end heartbeat flush it.
    const { createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => ({ ...enabledCfg, timeoutMinutes: 1 }) }) as any;
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        return new Promise((_, reject) => setTimeout(() => reject(new Error("Command to \"worker\" timed out after 60000ms")), 10));
      }),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await vi.waitFor(() => expect(deps.pi.sendMessage).toHaveBeenCalled());

    // No prompt dispatched into the still-running compaction; state honest.
    expect(handle.sendCommand).not.toHaveBeenCalled();
    expect(deps.memberOpsStates.get("worker")).toBe("compacting");
    // The message is queued in the shared pending (compaction_end will flush).
    expect(runtime.flushPending("worker").map((m: any) => m.id)).toEqual(["msg-ac-1"]);
    expect(deps.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "team-message", content: expect.stringContaining("任务已排队") })
    );
  });

  it("Phase 2 F11: timeout → compaction_end → flush → dispatched, never rejected (full chain, one compact RPC)", async () => {
    const { createMemberEventHandler, createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => ({ ...enabledCfg, timeoutMinutes: 1 }) }) as any;
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    let rejectCompact!: (e: Error) => void;
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        return new Promise((_, rej) => { rejectCompact = rej; });
      }),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps);
    const handler = createMemberEventHandler("worker", deps as any);
    send("worker", { ...makeMsg(), content: "Timeout task" });
    await vi.waitFor(() => expect(runtime.hasInFlightCompaction("worker")).toBe(true));

    // Lease expires (member-side compaction may still run) → queued, not sent.
    rejectCompact!(new Error('Command to "worker" timed out after 60000ms'));
    await vi.waitFor(() => expect(deps.pi.sendMessage).toHaveBeenCalled());
    expect(handle.sendCommand).not.toHaveBeenCalled();
    expect(deps.memberOpsStates.get("worker")).toBe("compacting");

    // The member-side compaction finishes → compaction_end heartbeat flushes.
    handler({ type: "compaction_end" });
    expect(handle.sendCommand).toHaveBeenCalledTimes(1);
    expect(handle.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Timeout task") })
    );
    expect(deps.memberOpsStates.get("worker")).toBe("working");
    // E12: exactly one compact RPC for this dispatch — no re-compaction.
    const commands = handle.sendCommandAndWait.mock.calls.map((c: any[]) => c[0].type);
    expect(commands.filter((t: string) => t === "compact")).toHaveLength(1);
    expect(runtime.flushPending("worker")).toEqual([]);
  });

  it("Phase 2: event lost → the 30s poll fallback flushes the queued message (waitCompactionIdle)", async () => {
    const { createMemberEventHandler, createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => ({ ...enabledCfg, timeoutMinutes: 1 }) }) as any;
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    let rejectCompact!: (e: Error) => void;
    let getStateCalls = 0;
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        if (cmd.type === "get_state") {
          getStateCalls++;
          return Promise.resolve({ type: "response", command: "get_state", success: true, data: { isCompacting: false } });
        }
        return new Promise((_, rej) => { rejectCompact = rej; });
      }),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps);
    const handler = createMemberEventHandler("worker", deps as any);
    vi.useFakeTimers();
    try {
      send("worker", { ...makeMsg(), content: "Lost-event task" });
      await vi.advanceTimersByTimeAsync(0); // flush microtasks → stats + compact in flight
      expect(runtime.hasInFlightCompaction("worker")).toBe(true);
      rejectCompact!(new Error('Command to "worker" timed out after 60000ms'));
      await vi.advanceTimersByTimeAsync(0); // timeout branch: notify + queue + watcher
      expect(deps.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("任务已排队") })
      );
      expect(handle.sendCommand).not.toHaveBeenCalled();
      expect(deps.memberOpsStates.get("worker")).toBe("compacting");

      // NO compaction_end ever arrives (pipe loss) — the poll fallback
      // releases at the first 30s tick and flushes the queued message.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getStateCalls).toBeGreaterThanOrEqual(1);
      expect(handle.sendCommand).toHaveBeenCalledTimes(1);
      expect(handle.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Lost-event task") })
      );
      expect(deps.memberOpsStates.get("worker")).toBe("working");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Phase 2: secondary budget exhausted → message abandoned + corrId resolved + manual-intervention notice", async () => {
    const { createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => ({ ...enabledCfg, timeoutMinutes: 1 }) }) as any;
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    let rejectCompact!: (e: Error) => void;
    const handle = {
      sendCommand: vi.fn(),
      sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
        if (cmd.type === "get_session_stats") return Promise.resolve(usageResponse(92, 184000));
        if (cmd.type === "get_state") {
          return Promise.resolve({ type: "response", command: "get_state", success: true, data: { isCompacting: true } });
        }
        return new Promise((_, rej) => { rejectCompact = rej; });
      }),
    };
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");
    deps.lastPendingCorrId.set("worker", "corr-abandon-1");
    deps.responseWaiter.resolveIfWaiting.mockReturnValue(true);

    vi.useFakeTimers();
    try {
      createSendToMember(deps)("worker", { ...makeMsg(), content: "Doomed task", correlationId: "corr-abandon-1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.hasInFlightCompaction("worker")).toBe(true);
      rejectCompact!(new Error('Command to "worker" timed out after 60000ms'));
      await vi.advanceTimersByTimeAsync(0); // timeout branch: notify + queue + watcher
      expect(deps.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("任务已排队") })
      );

      // The compaction NEVER ends (isCompacting stays true) → budget (1 min)
      // exhausted → abandon: resolve the corrId, drop the message, notify.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(deps.responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
        "corr-abandon-1",
        "worker",
        expect.stringContaining("已放弃")
      );
      expect(deps.lastPendingCorrId.has("worker")).toBe(false);
      expect(handle.sendCommand).not.toHaveBeenCalled();
      expect(runtime.flushPending("worker")).toEqual([]);
      expect(deps.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("已放弃") })
      );
      expect(deps.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("stop_member") })
      );
    } finally {
      vi.useRealTimers();
    }
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
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
    deps.memberHandles.set("worker", handle as any);
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

  // ── skipAutoCompact marker (phase 2) ──────────────────────
  // The marker is the ONLY signal that the compaction decision was already
  // made by the batch pre-check barrier (phase 3). It is a correctness
  // mechanism, not an optimization: it prevents a second compaction when
  // usage is STILL over threshold after a compact (E12) and prevents a
  // re-compaction after a failed one (at most one per dispatch).

  it("dispatches directly without ANY stats query when msg.skipAutoCompact is true", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(95, 190000), { success: true });
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", { ...makeMsg(), skipAutoCompact: true });
    await new Promise((r) => setTimeout(r, 0));

    // No get_session_stats / compact RPC at all — the marker bypasses the
    // inline auto-compaction check entirely (E12 guard).
    expect(handle.sendCommandAndWait).not.toHaveBeenCalled();
    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
    expect(deps.memberOpsStates.get("worker")).toBe("working");
  });

  it("skipAutoCompact does NOT bypass the compacting queue (messages still queue mid-compaction)", async () => {
    // The marker only disables the *decision* to start a new compaction;
    // an in-flight compaction still owns the member, so marked messages
    // must queue like any other and be flushed in order.
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
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps);
    send("worker", { ...makeMsg("msg-1"), content: "Unmarked first task" }); // unmarked → starts compaction
    await vi.waitFor(() => expect(deps.memberOpsStates.get("worker")).toBe("compacting"));

    // Marked message arrives mid-compaction → must queue, not dispatch
    send("worker", { ...makeMsg("msg-2"), content: "Marked task", skipAutoCompact: true });
    expect(handle.sendCommand).not.toHaveBeenCalled();

    resolveCompact!({ type: "response", command: "compact", success: true, data: {} });
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalledTimes(2));

    const prompts = handle.sendCommand.mock.calls.map((c: any[]) => c[0].message as string);
    expect(prompts[0]).toContain("Unmarked first task");
    expect(prompts[1]).toContain("Marked task");
  });

  it("explicit skipAutoCompact: false behaves exactly like an unmarked message", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(50, 100000), { success: true });
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", { ...makeMsg(), skipAutoCompact: false });
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    // Below threshold → stats queried, no compact, prompt dispatched.
    expect(handle.sendCommandAndWait).toHaveBeenCalledTimes(1);
    expect(handle.sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
  });

  it("unmarked messages still trigger the auto-compact check (baseline comparison)", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(95, 190000), { success: true });
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", makeMsg());
    await vi.waitFor(() => expect(handle.sendCommand).toHaveBeenCalled());

    // Unmarked → full inline check: stats + compact + dispatch.
    const commands = handle.sendCommandAndWait.mock.calls.map((c: any[]) => c[0].type);
    expect(commands).toEqual(["get_session_stats", "compact"]);
  });

  it("direct dispatch drains pending messages FIRST when a compaction ended without flush (D2 orphan fix)", async () => {
    // Barrier-style compaction lifecycle: beginCompaction → compactNow →
    // endCompaction (state reset ONLY — the barrier never flushes). Messages
    // queued during that compaction sit in the shared pending. The next
    // dispatch to the member (e.g. the marked batch message) must flush them
    // FIFO before itself — otherwise they are stranded until the member's
    // next compaction cycle (possibly never).
    const { createSendToMember } = await loadModule();
    const { createAutoCompactRuntime } = await import("./auto-compact");
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const runtime = createAutoCompactRuntime(deps.memberOpsStates);
    deps.autoCompact = runtime;
    const handle = { sendCommand: vi.fn(), sendCommandAndWait: vi.fn() };
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    const send = createSendToMember(deps);

    // Simulate the barrier: compaction starts, a message arrives mid-flight,
    // compaction ends without flushing.
    runtime.beginCompaction("worker");
    send("worker", { ...makeMsg("m1"), content: "Queued during barrier compaction" });
    expect(handle.sendCommand).not.toHaveBeenCalled();
    runtime.endCompaction("worker");

    // Marked batch message arrives after the barrier → direct dispatch.
    send("worker", { ...makeMsg("m2"), content: "Marked batch task", skipAutoCompact: true });

    const prompts = (handle.sendCommand as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => c[0].message as string);
    expect(prompts[0]).toContain("Queued during barrier compaction");
    expect(prompts[1]).toContain("Marked batch task");
    expect(prompts).toHaveLength(2);
    expect(runtime.flushPending("worker")).toEqual([]);
  });

  it("direct dispatch with no pending is unaffected (empty flush is a no-op)", async () => {
    const { createSendToMember } = await loadModule();
    const deps = createMockDeps({ getAutoCompact: () => enabledCfg }) as any;
    const handle = makeHandle(usageResponse(50, 100000), { success: true });
    deps.memberHandles.set("worker", handle as any);
    deps.memberOpsStates.set("worker", "idle");

    createSendToMember(deps)("worker", { ...makeMsg(), skipAutoCompact: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(handle.sendCommand).toHaveBeenCalledTimes(1);
    expect(handle.sendCommandAndWait).not.toHaveBeenCalled();
  });
});
