import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import type { MemberOperationalState } from "../session/context";
import type { TeamSessionState } from "../session/state";
import type { TeamDefinition } from "../team/definition";

// ── Mock the modules that member-lifecycle imports ──────────

const mockCreateMemberProcess = vi.fn();
vi.mock("../process/member-process", () => ({
  createMemberProcess: (...args: any[]) => mockCreateMemberProcess(...args),
}));

// ── Test helpers ────────────────────────────────────────────

function createMockHandle(
  overrides?: Partial<MemberProcessHandle>
): MemberProcessHandle {
  return {
    name: "test-member",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue({
      name: "test-member",
      pid: 12345,
      status: "running",
    }),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn().mockResolvedValue({
      type: "response",
      command: "get_messages",
      data: { messages: [] },
    }),
    ...overrides,
  };
}

function createMockTeamDefinition(
  overrides?: Partial<TeamDefinition>
): TeamDefinition {
  return {
    name: "test-team",
    description: "A test team",
    members: [
      { name: "analyzer", label: "分析员", systemPrompt: "你是一个分析专家" },
      { name: "worker", label: "编码员", systemPrompt: "你是一个编码专家" },
      { name: "reviewer", label: "审查员", systemPrompt: "你是一个审查专家" },
    ],
    ...overrides,
  };
}

describe("buildMemberConfig", () => {
  let tmpDir: string;
  let session: TeamSessionState;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "member-lifecycle-test-"));
    mkdirSync(join(tmpDir, "sessions", "test-team"), { recursive: true });
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    session = {
      active: true,
      teamDefinition: createMockTeamDefinition(),
      startedAt: Date.now(),
      sessionId: "abc123",
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  });

  async function loadModule() {
    return await import("./member-lifecycle");
  }

  it("should return null when no active session (teamDefinition is null)", async () => {
    const { buildMemberConfig } = await loadModule();
    session.teamDefinition = null;
    const result = buildMemberConfig("analyzer", session);
    expect(result).toBeNull();
  });

  it("should return null when member not found in team definition", async () => {
    const { buildMemberConfig } = await loadModule();
    const result = buildMemberConfig("nonexistent", session);
    expect(result).toBeNull();
  });

  it("should return a valid MemberProcessConfig for a valid member", async () => {
    const { buildMemberConfig } = await loadModule();
    const result = buildMemberConfig("worker", session);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("worker");
    expect(result!.role).toBe("worker");
    expect(result!.roleLabel).toBe("编码员");
    expect(result!.teamName).toBe("test-team");
    expect(result!.teamMembers).toEqual(["analyzer", "worker", "reviewer"]);
    expect(result!.memberDescription).toBe("你是一个编码专家");
    expect(result!.memberExtensionPath).not.toContain("file://");
    expect(result!.memberExtensionPath).toContain("member.ts");
    // Verify session dir was created
    expect(existsSync(result!.sessionDir)).toBe(true);
  });

  it("should use default label (member name) when label is not set", async () => {
    const { buildMemberConfig } = await loadModule();
    session.teamDefinition!.members.push({
      name: "tester",
      systemPrompt: "你是一个测试专家",
    });
    const result = buildMemberConfig("tester", session);
    expect(result!.roleLabel).toBe("tester");
  });

  it("should construct correct session dir and shared context dir paths with sessionId", async () => {
    const { buildMemberConfig } = await loadModule();
    const result = buildMemberConfig("analyzer", session);
    expect(result!.sessionDir).toBe(join(tmpDir, "sessions", "test-team", "abc123", "analyzer"));
    expect(result!.sharedContextPath).toBe(
      join(tmpDir, "sessions", "test-team", "abc123", ".shared-context.md")
    );
  });

  it("should fall back to flat path when sessionId is null", async () => {
    const { buildMemberConfig } = await loadModule();
    const sessionNoId = { ...session, sessionId: null };
    const result = buildMemberConfig("analyzer", sessionNoId);
    expect(result!.sessionDir).toBe(join(tmpDir, "sessions", "test-team", "analyzer"));
    expect(result!.sharedContextPath).toBe(
      join(tmpDir, "sessions", "test-team", ".shared-context.md")
    );
  });

  it("should include cwd in the config", async () => {
    const { buildMemberConfig } = await loadModule();
    const result = buildMemberConfig("analyzer", session);
    expect(result!.cwd).toBe(process.cwd());
  });
});

