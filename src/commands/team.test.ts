import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import { registerTeamCommand } from "./team";
import { endSession } from "../session/state";
import type { TeamContext } from "../session/context";
import type { TeamDefinition } from "../team/definition";

function createTeamContext(): TeamContext {
  return {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
    processManager: null,
    memberHandles: new Map(),
    router: { route: vi.fn(), updateMembers: vi.fn() } as any,
    messageQueue: { enqueue: vi.fn(), drain: vi.fn(), length: vi.fn(), stop: vi.fn() } as any,
    responseWaiter: { waitForResponse: vi.fn(), resolveIfWaiting: vi.fn(), cancelAll: vi.fn() } as any,
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait"],
    memberOperationalStates: null,
  };
}

describe("/team command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-command-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession();
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a command named 'team'", () => {
    const pi = createMockExtensionAPI();
    registerTeamCommand(pi, createTeamContext());
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "team",
      expect.objectContaining({ description: expect.any(String) })
    );
  });

  it("/team list shows no teams when none exist", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("list", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("还没有创建"),
      "info"
    );
  });

  it("/team list shows team names", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    // Create a team file
    mkdirSync(join(tmpDir, "teams"), { recursive: true });
    writeFileSync(join(tmpDir, "teams", "my-team.yaml"), "name: my-team\ndescription: test\nmembers:\n  - name: w\n    systemPrompt: work", "utf-8");

    await handler("list", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-team"),
      "info"
    );
  });

  it("/team show notifies when not found", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("show nonexistent", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("不存在"),
      "warning"
    );
  });

  it("/team show displays multi-line systemPrompt correctly", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    mkdirSync(join(tmpDir, "teams"), { recursive: true });
    writeFileSync(join(tmpDir, "teams", "multi-line.yaml"),
      `name: multi-line
description: test
members:
  - name: analyzer
    label: 分析员
    systemPrompt: |
      第一行提示词
      第二行提示词
      第三行提示词
`, "utf-8");

    await handler("show multi-line", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("第一行提示词"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("第二行提示词"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("第三行提示词"),
      "info"
    );
  });

  it("/team show displays workflow when present", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    mkdirSync(join(tmpDir, "teams"), { recursive: true });
    const yaml = [
      "name: wf-team",
      "description: Team with workflow",
      "members:",
      "  - name: architect",
      "    label: 分析员",
      "    systemPrompt: design",
      "  - name: coder",
      "    systemPrompt: code",
      "workflow:",
      "  strictness: reference",
      "  description: Dev workflow",
      "  stages:",
      "    - member: architect",
      "      name: analyze",
      "      description: Analyze requirements",
      "    - member: coder",
      "      name: implement",
      "      description: Write code",
    ].join("\n");
    writeFileSync(join(tmpDir, "teams", "wf-team.yaml"), yaml, "utf-8");

    await handler("show wf-team", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("分析员"),
      "info"
    );
  });

  it("/team delete deletes after confirmation", async () => {
    mkdirSync(join(tmpDir, "teams"), { recursive: true });
    writeFileSync(join(tmpDir, "teams", "to-delete.yaml"), "name: to-delete\ndescription: test\nmembers:\n  - name: w\n    systemPrompt: work", "utf-8");

    const pi = createMockExtensionAPI();
    const ctx = createMockContext({
      cwd: tmpDir,
      ui: { ...createMockContext().ui, confirm: vi.fn().mockResolvedValue(true) },
    });
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("delete to-delete", ctx);
    expect(existsSync(join(tmpDir, "teams", "to-delete.yaml"))).toBe(false);
  });

  it("/team status shows no active session", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("无活跃"),
      "info"
    );
  });

  it("/team edit without name shows warning", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("edit", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("用法"),
      "warning"
    );
  });

  it("/team edit nonexistent shows warning", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("edit nonexistent", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("不存在"),
      "warning"
    );
  });

  it("/team unknown shows usage", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("unknown-command", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("用法"),
      "warning"
    );
  });

  it("/team help shows usage with info level", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => { handler = opts.handler; });
    registerTeamCommand(pi, createTeamContext());

    await handler("help", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("用法"),
      "info"
    );
  });

  // ── create_team_definition tool with workflow tests ──

  describe("create_team_definition tool with workflow (dynamically registered via /team create)", () => {
    /** Simulate /team create + return the registered create_team_definition tool */
    async function setupCreateTool(): Promise<{ pi: any; ctx: any; createTool: any; cmdHandler: any }> {
      const pi = createMockExtensionAPI();
      const registeredTools: any[] = [];
      pi.registerTool = vi.fn((def: any) => { registeredTools.push(def); });
      registerTeamCommand(pi, createTeamContext());

      // Trigger /team create to dynamically register create_team_definition
      const cmdHandler = (pi.registerCommand as any).mock.calls[0][1];
      const ctx = createMockContext();
      await cmdHandler.handler("create", ctx);

      const createTool = registeredTools.find((t) => t.name === "create_team_definition");
      expect(createTool).toBeDefined();
      return { pi, ctx, createTool, cmdHandler };
    }

    it("persists workflow to YAML", async () => {
      const { createTool } = await setupCreateTool();

      const result = await createTool.execute("id", {
        name: "test-wf",
        description: "Test with workflow",
        members: [
          { name: "architect", systemPrompt: "design" },
          { name: "coder", systemPrompt: "code" },
        ],
        workflow: {
          strictness: "strict",
          description: "Test workflow",
          stages: [
            { member: "architect", name: "design", description: "Design" },
            { member: "coder", name: "build", description: "Build" },
          ],
          loops: [{ condition: "Retry", stages: ["build"] }],
        },
      });

      expect(result.content[0].text).toContain("已创建成功");

      const { parse: parseYaml } = await import("yaml");
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(join(tmpDir, "teams", "test-wf.yaml"), "utf-8");
      const parsed = parseYaml(raw);
      expect(parsed.workflow).toBeDefined();
      expect(parsed.workflow.strictness).toBe("strict");
      expect(parsed.workflow.stages).toHaveLength(2);
      expect(parsed.workflow.loops).toHaveLength(1);
      expect(parsed.workflow.loops[0].condition).toBe("Retry");
    });

    it("persists workflow with onFailure object", async () => {
      const { createTool } = await setupCreateTool();

      await createTool.execute("id", {
        name: "test-onfail",
        description: "Test onfailure",
        members: [{ name: "w", systemPrompt: "work" }],
        workflow: {
          strictness: "reference",
          stages: [{
            member: "w",
            name: "code",
            description: "Write code",
            onFailure: { returnToStage: "code", condition: "tests fail" },
          }],
        },
      });

      const { parse: parseYaml } = await import("yaml");
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(join(tmpDir, "teams", "test-onfail.yaml"), "utf-8");
      const parsed = parseYaml(raw);
      expect(parsed.workflow.stages[0].onFailure.returnToStage).toBe("code");
      expect(parsed.workflow.stages[0].onFailure.condition).toBe("tests fail");
    });

    it("validates workflow and rejects bad input", async () => {
      const { createTool } = await setupCreateTool();

      const result = await createTool.execute("id", {
        name: "bad-wf",
        description: "Bad workflow",
        members: [{ name: "w", systemPrompt: "work" }],
        workflow: {
          strictness: "reference",
          stages: [{ member: "nonexistent", name: "s1", description: "task" }],
        },
      });

      expect(result.content[0].text).toContain("校验失败");
    });
  });
});
