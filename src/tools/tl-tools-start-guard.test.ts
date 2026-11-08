/**
 * 阶段 1（方案 §3.1）：start_member 的重复启动保护。
 *
 * 判定只看进程句柄自己的状态（不看成员操作状态表、不看进程管理器状态）：
 *   running            → 拒绝（附 PID + 三条出路，零副作用）
 *   stopped + PID 非空 → 拒绝（正在停止中：已置停止态、进程仍在退出）
 *   其余（stopped+PID 空 / error / idle / 无句柄 / 未接线查询）→ 放行
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTlTools } from "./tl-tools";
import { startSession, endSession, markSharedContextWritten } from "../session/state";
import { resetSessionSettingsState } from "../settings/session-settings";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { MemberOperationalState } from "../session/context";
import type { MemberProcessHandle, MemberStatus } from "../process/member-process";

/**
 * 有状态句柄替身：忠实复刻 member-process 的同步前缀——start() 在第一个
 * await 之前就把状态置为 running。守卫的并发安全正是靠这个同步段。
 */
function createHandle(
  name: string,
  initial: { status: MemberStatus; pid: number | null }
): MemberProcessHandle {
  let state = { name, ...initial };
  return {
    name,
    start: vi.fn(async () => {
      state = { name, pid: state.pid ?? 4321, status: "running" };
    }),
    stop: vi.fn(async () => {
      state = { name, pid: null, status: "stopped" };
    }),
    getState: vi.fn(() => ({ ...state })),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn().mockResolvedValue({}),
  };
}

