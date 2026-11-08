/**
 * 阶段 5（方案 §3.5 第一层）：`team_send_and_wait` 入队前的目标校验。
 *
 * 目标句柄**明确**未在运行（stopped / error）→ 立即返回可执行提示，零副作用
 * （不入队、不注册等待、不写状态）。句柄不存在（从未启动）保持既有「不存在或
 * 未启动」语义；句柄查询依赖未接线或查询抛错 → fail-open（旧行为不变）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerTlTools, WAIT_IDLE_CHECK_INTERVAL_MS, WAIT_IDLE_REQUIRED_CONSECUTIVE } from "./tl-tools";
import { startSession, endSession, markSharedContextWritten } from "../session/state";
import { resetSessionSettingsState } from "../settings/session-settings";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { MemberOperationalState } from "../session/context";
import type { MemberProcessHandle, MemberStatus } from "../process/member-process";

function createHandle(name: string, status: MemberStatus): MemberProcessHandle {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => ({ name, pid: status === "running" ? 4321 : null, status })),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn().mockResolvedValue({}),
  };
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
 * all-idle 门控（去抖 4 × 3s）：成功路径必须推过整个去抖窗口才返回，
 * 否则用例会真实等待 ~12s。fake timers 下启动 execute 再推进窗口。
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

describe("team_send_and_wait 派发前目标校验（阶段 5 第一层）", () => {
  let messageQueue: MessageQueue;
  let lastPendingCorrId: Map<string, string>;
  let memberOpsStates: Map<string, MemberOperationalState>;

  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    resetSessionSettingsState();
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [
        { name: "coder", systemPrompt: "code" },
        { name: "reviewer", systemPrompt: "review" },
      ],
    });
    markSharedContextWritten();
    messageQueue = {
      enqueue: vi.fn(),
      length: vi.fn().mockReturnValue(0),
      drain: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    lastPendingCorrId = new Map();
    memberOpsStates = new Map<string, MemberOperationalState>([
      ["coder", "idle"],
      ["reviewer", "idle"],
    ]);
  });

  afterEach(() => {
    endSession();
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  });

  function register(getHandle?: (name: string) => MemberProcessHandle | undefined) {
    const tools = new Map<string, any>();
    const pi = {
      registerTool: vi.fn((def: any) => {
        tools.set(def.name, def);
      }),
    } as unknown as ExtensionAPI;
    registerTlTools({
      pi,
      manager: createMockManager(),
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates,
      lastPendingCorrId,
      messageQueue,
      createMember: vi.fn(),
      buildMemberConfig: vi.fn(),
      getHandle,
    });
    return tools.get("team_send_and_wait");
  }

  it("目标已停止 → 立即返回提示，不入队、不注册等待、状态不变", async () => {
    const send = register(() => createHandle("coder", "stopped"));

    const result = await send.execute("call-1", {
      tasks: [{ to: "coder", content: "检查一下" }],
      nextSteps: "无",
    });
    const text = result.content[0].text;

    expect(text).toContain('无法派发：目标成员 "coder" 当前未在运行（已停止或崩溃）。');
    expect(text).toContain('请先 start_member("coder") 后再派发；本次没有发送任何任务。');
    expect(messageQueue.enqueue).not.toHaveBeenCalled();
    expect(lastPendingCorrId.size).toBe(0);
    expect(memberOpsStates.get("coder")).toBe("idle");
  });

  it("多目标里有一个已停止 → 整批拒绝并逐个列出（零副作用）", async () => {
    const send = register((name) =>
      createHandle(name, name === "reviewer" ? "error" : "running")
    );

    const result = await send.execute("call-1", {
      tasks: [
        { to: "coder", content: "a" },
        { to: "reviewer", content: "b" },
      ],
      nextSteps: "无",
    });
    const text = result.content[0].text;

    expect(text).toContain('目标成员 "reviewer" 当前未在运行');
    expect(text).toContain('start_member("reviewer")');
    expect(messageQueue.enqueue).not.toHaveBeenCalled();
    expect(lastPendingCorrId.size).toBe(0);
  });

  it("句柄不存在（从未启动）→ 不拦截本层，保持既有派发行为", async () => {
    const send = register(() => undefined);

    await runWithSettledAllIdle(() =>
      send.execute("call-1", {
        tasks: [{ to: "coder", content: "a" }],
        nextSteps: "无",
      })
    );

    expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("句柄查询依赖未接线 → fail-open（旧行为不变）", async () => {
    const send = register(undefined);

    await runWithSettledAllIdle(() =>
      send.execute("call-1", {
        tasks: [{ to: "coder", content: "a" }],
        nextSteps: "无",
      })
    );

    expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("getState 抛错 → 视为未知，fail-open 放行", async () => {
    const broken = createHandle("coder", "running");
    broken.getState = vi.fn(() => {
      throw new Error("state unavailable");
    });
    const send = register(() => broken);

    await runWithSettledAllIdle(() =>
      send.execute("call-1", {
        tasks: [{ to: "coder", content: "a" }],
        nextSteps: "无",
      })
    );

    expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("目标运行中 → 照常入队（回归）", async () => {
    const send = register(() => createHandle("coder", "running"));

    await runWithSettledAllIdle(() =>
      send.execute("call-1", {
        tasks: [{ to: "coder", content: "a" }],
        nextSteps: "无",
      })
    );

    expect(messageQueue.enqueue).toHaveBeenCalledTimes(1);
  });
});
