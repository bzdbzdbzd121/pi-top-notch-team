import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Compile } from "typebox/compile";
import { registerTlTools, WAIT_IDLE_CHECK_INTERVAL_MS, WAIT_IDLE_REQUIRED_CONSECUTIVE, prepareTeamSendAndWaitArgs } from "./tl-tools";
import { createTlWaitGate } from "../channel/tl-wait-gate";
import { startSession, endSession, markSharedContextWritten } from "../session/state";
import { DEFAULT_SETTINGS } from "../settings/settings";
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
    clearCorrelation: vi.fn(),
  };
}

/**
 * P1 模拟框架校验层：用与 pi 框架同库的 TypeBox（Compile）对工具参数做
 * 校验判定——这是 agent-loop validateToolArguments 的核心步骤。
 *
 * 注意（S3）：真实框架路径还包含参数规范化层（normalizeOptionalNulls /
 * Value.Convert / coerceWithJsonSchema），本 helper 只模拟校验判定本身。
 * 对 P1 的断言目标（截断形态是否被 oneOf 拦截、放宽后的 schema 是否放行
 * 九种形态）已足够忠实；且已实测 pi 运行时内置 typebox 1.3.7 与本测试
 * 所用版本对放宽 schema 的判定结果完全一致。
 *
 * P2：按真实 agent-loop 流程执行——先 prepareArguments（校验前规范化，
 * types.d.ts:362），再 Check（validateToolArguments），最后 execute。
 *
 * passed=false 表示参数被框架层拦截（TypeBox oneOf 硬失败）。
 */
/**
 * all-idle 门控 helper：team_send_and_wait 的等待现在必须等到全员空闲
 * （4 次连续 3s 检查的去抖）才返回。在 fake timers 下启动 execute 并
 * 推进去抖窗口后再 await 结果，避免每个成功用例真实等待 ~12s。
 * 注意：`start` 回调内部启动 execute（waitForAllIdle 的 setInterval 必须
 * 在 fake timers 激活后创建）。
 */
async function runWithSettledAllIdle<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const execPromise = start();
    await vi.advanceTimersByTimeAsync(
      WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 2)
    );
    return await execPromise;
  } finally {
    vi.useRealTimers();
  }
}

