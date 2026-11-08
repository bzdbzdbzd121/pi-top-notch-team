/**
 * 阶段 4（方案 §3.4 / §5）：结果会话附注（一次 get_state 实测的七种事实分支）、
 * stop_member 条件提示、start_member 工具说明。
 *
 * 纪律（D6）：**只报事实**——启动前扫目录得到「有没有文件」，启动后问一次成员进程
 * 得到「实际承载多少条历史」；请求了续接但查不到就说「无法确认」，绝不在未验证时
 * 声称「已续接」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTlTools, resolveMemberSessionDir } from "./tl-tools";
import { buildMemberConfig } from "../setup/member-lifecycle";
import { startSession, endSession, markSharedContextWritten, getSessionState } from "../session/state";
import { resetSessionSettingsState } from "../settings/session-settings";
import { listMemberSessionFiles } from "../process/member-session";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { MemberOperationalState } from "../session/context";
import type { MemberProcessHandle } from "../process/member-process";

function createHandle(
  name: string,
  sendCommandAndWait: any = vi.fn().mockResolvedValue({})
): MemberProcessHandle {
  let state = { name, pid: 4321 as number | null, status: "stopped" as const };
  return {
    name,
    start: vi.fn(async () => {
      state = { ...state, status: "running" as any };
    }),
    stop: vi.fn(async () => {
      state = { name, pid: null, status: "stopped" };
    }),
    getState: vi.fn(() => ({ ...state })),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait,
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

function createMockMessageQueue(): MessageQueue {
  return {
    enqueue: vi.fn(),
    length: vi.fn().mockReturnValue(0),
    drain: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
}

describe("start_member 会话事实附注（阶段 4）", () => {
  let rootDir: string;
  let sessionDir: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "tl-restart-annotation-"));
    process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
    resetSessionSettingsState();
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "coder", systemPrompt: "write code" }],
    });
    markSharedContextWritten();
    sessionDir = join(
      rootDir,
      "sessions",
      "test-team",
      getSessionState().sessionId!,
      "coder"
    );
    mkdirSync(sessionDir, { recursive: true });
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

  function response(data: any, success = true) {
    return { type: "response", command: "get_state", success, data };
  }

  function register(options: { sendCommandAndWait?: any; handle?: MemberProcessHandle } = {}) {
    const tools = new Map<string, any>();
    const pi = {
      registerTool: vi.fn((def: any) => {
        tools.set(def.name, def);
      }),
    } as unknown as ExtensionAPI;
    const handle = options.handle ?? createHandle("coder", options.sendCommandAndWait);
    const createMember = vi.fn(() => handle);
    const buildMemberConfigFn = vi.fn().mockReturnValue({
      name: "coder",
      role: "coder",
      teamName: "test-team",
      sessionDir,
    });

    registerTlTools({
      pi,
      manager: createMockManager(),
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map<string, MemberOperationalState>(),
      lastPendingCorrId: new Map<string, string>(),
      messageQueue: createMockMessageQueue(),
      createMember,
      buildMemberConfig: buildMemberConfigFn,
    });

    return { tools, handle, createMember, startMember: tools.get("start_member"), stopMember: tools.get("stop_member") };
  }

  function writeSessionFile(name = "old.jsonl"): void {
    writeFileSync(join(sessionDir, name), "{}\n");
  }

  it("未 fresh + 有文件 + 查询到历史 → 「已续接此前的会话（历史 N 条消息）」+ details", async () => {
    writeSessionFile();
    const sendCommandAndWait = vi.fn().mockResolvedValue(response({ messageCount: 7, sessionId: "s1" }));
    const { startMember } = register({ sendCommandAndWait });

    const result = await startMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("会话：已续接此前的会话（历史 7 条消息）。");
    expect(text).toContain('需要丢弃上下文时用 start_member({name:"coder", fresh:true})。');
    expect(result.details).toMatchObject({
      sessionMode: "resumed",
      resumeRequested: true,
      messageCount: 7,
      archivedFiles: 0,
    });
    // 只问一次（一次 get_state 实测）
    expect(sendCommandAndWait).toHaveBeenCalledTimes(1);
    expect(sendCommandAndWait.mock.calls[0][0]).toEqual({ type: "get_state" });
  });

  it("未 fresh + 有文件 + 查询到 0 条 → 告警「未续接」，绝不出现「已续接」", async () => {
    writeSessionFile();
    const { startMember } = register({
      sendCommandAndWait: vi.fn().mockResolvedValue(response({ messageCount: 0 })),
    });

    const result = await startMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("⚠️ 会话：未续接（成员以全新会话启动）。");
    expect(text).toContain("旧上下文不可用，请重新交代必要背景。");
    expect(text).not.toContain("已续接");
    expect(result.details).toMatchObject({
      sessionMode: "new",
      resumeRequested: true,
      messageCount: 0,
    });
  });

  it("未 fresh + 有文件 + 查询失败/超时 → 「无法确认」，启动仍成功（fail-open）", async () => {
    writeSessionFile();
    const { startMember } = register({
      sendCommandAndWait: vi.fn().mockRejectedValue(new Error('Command to "coder" timed out after 3000ms')),
    });

    const result = await startMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("已启动");
    expect(text).toContain("会话：已请求续接此前的会话，但无法确认（成员未返回会话状态）。");
    expect(text).not.toContain("已续接此前的会话");
    expect(result.details).toMatchObject({ sessionMode: "unknown", resumeRequested: true });
  });

  it("未 fresh + 无文件 → 「此前没有可续接的历史」，且不查询成员状态", async () => {
    const sendCommandAndWait = vi.fn();
    const { startMember } = register({ sendCommandAndWait });

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(result.content[0].text).toContain("会话：全新会话（该成员此前没有可续接的历史）。");
    expect(sendCommandAndWait).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ sessionMode: "new", resumeRequested: false });
  });

  it("fresh → 不查询成员状态（不需要实测续接）", async () => {
    writeSessionFile();
    const sendCommandAndWait = vi.fn();
    const { startMember } = register({ sendCommandAndWait });

    const result = await startMember.execute("call-1", { name: "coder", fresh: true });

    expect(result.content[0].text).toContain("会话：全新会话");
    expect(sendCommandAndWait).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ sessionMode: "fresh", resumeRequested: false });
  });

  it("查询返回 success:false → 视为无法确认（不猜测）", async () => {
    writeSessionFile();
    const { startMember } = register({
      sendCommandAndWait: vi.fn().mockResolvedValue(response(undefined, false)),
    });

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(result.content[0].text).toContain("无法确认");
    expect(result.details.sessionMode).toBe("unknown");
  });
});

describe("stop_member 条件提示（阶段 4，§3.4.1 #5）", () => {
  let rootDir: string;
  let sessionDir: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "tl-stop-hint-"));
    process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
    resetSessionSettingsState();
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "coder", systemPrompt: "write code" }],
    });
    markSharedContextWritten();
    sessionDir = join(rootDir, "sessions", "test-team", getSessionState().sessionId!, "coder");
    mkdirSync(sessionDir, { recursive: true });
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

  function register() {
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
      memberOpsStates: new Map<string, MemberOperationalState>(),
      lastPendingCorrId: new Map<string, string>(),
      messageQueue: createMockMessageQueue(),
      createMember: vi.fn(() => createHandle("coder")),
      buildMemberConfig: vi.fn(),
    });
    return { stopMember: tools.get("stop_member"), startMember: tools.get("start_member") };
  }

  it("该成员有会话文件 → 追加「已保留」「fresh」提示（文件不动）", async () => {
    writeFileSync(join(sessionDir, "prev.jsonl"), "{}\n");
    const { stopMember } = register();

    const result = await stopMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain('成员 "coder" 已停止。');
    expect(text).toContain("已保留");
    expect(text).toContain("尝试续接");
    expect(text).toContain("见启动结果");
    expect(text).toContain("fresh");
    expect(existsSync(join(sessionDir, "prev.jsonl"))).toBe(true);
  });

  it("该成员没有会话文件 → 不出现「已保留」「fresh」（不对无历史的成员说假话）", async () => {
    const { stopMember } = register();

    const result = await stopMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("已停止");
    expect(text).not.toContain("已保留");
    expect(text).not.toContain("fresh");
  });

  it("成员会话目录推导与 buildMemberConfig 的 sessionDir 一致（布局锁）", () => {
    expect(resolveMemberSessionDir("coder")).toBe(sessionDir);
    const config = buildMemberConfig("coder", getSessionState(), { settings: undefined });
    expect(config?.sessionDir).toBe(resolveMemberSessionDir("coder"));
  });

  it("会话不活跃时推导返回 undefined（fail-open，不加提示）", () => {
    const dir = resolveMemberSessionDir("coder");
    expect(dir).toBe(sessionDir);
    endSession();
    expect(resolveMemberSessionDir("coder")).toBeUndefined();
  });
});

describe("start_member 工具说明（阶段 4，§3.4.1 #1）", () => {
  it("说明写明默认续接、fresh 归档、不回滚文件、不动共享上下文、已运行会被拒绝", () => {
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
      memberOpsStates: new Map<string, MemberOperationalState>(),
      lastPendingCorrId: new Map<string, string>(),
      messageQueue: createMockMessageQueue(),
      createMember: vi.fn(() => createHandle("coder")),
      buildMemberConfig: vi.fn(),
    });
    const def = tools.get("start_member");

    expect(def.description).toContain("ATTEMPTS to continue the member's previous session");
    expect(def.description).toContain("whether it actually resumed is reported in the start result");
    expect(def.description).toContain("fresh=true");
    expect(def.description).toContain("archived (recoverable, not deleted)");
    expect(def.description).toContain("does NOT revert files");
    expect(def.description).toContain("does NOT change the team shared context");
    expect(def.description).toContain("already running is refused");
    // 不再出现无条件的结果断言
    expect(def.description).not.toContain("CONTINUES the member's previous session");
    expect(def.parameters.properties.fresh.type).toBe("boolean");

    const guidelines = def.promptGuidelines.join("\n");
    expect(guidelines).toContain("Shared Context");
    expect(guidelines).toContain("attempts to continue its context by default");
    expect(guidelines).toContain("the start result reports whether it actually resumed");
    expect(guidelines).toContain("fresh=true only when");
    expect(guidelines).toContain("already-running member is refused");
    expect(guidelines).not.toContain("keeps its context by default");
  });
});