describe("createAndRegisterMember", () => {
  let mockHandle: MemberProcessHandle;
  let eventHandler: ((event: any) => void) | null;
  let memberOpsStates: Map<string, MemberOperationalState>;
  let messageQueue: {
    enqueue: ReturnType<typeof vi.fn>;
  };
  let responseWaiter: {
    resolveIfWaiting: ReturnType<typeof vi.fn>;
  };
  let lastPendingCorrId: Map<string, string>;
  let recentlyProcessedMessages: Map<string, number>;
  let pi: { sendMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    eventHandler = null;
    mockHandle = createMockHandle({
      onEvent: vi.fn((handler) => {
        eventHandler = handler;
      }),
    });
    mockCreateMemberProcess.mockReturnValue(mockHandle);

    memberOpsStates = new Map();
    messageQueue = { enqueue: vi.fn() };
    responseWaiter = { resolveIfWaiting: vi.fn().mockReturnValue(false) };
    lastPendingCorrId = new Map();
    recentlyProcessedMessages = new Map();
    pi = { sendMessage: vi.fn() };
  });

  async function loadModule() {
    return await import("./member-lifecycle");
  }

  it("should create a member process and register it", async () => {
    const { createAndRegisterMember } = await loadModule();
    const config: MemberProcessConfig = {
      name: "worker",
      role: "worker",
      roleLabel: "编码员",
      teamName: "test-team",
      teamMembers: ["analyzer", "worker", "reviewer"],
      memberDescription: "你是一个编码专家",
      sessionDir: "/fake/sessions/test-team/worker",
      memberExtensionPath: "/path/to/member.ts",
      cwd: "/fake/project",
    };
    const deps = {
      pi: pi as any,
      memberOpsStates,
      messageQueue,
      responseWaiter,
      lastPendingCorrId,
      recentlyProcessedMessages,
    };

    const handle = createAndRegisterMember(pi as any, config, deps as any);

    expect(mockCreateMemberProcess).toHaveBeenCalledWith(
      config,
      expect.any(Function)
    );
    expect(handle).toBe(mockHandle);
    expect(memberOpsStates.get("worker")).toBe("idle");
  });

  it("should add handle to processManager when provided", async () => {
    const { createAndRegisterMember } = await loadModule();
    const manager = { addHandle: vi.fn() };
    const config: MemberProcessConfig = {
      name: "worker",
      role: "worker",
      roleLabel: "编码员",
      teamName: "test-team",
      teamMembers: [],
      memberDescription: "",
      sessionDir: "/fake/sessions/test-team/worker",
      memberExtensionPath: "/path/to/member.ts",
      cwd: "/fake/project",
    };
    const deps = {
      pi: pi as any,
      memberOpsStates,
      messageQueue,
      responseWaiter,
      lastPendingCorrId,
      recentlyProcessedMessages,
      processManager: manager as any,
    };

    createAndRegisterMember(pi as any, config, deps as any);
    expect(manager.addHandle).toHaveBeenCalledWith(mockHandle);
  });

  it("should register an event handler on the handle", async () => {
    const { createAndRegisterMember } = await loadModule();
    const config: MemberProcessConfig = {
      name: "worker",
      role: "worker",
      roleLabel: "编码员",
      teamName: "test-team",
      teamMembers: [],
      memberDescription: "",
      sessionDir: "/fake/sessions/test-team/worker",
      memberExtensionPath: "/path/to/member.ts",
      cwd: "/fake/project",
    };
    const deps = {
      pi: pi as any,
      memberOpsStates,
      messageQueue,
      responseWaiter,
      lastPendingCorrId,
      recentlyProcessedMessages,
    };

    createAndRegisterMember(pi as any, config, deps as any);
    expect(mockHandle.onEvent).toHaveBeenCalledWith(expect.any(Function));
  });

  describe("event handling", () => {
    let config: MemberProcessConfig;

    beforeEach(async () => {
      const { createAndRegisterMember } = await loadModule();
      config = {
        name: "worker",
        role: "worker",
        roleLabel: "编码员",
        teamName: "test-team",
        teamMembers: [],
        memberDescription: "",
        sessionDir: "/fake/sessions/test-team/worker",
        memberExtensionPath: "/path/to/member.ts",
        cwd: "/fake/project",
      };
      const deps = {
        pi: pi as any,
        memberOpsStates,
        messageQueue,
        responseWaiter,
        lastPendingCorrId,
        recentlyProcessedMessages,
      };
      createAndRegisterMember(pi as any, config, deps as any);
    });

    it("should transition to working on agent_start", () => {
      eventHandler!({ type: "agent_start" });
      expect(memberOpsStates.get("worker")).toBe("working");
    });

    it("should transition to idle on agent_end", () => {
      memberOpsStates.set("worker", "working");
      eventHandler!({ type: "agent_end" });
      expect(memberOpsStates.get("worker")).toBe("idle");
    });

    it("should transition to stopped on normal process_exit (code=0)", () => {
      eventHandler!({
        type: "process_exit",
        memberName: "worker",
        exitCode: 0,
        wasRunning: false,
      });
      expect(memberOpsStates.get("worker")).toBe("stopped");
    });

    it("should transition to stopped on process_exit code=143 (SIGTERM)", () => {
      eventHandler!({
        type: "process_exit",
        memberName: "worker",
        exitCode: 143,
        wasRunning: false,
      });
      expect(memberOpsStates.get("worker")).toBe("stopped");
    });

    it("should transition to crashed on abnormal process_exit (code=1)", () => {
      eventHandler!({
        type: "process_exit",
        memberName: "worker",
        exitCode: 1,
        wasRunning: false,
      });
      expect(memberOpsStates.get("worker")).toBe("crashed");
    });

    it("should transition to crashed on process_error", () => {
      eventHandler!({ type: "process_error", memberName: "worker" });
      expect(memberOpsStates.get("worker")).toBe("crashed");
    });

    it("should notify TL on abnormal process_exit with wasRunning=true", () => {
      eventHandler!({
        type: "process_exit",
        memberName: "worker",
        exitCode: 1,
        wasRunning: true,
      });
      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "team-message",
          display: true,
        })
      );
    });

    it("should notify TL on normal process_exit with wasRunning=true", () => {
      eventHandler!({
        type: "process_exit",
        memberName: "worker",
        exitCode: 0,
        wasRunning: true,
      });
      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "team-message",
          display: true,
        })
      );
    });

    it("should resolve pending wait on abnormal process_exit", () => {
      lastPendingCorrId.set("worker", "corr-123");
      eventHandler!({
        type: "process_exit",
        memberName: "worker",
        exitCode: 1,
        wasRunning: true,
      });
      expect(responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
        "corr-123",
        "worker",
        expect.stringContaining("崩溃")
      );
      expect(lastPendingCorrId.has("worker")).toBe(false);
    });

    it("should resolve pending wait on process_error", () => {
      lastPendingCorrId.set("worker", "corr-456");
      eventHandler!({ type: "process_error", memberName: "worker" });
      expect(responseWaiter.resolveIfWaiting).toHaveBeenCalledWith(
        "corr-456",
        "worker",
        expect.stringContaining("错误")
      );
      expect(lastPendingCorrId.has("worker")).toBe(false);
    });

    it("should enqueue team_send_message tool result", () => {
      const teamMsg = {
        from: "analyzer",
        to: "tl",
        content: "任务完成",
        subject: "报告",
        timestamp: 1234567890,
      };
      eventHandler!({
        type: "tool_execution_end",
        toolName: "team_send_message",
        result: { details: { teamMessage: teamMsg } },
      });
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "analyzer",
          to: "tl",
          content: "任务完成",
          subject: "报告",
          timestamp: 1234567890,
        })
      );
    });

    it("should handle multiple events and track state correctly", () => {
      eventHandler!({ type: "agent_start" });
      expect(memberOpsStates.get("worker")).toBe("working");

      eventHandler!({ type: "agent_end" });
      expect(memberOpsStates.get("worker")).toBe("idle");

      eventHandler!({ type: "agent_start" });
      expect(memberOpsStates.get("worker")).toBe("working");

      eventHandler!({
        type: "process_exit",
        memberName: "worker",
        exitCode: 1,
        wasRunning: false,
      });
      expect(memberOpsStates.get("worker")).toBe("crashed");
    });
  });
});