async function executeViaFramework(toolDef: any, args: unknown) {
  // 真实流程：prepareArguments → validateToolArguments（Check）→ execute
  const prepared = toolDef.prepareArguments ? toolDef.prepareArguments(args) : args;
  const validator = Compile(toolDef.parameters);
  if (!validator.Check(prepared)) {
    return { passed: false as const, result: undefined };
  }
  // all-idle 门控（与 wait_and_get_member_status 一致）：成员状态在这些
  // 用例里均为 idle，去抖一定能满足。
  const result = await runWithSettledAllIdle(() => toolDef.execute("call-1", prepared) as Promise<any>);
  return { passed: true as const, result };
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
    getSettings?: any;
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
      getSettings: overrides?.getSettings,
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
    const def = (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.find((c: any[]) => c[0].name === "start_member")![0];
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
      expect(toolDef.parameters.properties.tasks.oneOf.length).toBe(3);
      // P1: array 分支 items 放宽为 {}（不再有 type/required 硬约束——
      // 截断形态的缺字段条目必须放行到 execute，由 isValidTask 统一过滤）
      expect(toolDef.parameters.properties.tasks.oneOf[0].type).toBe("array");
      expect(toolDef.parameters.properties.tasks.oneOf[0].items).toEqual({});
      // P1: 新增 object 分支（单对象自动包裹），不设 required（D4）
      expect(toolDef.parameters.properties.tasks.oneOf[1].type).toBe("object");
      expect(toolDef.parameters.properties.tasks.oneOf[1].required).toBeUndefined();
      // string 分支保留（parseTasks 恢复/salvage）
      expect(toolDef.parameters.properties.tasks.oneOf[2].type).toBe("string");
      expect(toolDef.parameters.properties.nextSteps).toBeDefined();
      expect(toolDef.parameters.properties.nextSteps.type).toBe("string");
      // Old fields removed
      expect(toolDef.parameters.properties.to).toBeUndefined();
      expect(toolDef.parameters.properties.content).toBeUndefined();
    });

    // ── P1 模拟框架校验层矩阵（γ 三形态实测表扩展，全部应先通过框架校验）──

    /** 拿 team_send_and_wait 的 tool 定义（含 parameters + execute）。 */
    function getTeamSendAndWaitDef(overrides?: Parameters<typeof callRegisterTlTools>[0]) {
      let toolDef: any = null;
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") toolDef = def;
      });
      callRegisterTlTools(overrides);
      return toolDef;
    }

    it("矩阵①正确数组：通过框架校验并正常派发", async () => {
      memberOpsStates.set("worker", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: [{ to: "worker", content: "Do the task" }],
        nextSteps: "next",
      });
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain("下一步计划");
    });

    it("矩阵②缺 to 数组：通过框架校验，execute 丢弃 + 逐条 note + 截断嫌疑警告", async () => {
      memberOpsStates.set("worker", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        // 用户报告的失败形态：tasks[0] 仅含 content，缺 to
        tasks: [{ content: "长内容" }, { to: "worker", content: "ok" }],
        nextSteps: "next",
      });
      expect(passed).toBe(true); // P1 验收②：不再出现 TypeBox 框架错误
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1); // 有效条目照常派发
      expect(result.content[0].text).toContain("1 个任务条目无效已被丢弃");
      expect(result.content[0].text).toContain("疑似参数生成时被截断");
      expect(result.content[0].text).toContain("tasks[0] 缺少有效的 to 字段，已丢弃");
    });

    it("矩阵③缺 content 数组：通过框架校验，execute 丢弃 + 逐条 note", async () => {
      memberOpsStates.set("worker", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: [{ to: "worker" }, { to: "worker", content: "ok" }],
        nextSteps: "next",
      });
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain("tasks[0] 缺少有效的 content 字段，已丢弃");
    });

    it("矩阵④单对象：通过 object 分支校验，execute 包裹派发（死代码转正）", async () => {
      memberOpsStates.set("planner", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: { to: "planner", content: "Do the plan" },
        nextSteps: "review",
      });
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
    });

    it("矩阵⑤双编码字符串：通过 string 分支校验，execute JSON.parse 恢复", async () => {
      memberOpsStates.set("planner", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: JSON.stringify([{ to: "planner", content: "Do the plan" }]),
        nextSteps: "review the plan",
      });
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
    });

    it("矩阵⑥断串字符串：通过 string 分支校验，execute salvage 恢复", async () => {
      memberOpsStates.set("planner", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const truncated =
        '[{"to": "planner", "content": "Do the plan"}, {"to": "analyst", "content": "cut-off-mid-'
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: truncated,
        nextSteps: "continue",
      });
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
      expect(result.content[0].text).toContain("已尽力恢复 1 个任务");
      expect(result.content[0].text).toContain("丢弃 1 个不完整条目");
    });

    it("矩阵⑦空数组：通过框架校验，execute 返回 0 任务错误", async () => {
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: [],
        nextSteps: "do something",
      });
      expect(passed).toBe(true);
      expect(result.content[0].text).toContain("无效");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it("矩阵⑧null 元素：通过 items {} 校验，execute 丢弃 + 逐条 note", async () => {
      memberOpsStates.set("worker", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: [null, { to: "worker", content: "ok" }],
        nextSteps: "next",
      });
      expect(passed).toBe(true); // items 放宽为 {} 后 null 不再触发 oneOf 硬失败
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain("tasks[0] 不是对象，已丢弃");
    });

    it("矩阵⑨to 截半：通过框架校验，execute 未知成员错误 + 截断提示", async () => {
      memberOpsStates.set("coder", "idle");
      const toolDef = getTeamSendAndWaitDef();
      // γ 实测形态：长 content 后 to 被截成单个字符
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: [{ to: "c", content: "some content" }],
        nextSteps: "next",
      });
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("不存在或未启动");
      expect(result.content[0].text).toContain("to 值可能被截断");
      expect(result.content[0].text).toContain("请重发完整成员名");
    });

    it("0 任务截断启发式：缺 to 且 content 超长（>500）时错误含截断指引", async () => {
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        // 截断诱因形态：超长 content 把 to 挤出输出预算
        tasks: [{ content: "x".repeat(600) }],
        nextSteps: "next",
      });
      expect(passed).toBe(true);
      expect(result.content[0].text).toContain("无效");
      expect(result.content[0].text).toContain("参数疑似在输出传输中被截断");
      expect(result.content[0].text).toContain("请精简 content、拆分为多次调用");
      // S2：0 任务错误文本同时拼入逐条字段原因
      expect(result.content[0].text).toContain("tasks[0] 缺少有效的 to 字段，已丢弃");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it("0 任务截断启发式：单对象缺 to 且 content 超长同样触发", async () => {
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        // 单对象缺 to 形态（object 分支放行，parseTasks 无效对象路径）
        tasks: { content: "x".repeat(600) },
        nextSteps: "next",
      });
      expect(passed).toBe(true); // object 分支放行
      expect(result.content[0].text).toContain("无效");
      expect(result.content[0].text).toContain("参数疑似在输出传输中被截断");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it("0 任务截断启发式：content 短（≤500）时不给出截断指引", async () => {
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: [{ content: "short" }],
        nextSteps: "next",
      });
      expect(passed).toBe(true);
      expect(result.content[0].text).toContain("无效");
      expect(result.content[0].text).not.toContain("参数疑似在输出传输中被截断");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    it("框架层整体拦截：tasks 为 null / 数字（非三形态，不可恢复）", async () => {
      const toolDef = getTeamSendAndWaitDef();
      // 非 array/object/string 三形态的值过不了 oneOf（与截断无关，属模型
      // 传错类型）——框架层拦截是显式信号，execute 不执行。
      const nullResult = await executeViaFramework(toolDef, { tasks: null, nextSteps: "x" });
      expect(nullResult.passed).toBe(false);
      const numResult = await executeViaFramework(toolDef, { tasks: 42, nextSteps: "x" });
      expect(numResult.passed).toBe(false);
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
    });

    // ── P2 prepareArguments 校验前规范化 ──

    it("P2: team_send_and_wait 注册了 prepareArguments 钩子", () => {
      const toolDef = getTeamSendAndWaitDef();
      expect(typeof toolDef.prepareArguments).toBe("function");
    });

    // ── P3 promptGuidelines 防截断协议 ──

    it("P3: promptGuidelines 含防截断协议（5 条：长 content 拆分/独立文件引用、tool call 数量、短重试、先 to 后 content、未知成员疑截断）", () => {
      const toolDef = getTeamSendAndWaitDef();
      const guidelines = toolDef.promptGuidelines.join("\n");
      // ① content 超 ~800 字符 → 拆分多次调用 / 指示成员读文件；
      //    任务详情不写入 .shared-context.md（D6：全员共享 + 全量覆盖污染）
      expect(guidelines).toContain("800");
      expect(guidelines).toContain(".shared-context.md");
      // ② 每回合 tool call 数量控制（同批多 call 挤占输出预算）
      expect(guidelines).toContain("tool call");
      // ③ Validation failed → 更短 content 重试，不原样重发
      expect(guidelines).toContain("更短");
      expect(guidelines).toContain("原样重发");
      // ④ 键序：先写 to 再写 content（截断后幸存字段）
      expect(guidelines).toContain("先写 to");
      // ⑤ 未知成员错误 → 先疑 to 截断，重发完整名
      expect(guidelines).toContain("未知成员");
      expect(guidelines).toContain("重发完整");
    });

    it("P2: 双编码字符串经 prepare 后以数组形态通过框架校验", async () => {
      memberOpsStates.set("planner", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const args = { tasks: JSON.stringify([{ to: "planner", content: "Do" }]), nextSteps: "x" };
      // 校验前规范化：字符串 → 数组
      const prepared = toolDef.prepareArguments(args);
      expect(Array.isArray(prepared.tasks)).toBe(true);
      expect(Compile(toolDef.parameters).Check(prepared)).toBe(true);
      // 全流程：prepare → Check → execute 正常派发
      const { passed, result } = await executeViaFramework(toolDef, args);
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
    });

    it("P2: 单对象经 prepare 后以数组形态通过框架校验", async () => {
      memberOpsStates.set("planner", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const args = { tasks: { to: "planner", content: "Do" }, nextSteps: "x" };
      const prepared = toolDef.prepareArguments(args);
      expect(prepared.tasks).toEqual([{ to: "planner", content: "Do" }]);
      expect(Compile(toolDef.parameters).Check(prepared)).toBe(true);
      const { passed } = await executeViaFramework(toolDef, args);
      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
    });

    it("未知成员错误：to 不是成员名前缀时不附截断提示", async () => {
      memberOpsStates.set("existing-member", "idle");
      const toolDef = getTeamSendAndWaitDef();
      const { passed, result } = await executeViaFramework(toolDef, {
        tasks: [{ to: "nonexistent-member", content: "Do something" }],
        nextSteps: "next",
      });
      expect(passed).toBe(true);
      expect(result.content[0].text).toContain("不存在或未启动");
      expect(result.content[0].text).not.toContain("to 值可能被截断");
      expect(messageQueue.enqueue).not.toHaveBeenCalled();
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

      // all-idle 门控：回复到达不再结束等待——必须推过全员空闲去抖窗口
      vi.useFakeTimers();
      let result: any;
      try {
        const resultPromise = executeFn("call-1", {
          tasks: [{ to: "worker", content: "Do the task" }],
          nextSteps: "Check the result and assign the next task",
        });
        await vi.advanceTimersByTimeAsync(
          WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 2)
        );
        result = await resultPromise;
      } finally {
        vi.useRealTimers();
      }

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

      const result = await runWithSettledAllIdle(async () => {
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

        // Resolve both waiters —— 回复全部到达，但 all-idle 门控下等待仍需
        // 推到全员空闲才结束（这正是本次变更的核心语义）
        resolveFns[0]({ status: "response", from: "security-reviewer", content: "安全无问题" });
        resolveFns[1]({ status: "response", from: "perf-reviewer", content: "发现 O(n²) 循环" });
        return resultPromise;
      });

      expect(result.content[0].text).toContain("security-reviewer");
      expect(result.content[0].text).toContain("安全无问题");
      expect(result.content[0].text).toContain("perf-reviewer");
      expect(result.content[0].text).toContain("发现 O(n²) 循环");
      expect(result.content[0].text).toContain("下一步计划");
      expect(result.details).toEqual({ nextSteps: "合并审查意见" });
    });

    it("all-idle gate: 回复到达不结束等待——必须等到全员空闲（本次变更核心语义）", { timeout: 5000 }, async () => {
      // 用户需求：member 回复不再结束等待，必须等到所有 member 空闲才结束
      //（与 wait_and_get_member_status 一致）——即使所有目标成员都已回复，
      // 只要还有任何成员在 working，等待就继续。
      memberOpsStates.set("security-reviewer", "idle");
      memberOpsStates.set("busy-reviewer", "working"); // 非目标成员仍在工作

      const mockResponseWaiter = createMockResponseWaiter();
      mockResponseWaiter.waitForResponse = vi.fn().mockResolvedValue({
        status: "response",
        from: "security-reviewer",
        content: "已回复，但别人还在干活",
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

      vi.useFakeTimers();
      try {
        const resultPromise = executeFn("call-gate", {
          tasks: [{ to: "security-reviewer", content: "审查安全" }],
          nextSteps: "汇总",
        });

        // 回复已到达（waiter 同步 resolve），但 busy-reviewer 仍在 working：
        // 推过整个去抖窗口，等待不得结束（旧语义下 all_done 会立即返回）。
        await vi.advanceTimersByTimeAsync(
          WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 2)
        );
        let settled = false;
        void resultPromise.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(0); // flush microtasks
        expect(settled).toBe(false);

        // busy-reviewer 转为 idle → 门控在去抖窗口后放行，回复随结果返回
        memberOpsStates.set("busy-reviewer", "idle");
        await vi.advanceTimersByTimeAsync(
          WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 2)
        );
        const result = await resultPromise;

        expect(result.details).toEqual({ nextSteps: "汇总" });
        expect(result.content[0].text).toContain("已回复，但别人还在干活");
        expect(result.content[0].text).not.toContain("等待超时");
      } finally {
        vi.useRealTimers();
      }
    });

    it("S3: 等待期间到达的 member→TL 消息在门控打开时经 steer 即时注入（不等 TL 回合结束）", { timeout: 5000 }, async () => {
      // 阶段 3：gate 活跃时 sendToTl 会把非回复消息缓冲到 tlWaitGate；
      // all-idle 门控打开的瞬间，waitWithAllIdleCheck 把缓冲消息经
      // pi.sendMessage（无 deliverAs → 工具执行期 = steer 分支，注入在
      // 工具结果之后、同一回合内）投递给 TL。
      memberOpsStates.set("worker", "idle");

      const gate = createTlWaitGate();
      const piFlush = {
        ...createMockPi(),
        sendMessage: vi.fn(),
      };
      const mockResponseWaiter = createMockResponseWaiter();
      mockResponseWaiter.waitForResponse = vi.fn().mockResolvedValue({
        status: "response",
        from: "worker",
        content: "Task done",
      });

      let executeFn: Function = () => {};
      piFlush.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      registerTlTools({
        pi: piFlush as any,
        manager,
        responseWaiter: mockResponseWaiter,
        memberOpsStates,
        lastPendingCorrId,
        messageQueue,
        tlWaitGate: gate,
      });

      vi.useFakeTimers();
      try {
        const resultPromise = executeFn("call-s3", {
          tasks: [{ to: "worker", content: "Do the task" }],
          nextSteps: "next",
        });

        // 等待期间（去抖窗口内）模拟通道投递：成员的非回复消息进缓冲。
        // sendToTl 的缓冲分支已在 message-channel.test.ts 锁定；此处直接
        // 向 gate 注入以驱动 flush 路径。
        gate.buffer({ id: "m1", from: "worker", to: "tl", content: "等待期间的补充汇报", timestamp: Date.now() });
        gate.buffer({ id: "m2", from: "analyst", to: "tl", content: "顺手发现的问题", subject: "侧线发现", timestamp: Date.now() });

        await vi.advanceTimersByTimeAsync(
          WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 2)
        );
        const result = await resultPromise;

        // 门控打开：缓冲消息逐条以 S2 原格式 steer 投递（单参数调用——无 nextTurn/followUp）
        expect(piFlush.sendMessage).toHaveBeenCalledTimes(2);
        const calls = (piFlush.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
        for (const [m, opt] of calls) {
          expect(m.customType).toBe("team-message");
          expect(m.display).toBe(true);
          expect(opt).toBeUndefined(); // steer：注入在工具结果之后、同一回合
        }
        // 逐条 S2 原格式、精确匹配：无合并包头 / 编号标注等元信息
        //（用户裁决：保持 TL 上下文干净，与 nextTurn 路径消息外观完全一致）
        expect(calls[0][0].content).toBe("[消息通道 - 来自 worker]\n等待期间的补充汇报");
        expect(calls[1][0].content).toBe("[消息通道 - 来自 analyst]\n主题：侧线发现\n顺手发现的问题");
        expect(calls[0][0].content).not.toContain("条消息");
        expect(calls[0][0].content).not.toContain("【消息");
        // 缓冲已清空；工具结果本身不受影响
        expect(gate.drain()).toEqual([]);
        expect(result.content[0].text).toContain("Task done");
        expect(result.content[0].text).toContain("下一步计划");
      } finally {
        vi.useRealTimers();
      }
    });

    it("S3: 无 tlWaitGate 接线时零行为变化（legacy 路径，flush 直接跳过）", { timeout: 5000 }, async () => {
      memberOpsStates.set("worker", "idle");
      const piNoGate = {
        ...createMockPi(),
        sendMessage: vi.fn(),
      };
      const mockResponseWaiter = createMockResponseWaiter();
      mockResponseWaiter.waitForResponse = vi.fn().mockResolvedValue({
        status: "response",
        from: "worker",
        content: "Task done",
      });

      let executeFn: Function = () => {};
      piNoGate.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      registerTlTools({
        pi: piNoGate as any,
        manager,
        responseWaiter: mockResponseWaiter,
        memberOpsStates,
        lastPendingCorrId,
        messageQueue,
        // 故意不传 tlWaitGate
      });

      vi.useFakeTimers();
      try {
        const resultPromise = executeFn("call-s3b", {
          tasks: [{ to: "worker", content: "Do the task" }],
          nextSteps: "next",
        });
        await vi.advanceTimersByTimeAsync(
          WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 2)
        );
        const result = await resultPromise;

        expect(piNoGate.sendMessage).not.toHaveBeenCalled();
        expect(result.content[0].text).toContain("Task done");
      } finally {
        vi.useRealTimers();
      }
    });

    it("team_send_and_wait returns partial results when all members become idle", async () => {
      memberOpsStates.set("security-reviewer", "idle");
      memberOpsStates.set("perf-reviewer", "idle");

      const mockResponseWaiter = createMockResponseWaiter();
      // One resolves, one never resolves
      mockResponseWaiter.waitForResponse = vi.fn((corrId: string) => {
        if (corrId.includes("resolve")) {
          return Promise.resolve({ status: "response" as const, from: "security-reviewer", content: "完成" });
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

      // 成员均 idle 且无人回复 → 门控在去抖窗口后返回 partial 结果
      const result = await runWithSettledAllIdle(() =>
        executeFn("call-2", {
          tasks: [
            { to: "security-reviewer", content: "审查安全" },
            { to: "perf-reviewer", content: "审查性能" },
          ],
          nextSteps: "处理检查结果",
        }) as Promise<any>
      );

      expect(result.details).toHaveProperty("allIdle");
      expect(result.details).toHaveProperty("partial");
      expect(result.details).toHaveProperty("nextSteps");
      expect(result.details.nextSteps).toBe("处理检查结果");
      // Should show both members with warning since none resolved
      expect(result.content[0].text).toContain("security-reviewer");
      expect(result.content[0].text).toContain("perf-reviewer");
      expect(result.content[0].text).toContain("⚠️");
    });

    it("team_send_and_wait all-idle gate: deadline expiry returns partial + stuck-member diagnostic (Phase 1)", {"timeout": 5000}, async () => {
      // The user scenario: a member is stuck in `working` (the compaction
      // timeout black hole). team_send_and_wait's all-idle path must not
      // wait forever — the deadline returns partial results with a
      // diagnostic so the TL can act (stop_member / resume).
      vi.useFakeTimers();
      try {
        memberOpsStates.set("worker", "working"); // stuck forever

        responseWaiter.waitForResponse = vi.fn(() => new Promise<WaitResult>(() => {}));

        let executeFn: Function = () => {};
        pi.registerTool = vi.fn((def: any) => {
          if (def.name === "team_send_and_wait") {
            executeFn = def.execute;
          }
        });

        callRegisterTlTools();

        const resultPromise = executeFn("call-dl", {
          tasks: [{ to: "worker", content: "Do work" }],
          nextSteps: "check",
        });
        await vi.advanceTimersByTimeAsync(15 * 60_000 + WAIT_IDLE_CHECK_INTERVAL_MS);
        const result = await resultPromise;

        expect(result.details).toHaveProperty("allIdle");
        expect(result.content[0].text).toContain("等待超时");
        expect(result.content[0].text).toContain("worker");
        expect(result.content[0].text).toContain("stop_member");
      } finally {
        vi.useRealTimers();
      }
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
      const result = await runWithSettledAllIdle(() =>
        executeFn("call-1", {
          tasks: JSON.stringify([{ to: "planner", content: "Do the plan" }]),
          nextSteps: "review the plan",
        }) as Promise<any>
      );

      // Should still have sent the message
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
      // Response waiter should have been set up
      const callArg = (messageQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
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

      // Simulate LLM sending a single object instead of array.
      // P1: 走模拟框架校验层——单对象必须通过 object 分支校验才到 execute。
      const { passed, result } = await executeViaFramework(
        (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.find((c: any[]) => c[0].name === "team_send_and_wait")![0],
        { tasks: { to: "planner", content: "Do the plan" }, nextSteps: "review" }
      );

      // Should still have sent the message
      expect(passed).toBe(true);
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

      const result = await runWithSettledAllIdle(() =>
        executeFn("call-1", {
          tasks: truncated,
          nextSteps: "continue",
        }) as Promise<any>
      );

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

      await runWithSettledAllIdle(() =>
        executeFn("call-1", {
          tasks: withRawNewline,
          nextSteps: "continue",
        }) as Promise<any>
      );

      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      const callArg = (messageQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.to).toBe("planner");
      expect(callArg.content).toContain("line1\nline2");
    });

    it("team_send_and_wait drops invalid entries from a raw array and warns (逐条 note)", async () => {
      memberOpsStates.set("planner", "idle");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "team_send_and_wait") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      // P1: 走模拟框架校验层（旧测试直接调 executeFn，绕过框架校验，与真实行为脱节）
      const { passed, result } = await executeViaFramework(
        (pi.registerTool as ReturnType<typeof vi.fn>).mock.calls.find((c: any[]) => c[0].name === "team_send_and_wait")![0],
        { tasks: [{ to: "planner", content: "ok" }, { to: 123 }, "junk", {}], nextSteps: "continue" }
      );

      expect(passed).toBe(true);
      expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(messageQueue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ to: "planner" })
      );
      // 首行醒目警告 + 逐条字段级原因
      expect(result.content[0].text).toContain("⚠️ 3 个任务条目无效已被丢弃");
      expect(result.content[0].text).toContain("tasks[1] 缺少有效的 to 与 content 字段，已丢弃");
      expect(result.content[0].text).toContain("tasks[2] 不是对象，已丢弃");
      expect(result.content[0].text).toContain("tasks[3] 缺少有效的 to 与 content 字段，已丢弃");
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

    // ── Phase 1: wait deadline + diagnostic (defense in depth) ──
    // The user's main symptom: wait_and_get_member_status hangs FOREVER after
    // a compaction timeout left a member in the `working` black hole. The
    // deadline is the final exit — the user gets their tools back with a
    // diagnostic instead of an infinite hang.

    it("returns a diagnostic instead of hanging forever when a member stays active past the deadline", { timeout: 5000 }, async () => {
      vi.useFakeTimers();
      // The black hole: a member stuck in working with no event that will
      // ever clear it (the Phase-1 bug scenario).
      memberOpsStates.set("worker", "working");

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const resultPromise = executeFn("call-dl");
      // Default deadline: 15 min (no config in this harness) + one poll tick.
      await vi.advanceTimersByTimeAsync(15 * 60_000 + WAIT_IDLE_CHECK_INTERVAL_MS);
      const result = await resultPromise;

      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("等待超时");
      expect(result.content[0].text).toContain("stop_member");
    });

    it("honors the configured waitTimeoutMinutes budget (top-level, independent of auto-compaction)", { timeout: 5000 }, async () => {
      vi.useFakeTimers();
      try {
        memberOpsStates.set("worker", "working"); // stuck black hole

        let executeFn: Function = () => {};
        pi.registerTool = vi.fn((def: any) => {
          if (def.name === "wait_and_get_member_status") {
            executeFn = def.execute;
          }
        });

        // getSettings is provided (production wiring): a 1-minute waitTimeoutMinutes
        // must bound the wait — the diagnostic fires way before the 15-min default.
        callRegisterTlTools({
          getSettings: () => ({ ...structuredClone(DEFAULT_SETTINGS), waitTimeoutMinutes: 1 }),
        });

        const resultPromise = executeFn("call-dl");
        await vi.advanceTimersByTimeAsync(60_000 + WAIT_IDLE_CHECK_INTERVAL_MS);
        const result = await resultPromise;

        expect(result.content[0].text).toContain("等待超时");
        expect(result.content[0].text).toContain("worker");

        // 0 = unlimited (original never-timeout semantics): the wait must still
        // be pending well past the default 15 minutes would have fired.
        memberOpsStates.clear();
        memberOpsStates.set("worker", "working");
        callRegisterTlTools({
          getSettings: () => ({ ...structuredClone(DEFAULT_SETTINGS), waitTimeoutMinutes: 0 }),
        });
        const unlimitedPromise = executeFn("call-unlimited");
        let resolved = false;
        void unlimitedPromise.then(() => { resolved = true; });
        await vi.advanceTimersByTimeAsync(16 * 60_000 + WAIT_IDLE_CHECK_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(0); // flush microtasks, no poll due
        expect(resolved).toBe(false);

        // Release the member — the wait resolves normally, with no diagnostic.
        memberOpsStates.set("worker", "idle");
        await vi.advanceTimersByTimeAsync(WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 1));
        const unlimitedResult = await unlimitedPromise;
        expect(unlimitedResult.content[0].text).not.toContain("等待超时");
      } finally {
        vi.useRealTimers();
      }
    });

    it("regression (Phase 1): after the rejection correction restores the member, wait returns normally — no deadlock", { timeout: 5000 }, async () => {
      vi.useFakeTimers();
      // Simulates the bug chain: compaction timeout → prompt rejected →
      // get_state correction restored compacting → compaction_end → idle.
      // The tool must return promptly once the member is out of the black
      // hole — the old code would have hung here.
      memberOpsStates.set("worker", "compacting"); // correction in progress

      let executeFn: Function = () => {};
      pi.registerTool = vi.fn((def: any) => {
        if (def.name === "wait_and_get_member_status") {
          executeFn = def.execute;
        }
      });

      callRegisterTlTools();

      const resultPromise = executeFn("call-rej");
      await vi.advanceTimersByTimeAsync(WAIT_IDLE_CHECK_INTERVAL_MS * 2);

      memberOpsStates.set("worker", "idle"); // compaction_end arrived → idle
      await vi.advanceTimersByTimeAsync(
        WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 1)
      );

      const result = await resultPromise;
      expect(result.content[0].text).toContain("worker");
      expect(result.content[0].text).toContain("idle");
      expect(result.content[0].text).not.toContain("等待超时");
    });

    it("waitForAllIdle resolves with the stuck members when the deadline expires", { timeout: 5000 }, async () => {
      vi.useFakeTimers();
      const { waitForAllIdle } = await import("./tl-tools");
      const states = new Map<string, MemberOperationalState>([
        ["worker", "working"],
        ["analyzer", "idle"],
      ]);

      const promise = waitForAllIdle(states, 2 * WAIT_IDLE_CHECK_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(3 * WAIT_IDLE_CHECK_INTERVAL_MS);

      await expect(promise).resolves.toEqual({ timedOut: true, stuckMembers: ["worker"] });
    });

    it("waitForAllIdle with deadline 0 is unlimited (status quo)", { timeout: 5000 }, async () => {
      vi.useFakeTimers();
      const { waitForAllIdle } = await import("./tl-tools");
      const states = new Map<string, MemberOperationalState>([["worker", "working"]]);

      const promise = waitForAllIdle(states, 0);
      // Way past the default deadline — the poll must still be alive.
      await vi.advanceTimersByTimeAsync(2 * 15 * 60_000);

      // Member becomes idle → resolves normally, no timeout.
      states.set("worker", "idle");
      await vi.advanceTimersByTimeAsync(
        WAIT_IDLE_CHECK_INTERVAL_MS * (WAIT_IDLE_REQUIRED_CONSECUTIVE + 1)
      );
      await expect(promise).resolves.toEqual({ timedOut: false, stuckMembers: [] });
    });

    it("waitForAllIdle unrefs its poll timer (no polling leak after Esc interrupt)", async () => {
      const unref = vi.fn();
      let capturedCallback: (() => void) | undefined;
      const setIntervalSpy = vi
        .spyOn(globalThis, "setInterval")
        .mockImplementation(((cb: () => void) => {
          capturedCallback = cb;
          return { unref, ref: vi.fn() } as any;
        }) as any);
      try {
        const { waitForAllIdle } = await import("./tl-tools");
        const states = new Map<string, MemberOperationalState>([["worker", "idle"]]);

        const promise = waitForAllIdle(states);
        expect(unref).toHaveBeenCalled();

        // Drive 4 consecutive idle checks so the poll resolves (no dangling timer).
        capturedCallback!();
        capturedCallback!();
        capturedCallback!();
        capturedCallback!();
        await expect(promise).resolves.toEqual({ timedOut: false, stuckMembers: [] });
      } finally {
        setIntervalSpy.mockRestore();
      }
    });
  });
});