interface HarnessOptions {
  getHandle?: (name: string) => MemberProcessHandle | undefined;
  buildMemberConfig?: any;
  createMember?: any;
  onDynamicPhaseTransition?: () => void;
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

function createMockMessageQueue(): MessageQueue {
  return {
    enqueue: vi.fn(),
    length: vi.fn().mockReturnValue(0),
    drain: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
}

describe("start_member 重复启动保护（阶段 1）", () => {
  let rootDir: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "tl-start-guard-"));
    process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
    resetSessionSettingsState();
    endSession();
  });

  afterEach(() => {
    endSession();
    rmSync(rootDir, { recursive: true, force: true });
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  });

  /** Active session with the shared-context gate open (otherwise start is gated). */
  function openGate(): void {
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "coder", systemPrompt: "write code" }],
    });
    markSharedContextWritten();
  }

  function register(options: HarnessOptions = {}) {
    const tools = new Map<string, any>();
    const pi = {
      registerTool: vi.fn((def: any) => {
        tools.set(def.name, def);
      }),
    } as unknown as ExtensionAPI;
    const buildMemberConfig =
      options.buildMemberConfig ??
      vi.fn().mockReturnValue({ name: "coder", role: "coder", teamName: "test-team" });
    const createMember = options.createMember ?? vi.fn(() => createHandle("coder", { status: "stopped", pid: null }));

    registerTlTools({
      pi,
      manager: createMockManager(),
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map<string, MemberOperationalState>(),
      lastPendingCorrId: new Map<string, string>(),
      messageQueue: createMockMessageQueue(),
      createMember,
      buildMemberConfig,
      getHandle: options.getHandle,
      onDynamicPhaseTransition: options.onDynamicPhaseTransition,
    });

    return { tools, buildMemberConfig, createMember, startMember: tools.get("start_member") };
  }

  it("句柄 running → 拒绝启动，文案含「已在运行」「PID」与三条出路", async () => {
    openGate();
    const running = createHandle("coder", { status: "running", pid: 1234 });
    const phaseTransition = vi.fn();
    const { buildMemberConfig, createMember, startMember } = register({
      getHandle: () => running,
      onDynamicPhaseTransition: phaseTransition,
    });

    const result = await startMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("已在运行");
    expect(text).toContain("PID: 1234");
    expect(text).toContain("本次未重复启动");
    expect(text).toContain("team_send_and_wait");
    expect(text).toContain("stop_member");
    expect(text).toContain("fresh");

    // 零副作用：不读配置（不建目录）、不建进程、不触发阶段切换
    expect(buildMemberConfig).not.toHaveBeenCalled();
    expect(createMember).not.toHaveBeenCalled();
    expect(phaseTransition).not.toHaveBeenCalled();
  });

  it("句柄 stopped + PID 非空（正在停止中）→ 拒绝启动并提示稍后重试", async () => {
    openGate();
    const stopping = createHandle("coder", { status: "stopped", pid: 4321 });
    const { buildMemberConfig, createMember, startMember } = register({ getHandle: () => stopping });

    const result = await startMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("正在停止中");
    expect(text).toContain("PID: 4321");
    expect(text).toContain("stop_member");
    expect(buildMemberConfig).not.toHaveBeenCalled();
    expect(createMember).not.toHaveBeenCalled();
  });

  it.each([
    ["stopped + PID 空（已停/已崩溃）", () => createHandle("coder", { status: "stopped", pid: null })],
    ["error（启动失败过）", () => createHandle("coder", { status: "error", pid: null })],
  ])("句柄 %s → 放行（既有恢复路径）", async (_label, makeHandle) => {
    openGate();
    const { createMember, startMember } = register({ getHandle: () => makeHandle() });

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(result.content[0].text).toContain("已启动");
    expect(createMember).toHaveBeenCalledTimes(1);
  });

  it("无同名句柄 → 放行", async () => {
    openGate();
    const { createMember, startMember } = register({ getHandle: () => undefined });

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(result.content[0].text).toContain("已启动");
    expect(createMember).toHaveBeenCalledTimes(1);
  });

  it("句柄查询依赖未接线（最小装配/老测试）→ fail-open 不阻断", async () => {
    openGate();
    const { createMember, startMember } = register();

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(result.content[0].text).toContain("已启动");
    expect(createMember).toHaveBeenCalledTimes(1);
  });

  it("getState 抛错 → fail-open（守卫不成为新的启动失败源）", async () => {
    openGate();
    const broken = createHandle("coder", { status: "running", pid: 1 });
    broken.getState = vi.fn(() => {
      throw new Error("state unavailable");
    });
    const { createMember, startMember } = register({ getHandle: () => broken });

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(result.content[0].text).toContain("已启动");
    expect(createMember).toHaveBeenCalledTimes(1);
  });

  it("守卫早于共享上下文门控：未写共享上下文 + 运行中 → 返回「已在运行」而不是「请先写共享上下文」", async () => {
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "coder", systemPrompt: "write code" }],
    });
    // 刻意不写共享上下文
    const running = createHandle("coder", { status: "running", pid: 1234 });
    const { buildMemberConfig, createMember, startMember } = register({ getHandle: () => running });

    const result = await startMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("已在运行");
    expect(text).not.toContain("共享上下文尚未写入");
    expect(buildMemberConfig).not.toHaveBeenCalled();
    expect(createMember).not.toHaveBeenCalled();
  });

  it("共享上下文门控语义不变：无运行中句柄 + 未写共享上下文 → 仍被门控（回归）", async () => {
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "coder", systemPrompt: "write code" }],
    });
    const { createMember, startMember } = register({ getHandle: () => undefined });

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(result.content[0].text).toContain("共享上下文尚未写入");
    expect(createMember).not.toHaveBeenCalled();
  });

  it("一条消息里的两次并行 start_member → 只创建一次进程，第二次返回「已在运行」", async () => {
    openGate();
    // 忠实复刻 index.ts 的 createMember 接线：句柄在 start() 之前就登记，
    // 第二个并行调用因此必然看到 running（member-process 的同步前缀）。
    const handles = new Map<string, MemberProcessHandle>();
    const createMember = vi.fn(() => {
      const handle = createHandle("coder", { status: "stopped", pid: null });
      handles.set("coder", handle);
      return handle;
    });
    const { startMember } = register({ getHandle: (name) => handles.get(name), createMember });

    const first = startMember.execute("call-1", { name: "coder" });
    const second = startMember.execute("call-2", { name: "coder" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(createMember).toHaveBeenCalledTimes(1);
    expect(firstResult.content[0].text).toContain("已启动");
    expect(secondResult.content[0].text).toContain("已在运行");
    expect(handles.get("coder")!.getState().status).toBe("running");
  });

  it("工具数量不变：仍是 6 个（本阶段不新增工具）", () => {
    openGate();
    const { tools } = register();
    expect(tools.size).toBe(6);
  });
});
