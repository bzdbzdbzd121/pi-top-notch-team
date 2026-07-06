import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORIGINAL_ENV = { ...process.env };

function createMockApi(): ExtensionAPI {
  const tools: Map<string, any> = new Map();
  const handlers: Map<string, (...args: any[]) => any> = new Map();

  return {
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((def: any) => {
      tools.set(def.name, def);
    }),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn().mockReturnValue(undefined),
    setLabel: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
    getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getThinkingLevel: vi.fn().mockReturnValue("off"),
    setThinkingLevel: vi.fn(),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
    events: { on: vi.fn().mockReturnValue(vi.fn()), emit: vi.fn() },
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
  } as unknown as ExtensionAPI;
}

describe("member.ts — team member extension", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    // Reset env to known state
    process.env = { ...ORIGINAL_ENV };
    delete process.env.TEAM_ROLE;
    delete process.env.TEAM_NAME;
    delete process.env.TEAM_MEMBERS;
    delete process.env.TEAM_MEMBER_DESCRIPTION;
    delete process.env.TEAM_ROLE_LABEL;
    delete process.env.TEAM_SHARED_CONTEXT_PATH;
  });

  it("should return early without registering tools when TEAM_ROLE is not set", async () => {
    const api = createMockApi();
    const mod = await import("./member");
    mod.default(api);
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
  });

  it("should return early without registering tools when TEAM_NAME is not set", async () => {
    process.env.TEAM_ROLE = "analyzer";
    // TEAM_NAME not set
    const api = createMockApi();
    const mod = await import("./member");
    mod.default(api);
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it("should register team_send_message tool with correct name and description", async () => {
    process.env.TEAM_ROLE = "analyzer";
    process.env.TEAM_NAME = "test-team";
    process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "worker"]);

    const api = createMockApi();
    const mod = await import("./member");
    mod.default(api);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(toolDef.name).toBe("team_send_message");
    expect(toolDef.description).toContain("Send a message");
    expect(toolDef.parameters.required).toEqual(["to", "content"]);
  });

  it("should register before_agent_start handler", async () => {
    process.env.TEAM_ROLE = "worker";
    process.env.TEAM_NAME = "test-team";
    process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "worker"]);

    const api = createMockApi();
    const mod = await import("./member");
    mod.default(api);

    expect(api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });

  it("should inject role info into system prompt via before_agent_start", async () => {
    process.env.TEAM_ROLE = "worker";
    process.env.TEAM_ROLE_LABEL = "编码员";
    process.env.TEAM_NAME = "test-team";
    process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "worker", "reviewer"]);

    const api = createMockApi();
    const mod = await import("./member");
    mod.default(api);

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === "before_agent_start"
    )?.[1];
    expect(handler).toBeDefined();

    const result = await handler(
      { systemPrompt: "原始提示词" },
      {}
    );
    expect(result.systemPrompt).toContain("原始提示词");
    expect(result.systemPrompt).toContain("test-team");
    expect(result.systemPrompt).toContain("编码员");
    expect(result.systemPrompt).toContain("worker");
    expect(result.systemPrompt).toContain("analyzer");
    expect(result.systemPrompt).toContain("reviewer");
    expect(result.systemPrompt).toContain("team_send_message");
  });

  it("should inject sharedContextPath when TEAM_SHARED_CONTEXT_PATH is set", async () => {
    process.env.TEAM_ROLE = "worker";
    process.env.TEAM_NAME = "test-team";
    process.env.TEAM_MEMBERS = JSON.stringify([]);
    process.env.TEAM_SHARED_CONTEXT_PATH = "/tmp/shared-context.md";

    const api = createMockApi();
    const mod = await import("./member");
    mod.default(api);

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === "before_agent_start"
    )?.[1];

    const result = await handler({ systemPrompt: "" }, {});
    expect(result.systemPrompt).toContain("/tmp/shared-context.md");
  });

  it("should use TEAM_ROLE as label when TEAM_ROLE_LABEL is not set", async () => {
    process.env.TEAM_ROLE = "worker";
    process.env.TEAM_NAME = "test-team";
    process.env.TEAM_MEMBERS = JSON.stringify([]);

    const api = createMockApi();
    const mod = await import("./member");
    mod.default(api);

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: any[]) => c[0] === "before_agent_start"
    )?.[1];

    const result = await handler({ systemPrompt: "" }, {});
    expect(result.systemPrompt).toContain("worker");
  });

  describe("team_send_message execute", () => {
    it("should return success with teamMessage details for valid target", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_ROLE_LABEL = "编码员";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "worker"]);

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const result = await toolDef.execute("call-1", {
        to: "analyzer",
        content: "请帮忙审查这段代码",
        subject: "审查请求",
      });

      expect(result.details.teamMessage).toBeDefined();
      expect(result.details.teamMessage.from).toBe("worker");
      expect(result.details.teamMessage.to).toBe("analyzer");
      expect(result.details.teamMessage.subject).toBe("审查请求");
      expect(result.details.teamMessage.content).toBe("请帮忙审查这段代码");
      expect(result.details.teamMessage.timestamp).toBeGreaterThan(0);
      expect(result.content[0].text).toContain("消息已发送");
    });

    it("should return error for invalid target", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer"]);

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const result = await toolDef.execute("call-2", {
        to: "nonexistent",
        content: "hello",
      });

      expect(result.content[0].text).toContain("Invalid target");
      expect(result.content[0].text).toContain("nonexistent");
      expect(result.details).toEqual({});
    });

    it("should accept 'tl' and 'all' as valid targets", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer"]);

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // 'tl' should be valid
      const resultTl = await toolDef.execute("call-3", {
        to: "tl",
        content: "report",
      });
      expect(resultTl.details.teamMessage.to).toBe("tl");

      // 'all' should be valid
      const resultAll = await toolDef.execute("call-4", {
        to: "all",
        content: "broadcast",
      });
      expect(resultAll.details.teamMessage.to).toBe("all");
    });

    it("should truncate long content in response text", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer"]);

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const longContent = "A".repeat(500);
      const result = await toolDef.execute("call-5", {
        to: "tl",
        content: longContent,
      });

      expect(result.content[0].text).toContain("...");
      expect(result.details.teamMessage.content).toBe(longContent); // full content preserved in details
    });

    it("should handle empty subject", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer"]);

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const result = await toolDef.execute("call-6", {
        to: "tl",
        content: "no subject",
      });

      expect(result.details.teamMessage.subject).toBe("");
    });
  });

  describe("TEAM_MEMBERS parsing", () => {
    it("should parse JSON-encoded TEAM_MEMBERS", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "mover", "reviewer"]);

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Verify by checking that "mover" is a valid target
      const result = await toolDef.execute("call-7", {
        to: "mover",
        content: "hello",
      });
      expect(result.details.teamMessage.to).toBe("mover");
    });

    it("should parse comma-separated TEAM_MEMBERS as fallback", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = "analyzer,mover,reviewer"; // comma-separated, not JSON

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const result = await toolDef.execute("call-8", {
        to: "mover",
        content: "hello",
      });
      expect(result.details.teamMessage.to).toBe("mover");
    });

    it("should handle empty TEAM_MEMBERS gracefully", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      // TEAM_MEMBERS not set

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // All individual member targets should fail (only "tl" and "all" are valid)
      const result = await toolDef.execute("call-9", {
        to: "anyone",
        content: "hello",
      });
      expect(result.content[0].text).toContain("Invalid target");
    });

    it("should handle non-array JSON gracefully", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify("not-an-array"); // JSON but not array

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);

      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // All individual targets should fail
      const result = await toolDef.execute("call-10", {
        to: "someone",
        content: "hello",
      });
      expect(result.content[0].text).toContain("Invalid target");
    });
  });
});