// ── Additional execute behavior tests ──────────────────────

describe("prepareTeamSendAndWaitArgs (P2 校验前规范化单测)", () => {
  it("string 编码数组（严格 JSON.parse 成功）→ 转数组", () => {
    const out = prepareTeamSendAndWaitArgs({
      tasks: JSON.stringify([{ to: "planner", content: "Do" }, { to: "coder", content: "Code" }]),
      nextSteps: "x",
    });
    expect(out).toEqual({
      tasks: [{ to: "planner", content: "Do" }, { to: "coder", content: "Code" }],
      nextSteps: "x",
    });
  });

  it("string 编码单对象 → 包裹为数组", () => {
    const out = prepareTeamSendAndWaitArgs({
      tasks: JSON.stringify({ to: "planner", content: "Do" }),
      nextSteps: "x",
    }) as { tasks: unknown; nextSteps: string };
    expect(out.tasks).toEqual([{ to: "planner", content: "Do" }]);
  });

  it("string 编码缺字段对象 → 包裹为数组（条目不修复）", () => {
    const out = prepareTeamSendAndWaitArgs({
      tasks: JSON.stringify({ content: "long" }),
      nextSteps: "x",
    }) as { tasks: unknown; nextSteps: string };
    expect(out.tasks).toEqual([{ content: "long" }]);
  });

  it("断串（JSON.parse 失败）→ 原样放行，不抛错（execute salvage 兜底）", () => {
    const args = { tasks: '[{"to": "planner", "content": "cut-', nextSteps: "x" };
    expect(() => prepareTeamSendAndWaitArgs(args)).not.toThrow();
    expect(prepareTeamSendAndWaitArgs(args)).toBe(args);
  });

  it("单对象 → 包裹为数组", () => {
    const out = prepareTeamSendAndWaitArgs({
      tasks: { to: "planner", content: "Do" },
      nextSteps: "x",
    }) as { tasks: unknown; nextSteps: string };
    expect(out.tasks).toEqual([{ to: "planner", content: "Do" }]);
  });

  it("缺字段单对象 → 包裹为数组（条目不修复，execute 丢弃 + 逐条提示）", () => {
    const out = prepareTeamSendAndWaitArgs({
      tasks: { content: "long content here" },
      nextSteps: "x",
    }) as { tasks: unknown; nextSteps: string };
    expect(out.tasks).toEqual([{ content: "long content here" }]);
  });

  it("缺 to 数组 → 原样放行（不抛错、不修复）", () => {
    const args = { tasks: [{ content: "x" }], nextSteps: "x" };
    expect(() => prepareTeamSendAndWaitArgs(args)).not.toThrow();
    expect(prepareTeamSendAndWaitArgs(args)).toBe(args);
  });

  it("数组形态（含空数组）→ 原样放行", () => {
    const args1 = { tasks: [{ to: "a", content: "b" }], nextSteps: "x" };
    expect(prepareTeamSendAndWaitArgs(args1)).toBe(args1);
    const args2 = { tasks: [], nextSteps: "x" };
    expect(prepareTeamSendAndWaitArgs(args2)).toBe(args2);
  });

  it("tasks 为 null / 数字 / 缺 tasks 字段 → 原样放行（框架拦截或 execute 兜底）", () => {
    const nullOut = prepareTeamSendAndWaitArgs({ tasks: null, nextSteps: "x" }) as { tasks: unknown };
    expect(nullOut.tasks).toBeNull();
    const numOut = prepareTeamSendAndWaitArgs({ tasks: 42, nextSteps: "x" }) as { tasks: unknown };
    expect(numOut.tasks).toBe(42);
    const noTasks = { nextSteps: "x" };
    expect(prepareTeamSendAndWaitArgs(noTasks)).toBe(noTasks);
    expect(prepareTeamSendAndWaitArgs("not-an-object")).toBe("not-an-object");
    expect(prepareTeamSendAndWaitArgs(null)).toBeNull();
  });

  it("幂等：对输出再调用结果不变", () => {
    const once = prepareTeamSendAndWaitArgs({
      tasks: JSON.stringify([{ to: "planner", content: "Do" }]),
      nextSteps: "x",
    });
    expect(prepareTeamSendAndWaitArgs(once)).toEqual(once);
  });

  it("修复路径输出恒满足放宽后的 schema（无二次校验失败）", () => {
    const schema = {
      type: "object",
      properties: {
        tasks: {
          oneOf: [{ type: "array", items: {} }, { type: "object" }, { type: "string" }],
        },
        nextSteps: { type: "string" },
      },
      required: ["tasks", "nextSteps"],
    };
    const validator = Compile(schema);
    const inputs = [
      { tasks: JSON.stringify([{ to: "a", content: "b" }]), nextSteps: "x" },
      { tasks: JSON.stringify({ to: "a", content: "b" }), nextSteps: "x" },
      { tasks: { to: "a", content: "b" }, nextSteps: "x" },
      { tasks: { content: "only-content" }, nextSteps: "x" },
      { tasks: [{ to: "a" }], nextSteps: "x" },
      { tasks: [], nextSteps: "x" },
    ];
    for (const input of inputs) {
      expect(validator.Check(prepareTeamSendAndWaitArgs(input))).toBe(true);
    }
  });
});

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