describe("getMemberLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function loadModule() {
    return await import("./member-lifecycle");
  }

  it("should return empty string for empty messages", async () => {
    const { getMemberLog } = await loadModule();
    const handle = createMockHandle({
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: { messages: [] },
      }),
    });

    const result = await getMemberLog(handle, 10);
    expect(result).toBe("");
  });

  it("should format messages as [role] content", async () => {
    const { getMemberLog } = await loadModule();
    const handle = createMockHandle({
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: {
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there" },
          ],
        },
      }),
    });

    const result = await getMemberLog(handle, 10, 100);
    expect(result).toBe("[user] Hello\n[assistant] Hi there");
  });

  it("should truncate content to default 200 characters", async () => {
    const { getMemberLog } = await loadModule();
    const longContent = "A".repeat(300);
    const handle = createMockHandle({
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: { messages: [{ role: "user", content: longContent }] },
      }),
    });

    const result = await getMemberLog(handle, 10);
    expect(result).toBe("[user] " + "A".repeat(197) + "...");
  });

  it("should respect custom maxContentLength", async () => {
    const { getMemberLog } = await loadModule();
    const handle = createMockHandle({
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: { messages: [{ role: "user", content: "A".repeat(100) }] },
      }),
    });

    const result = await getMemberLog(handle, 10, 10);
    expect(result).toBe("[user] " + "A".repeat(7) + "...");
  });

  it("should not truncate content shorter than maxContentLength", async () => {
    const { getMemberLog } = await loadModule();
    const handle = createMockHandle({
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: { messages: [{ role: "assistant", content: "Short msg" }] },
      }),
    });

    const result = await getMemberLog(handle, 10, 50);
    expect(result).toBe("[assistant] Short msg");
    expect(result).not.toContain("...");
  });

  it("should respect maxLines parameter", async () => {
    const { getMemberLog } = await loadModule();
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ];
    const handle = createMockHandle({
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: { messages },
      }),
    });

    const result = await getMemberLog(handle, 2, 50);
    expect(result).not.toContain("first");
    expect(result).toContain("second");
    expect(result).toContain("third");
  });

  it("should reject when handle.sendCommandAndWait rejects", async () => {
    const { getMemberLog } = await loadModule();
    const handle = createMockHandle({
      sendCommandAndWait: vi
        .fn()
        .mockRejectedValue(new Error("Connection lost")),
    });

    await expect(getMemberLog(handle, 10)).rejects.toThrow("Connection lost");
  });

  it("should handle non-string content (object)", async () => {
    const { getMemberLog } = await loadModule();
    const handle = createMockHandle({
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: {
          messages: [{ role: "tool", content: { result: "ok" } }],
        },
      }),
    });

    const result = await getMemberLog(handle, 10, 100);
    expect(result).toContain("[tool]");
    expect(result).toContain("result");
    expect(result).toContain("ok");
  });
});
