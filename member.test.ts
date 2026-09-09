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

  // ── P3 成员体验层：peer messaging 两态（矩阵 + 红线 8 golden）─────────

  /**
   * member.ts 旧内联模板的逐字复制品（红线 8 golden 窗口）： qualsiasi 重构后
   * allowed 态（缺省，无 TEAM_PEER_MESSAGING env）的 extraPrompt 必须与此函数
   * 输出逐字节一致。复制品与 member.ts 重构前源码同步，一字符之差即红。
   */
  function legacyExtraPrompt(
    teamName: string,
    roleLabel: string,
    role: string,
    memberDescription: string,
    memberList: string
  ): string {
    return `
## 当前角色

你是团队 **${teamName}** 的 **${roleLabel}**（${role}）。

${memberDescription ? `职责：${memberDescription}\n` : ""}
${memberList ? `团队其他成员：${memberList}\n` : ""}

### 协作规则
- 使用 \`team_send_message\` 工具与其他成员或 Team Lead 交流
- Team Lead 会通过消息通道给你分配任务
- **‼️ 强制规则：每次任务完成后必须且只能使用 \`team_send_message(to="tl", content="...")\` 向 TL 报告处理结果。** 在最终回复之前，可以通过 \`team_send_message\` 发送中间进展、问题或请求帮助。但任务最终完成后，**必须发送一条最终回复给 TL**，包含任务结果、产出文件路径或遇到的问题。
- ⚠️ **不要忽略这条规则**——如果任务完成而不回复 TL，TL 将无法知晓你的工作进展，整个流程会阻塞。
- **输出报告、方案、设计文档时，写入文件**（放在项目目录下），然后在消息中告知其他成员文件路径。不要将大量内容直接嵌入消息通道。
- 如果收到的消息中包含 \`<corr:...>\` 标签，在回复 Team Lead 时请将完整的标签一并附上
- 如果 Team Lead 通知 Shared Context 已更新，请仔细阅读
- 发现问题可以先通过消息通道与相关成员讨论
- 重大变更需先向 Team Lead 汇报

### 沟通风格
- **简洁精炼**：剔除客套话、语气词、多余铺垫与模棱两可的表述
- **保持完整句式与语法**，专业术语、代码内容、报错信息原样不变
- **只输出核心内容**，全程保持精简风格，不添加冗余文字
`;
  }

  describe("peer messaging two-state (P3)", () => {
    it("红线 8 golden：allowed 缺省态系统提示词与旧内联模板逐字节一致（有职责+有名单）", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_ROLE_LABEL = "编码员";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "reviewer"]);
      process.env.TEAM_MEMBER_DESCRIPTION = "你负责写代码";

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);
      const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: any[]) => c[0] === "before_agent_start"
      )?.[1];

      const result = await handler({ systemPrompt: "原始提示词" }, {});
      expect(result.systemPrompt).toBe(
        "原始提示词" +
          legacyExtraPrompt("test-team", "编码员", "worker", "你负责写代码", "analyzer、reviewer")
      );
    });

    it("红线 8 golden 变体：无职责+空名单的 allowed 态拼接与旧模板逐字节一致", async () => {
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
      expect(result.systemPrompt).toBe(legacyExtraPrompt("test-team", "worker", "worker", "", ""));
    });

    it("allowed 显式 env（TEAM_PEER_MESSAGING=allowed）与缺省输出逐字节一致（两态矩阵）", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_ROLE_LABEL = "编码员";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "reviewer"]);
      process.env.TEAM_MEMBER_DESCRIPTION = "你负责写代码";
      process.env.TEAM_PEER_MESSAGING = "allowed";

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);
      const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: any[]) => c[0] === "before_agent_start"
      )?.[1];
      const result = await handler({ systemPrompt: "原始提示词" }, {});
      expect(result.systemPrompt).toBe(
        "原始提示词" +
          legacyExtraPrompt("test-team", "编码员", "worker", "你负责写代码", "analyzer、reviewer")
      );
    });

    it("非法 env 值 fail-open 视为 allowed（与缺省一致；仅 tl-only 收缩）", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer"]);
      process.env.TEAM_PEER_MESSAGING = "tlo"; // 非法值 → allowed

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);
      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // to=成员 照常合法（validTargets 未收缩）
      const result = await toolDef.execute("pm-1", { to: "analyzer", content: "hi" });
      expect(result.details.teamMessage.to).toBe("analyzer");
    });

    it("tl-only 工具面：description 两态 + to 参数 description 不列成员名与 all（schema 即提示词面）", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "reviewer"]);
      process.env.TEAM_PEER_MESSAGING = "tl-only";

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);
      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(toolDef.description).toBe(
        "Send a message to the Team Lead. Member-to-member messaging is disabled."
      );
      expect(toolDef.parameters.properties.to.description).toBe(
        `Target: "tl" for the Team Lead`
      );
      expect(toolDef.parameters.properties.to.description).not.toContain("analyzer");
      expect(toolDef.parameters.properties.to.description).not.toContain("all");
    });

    it("tl-only validTargets：to=成员 与 to=all 被拒（可行动指引，无 teamMessage）；to=tl 仍正常", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "reviewer"]);
      process.env.TEAM_PEER_MESSAGING = "tl-only";

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);
      const toolDef = (api.registerTool as ReturnType<typeof vi.fn>).mock.calls[0][0];

      const blockedMember = await toolDef.execute("pm-2", { to: "analyzer", content: "hi" });
      expect(blockedMember.content[0].text).toContain("成员互发已禁用，只能发送给");
      expect(blockedMember.content[0].text).toContain("回复 TL");
      expect(blockedMember.details).toEqual({});

      const blockedAll = await toolDef.execute("pm-3", { to: "all", content: "hi" });
      expect(blockedAll.content[0].text).toContain("成员互发已禁用");
      expect(blockedAll.details).toEqual({});

      const okTl = await toolDef.execute("pm-4", { to: "tl", content: "报告" });
      expect(okTl.details.teamMessage.to).toBe("tl");
    });

    it("tl-only 提示词：删名单行（防凭空构造成员名）、交流行换仅 TL 语义、删讨论行、强制规则不变", async () => {
      process.env.TEAM_ROLE = "worker";
      process.env.TEAM_ROLE_LABEL = "编码员";
      process.env.TEAM_NAME = "test-team";
      process.env.TEAM_MEMBERS = JSON.stringify(["analyzer", "reviewer"]);
      process.env.TEAM_MEMBER_DESCRIPTION = "你负责写代码";
      process.env.TEAM_PEER_MESSAGING = "tl-only";

      const api = createMockApi();
      const mod = await import("./member");
      mod.default(api);
      const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: any[]) => c[0] === "before_agent_start"
      )?.[1];

      const result = await handler({ systemPrompt: "原始提示词" }, {});
      const sp: string = result.systemPrompt;
      expect(sp).toContain("原始提示词");
      // D7：名单行删除（不展示名册 → 不引导成员构造成员名）；成员名不应出现在提示词
      expect(sp).not.toContain("团队其他成员：");
      expect(sp).not.toContain("analyzer");
      expect(sp).not.toContain("reviewer");
      // 交流行替换（唯一交流渠道语义）
      expect(sp).toContain("只能与 Team Lead 交流（成员间互发已禁用；与其他成员协作须经 TL 中转）");
      expect(sp).not.toContain("使用 `team_send_message` 工具与其他成员或 Team Lead 交流");
      // 讨论行删除
      expect(sp).not.toContain("发现问题可以先通过消息通道与相关成员讨论");
      // 强制规则（两态不变）与 corr/汇报/输出报告行保留
      expect(sp).toContain("**‼️ 强制规则：");
      expect(sp).toContain("`<corr:...>`");
      expect(sp).toContain("**输出报告、方案、设计文档时，写入文件**");
      expect(sp).toContain("重大变更需先向 Team Lead 汇报");
      // 允许态才有的沟通骨架与上下文路径行仍在
      expect(sp).toContain("### 沟通风格");
    });
  });
});
