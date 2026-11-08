/**
 * 阶段 2（方案 §3.2 / §5）：start_member 的 fresh 参数、归档调用与结果文案。
 *
 * 顺序硬约束（方案 §3.2.1 / E1-E3）：重复启动守卫 → 共享上下文门控 → 构建配置
 * （含 fresh）→ 归档（同步，启动前快照）→ 创建并启动。归档必须同步且先于启动；
 * 未传 fresh 时行为与改造前逐字节一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTlTools } from "./tl-tools";
import { archiveMemberSessionFiles, listMemberSessionFiles } from "../process/member-session";
import { startSession, endSession, markSharedContextWritten } from "../session/state";
import { resetSessionSettingsState } from "../settings/session-settings";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { MemberOperationalState } from "../session/context";
import type { MemberProcessHandle } from "../process/member-process";

function createHandle(name: string): MemberProcessHandle {
  let state = { name, pid: 4321 as number | null, status: "stopped" as const };
  const handle: MemberProcessHandle = {
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
    sendCommandAndWait: vi.fn().mockResolvedValue({}),
  };
  return handle;
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

describe("start_member fresh（阶段 2）", () => {
  let rootDir: string;
  let sessionDir: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "tl-start-fresh-"));
    process.env.TOP_NOTCH_TEAM_ROOT = rootDir;
    sessionDir = join(rootDir, "sessions", "test-team", "sid", "coder");
    mkdirSync(sessionDir, { recursive: true });
    resetSessionSettingsState();
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "coder", systemPrompt: "write code" }],
    });
    markSharedContextWritten();
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

  function register(options: {
    archive?: any;
    buildMemberConfig?: any;
    createMember?: any;
    getHandle?: any;
  } = {}) {
    const tools = new Map<string, any>();
    const pi = {
      registerTool: vi.fn((def: any) => {
        tools.set(def.name, def);
      }),
    } as unknown as ExtensionAPI;
    const buildMemberConfig =
      options.buildMemberConfig ??
      vi.fn().mockReturnValue({
        name: "coder",
        role: "coder",
        teamName: "test-team",
        sessionDir,
      });
    const archive = options.archive ?? vi.fn(archiveMemberSessionFiles);
    const createMember = options.createMember ?? vi.fn(() => createHandle("coder"));

    registerTlTools({
      pi,
      manager: createMockManager(),
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: new Map<string, MemberOperationalState>(),
      lastPendingCorrId: new Map<string, string>(),
      messageQueue: createMockMessageQueue(),
      createMember,
      buildMemberConfig,
      archiveMemberSessionFiles: archive,
      getHandle: options.getHandle,
    });

    return { buildMemberConfig, archive, createMember, startMember: tools.get("start_member") };
  }

  it("fresh:true + 有历史 → 归档一次（启动前快照）、配置收到 fresh、结果与 details 一致", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const { buildMemberConfig, archive, startMember } = register();

    const result = await startMember.execute("call-1", { name: "coder", fresh: true });
    const text = result.content[0].text;

    expect(buildMemberConfig).toHaveBeenCalledWith("coder", { fresh: true });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive.mock.calls[0][0]).toMatchObject({
      sessionDir,
      memberName: "coder",
      files: [{ relativePath: "old.jsonl", path: join(sessionDir, "old.jsonl") }],
    });

    expect(text).toContain("全新会话");
    expect(text).toContain("已归档 1 个旧会话文件");
    expect(text).toContain("可手工移回恢复；可随时用 /team clean 清理");
    expect(text).toContain("该成员不记得此前的对话，且它已改写的文件不会回滚。");

    expect(result.details).toMatchObject({
      sessionMode: "fresh",
      resumeRequested: false,
      archivedFiles: 1,
      memberArchiveCount: 1,
    });
    expect(typeof result.details.archiveDir).toBe("string");
    // 真实归档已执行：成员会话目录内不再有 .jsonl
    expect(listMemberSessionFiles(sessionDir)).toEqual([]);
  });

  it("fresh:true + 无历史 → 文案「此前没有可续接的历史」，不创建归档目录、不调用归档", async () => {
    const { archive, startMember } = register();

    const result = await startMember.execute("call-1", { name: "coder", fresh: true });

    expect(archive).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("全新会话");
    expect(result.content[0].text).toContain("此前没有可续接的历史");
    // 无历史分支没有「丢弃了上下文」可讲（§3.4.2 表）：不输出不记得/不回滚句
    expect(result.content[0].text).not.toContain("不记得此前的对话");
    expect(result.details).toMatchObject({ sessionMode: "fresh", archivedFiles: 0 });
    expect(existsSync(join(rootDir, "sessions", "test-team", "sid", ".member-resets"))).toBe(false);
  });

  it("fresh:true + 归档失败 → 仍启动成功，文案含失败数、原因、残留风险与旧文件位置", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const archive = vi.fn().mockReturnValue({
      archiveDir: join(rootDir, "sessions", "test-team", "sid", ".member-resets", "coder", "20261108-103000"),
      moved: [],
      failed: [{ relativePath: "old.jsonl", reason: "EACCES: permission denied" }],
      memberArchiveCount: 1,
      memberArchiveBytes: 0,
    });
    const { createMember, startMember } = register({ archive });

    const result = await startMember.execute("call-1", { name: "coder", fresh: true });
    const text = result.content[0].text;

    expect(createMember).toHaveBeenCalledTimes(1);
    expect(text).toContain("已启动");
    expect(text).toContain("未能归档");
    expect(text).toContain("EACCES: permission denied");
    expect(text).toContain("旧文件仍在");
    expect(text).toContain(sessionDir);
    expect(text).toContain("下次启动可能续接旧会话");
    expect(result.details.archiveFailures).toBe(1);
    expect(result.details.archivedFiles).toBe(0);
  });

  it("累计 ≥2 时附带数量与大小；累计 =1 时无「累计」句但仍有 /team clean 提示", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");

    const cumulative = vi.fn().mockReturnValue({
      archiveDir: join(rootDir, "sessions", "test-team", "sid", ".member-resets", "coder", "20261108-103000"),
      moved: ["old.jsonl"],
      failed: [],
      memberArchiveCount: 2,
      memberArchiveBytes: 5120,
    });
    const withTwo = register({ archive: cumulative });
    const first = await withTwo.startMember.execute("call-1", { name: "coder", fresh: true });
    expect(first.content[0].text).toContain("该成员累计 2 个归档，合计 5.0 KB。");
    expect(first.content[0].text).toContain("该成员不记得此前的对话，且它已改写的文件不会回滚。");
    expect(first.details).toMatchObject({ memberArchiveCount: 2, memberArchiveBytes: 5120 });

    const single = vi.fn().mockReturnValue({
      archiveDir: join(rootDir, "sessions", "test-team", "sid", ".member-resets", "coder", "20261108-103000"),
      moved: ["old.jsonl"],
      failed: [],
      memberArchiveCount: 1,
      memberArchiveBytes: 5,
    });
    const withOne = register({ archive: single });
    const second = await withOne.startMember.execute("call-1", { name: "coder", fresh: true });
    expect(second.content[0].text).not.toContain("累计");
    expect(second.content[0].text).toContain("/team clean");
  });

  it("fresh 归一化：只认 true / \"true\"；false / null / 缺省一律视为未请求", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");

    const truthy = register();
    await truthy.startMember.execute("call-1", { name: "coder", fresh: "true" });
    expect(truthy.buildMemberConfig).toHaveBeenCalledWith("coder", { fresh: true });
    expect(truthy.archive).toHaveBeenCalledTimes(1);

    for (const raw of [false, null, undefined]) {
      writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
      const falsy = register();
      await falsy.startMember.execute("call-1", { name: "coder", fresh: raw });
      expect(falsy.buildMemberConfig).toHaveBeenCalledWith("coder", { fresh: false });
      expect(falsy.archive).not.toHaveBeenCalled();
      expect(falsy.createMember).toHaveBeenCalledTimes(1);
    }
  });

  it("未传 fresh → 归档不调用，结果文案与改造前逐字节一致", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const { archive, buildMemberConfig, startMember } = register();

    const result = await startMember.execute("call-1", { name: "coder" });

    expect(buildMemberConfig).toHaveBeenCalledWith("coder", { fresh: false });
    expect(archive).not.toHaveBeenCalled();
    expect(result.details).toEqual({});
    expect(result.content[0].text).toBe(
      '成员 "coder" 已启动 (PID: 4321)。模型：默认；思考强度：默认。' +
        "使用 list_members 查看状态，通过消息通道分配任务。"
    );
  });

  it("fresh + 成员在运行 → 命中重复启动守卫，归档与创建均不被调用（验收 5 / E1）", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const running = createHandle("coder");
    running.getState = vi.fn(() => ({
      name: "coder",
      pid: 999,
      status: "running" as any,
    }));
    const { archive, createMember, startMember } = register({ getHandle: () => running });

    const result = await startMember.execute("call-1", { name: "coder", fresh: true });

    expect(result.content[0].text).toContain("已在运行");
    expect(archive).not.toHaveBeenCalled();
    expect(createMember).not.toHaveBeenCalled();
    // 绝不归档一个可能仍在写的目录
    expect(existsSync(join(sessionDir, "old.jsonl"))).toBe(true);
  });

  it("归档成功但启动失败 → 返回启动失败原文，并附归档路径（可手工移回，§3.2.4）", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const createMember = vi.fn(() => {
      const handle = createHandle("coder");
      handle.start = vi.fn().mockRejectedValue(new Error("spawn pi ENOENT"));
      return handle;
    });
    const { startMember } = register({ createMember });

    const result = await startMember.execute("call-1", { name: "coder", fresh: true });
    const text = result.content[0].text;

    // 启动失败原文照旧披露
    expect(text).toContain('成员 "coder" 启动失败');
    expect(text).toContain("spawn pi ENOENT");
    // 归档已发生，必须披露路径与「可手工移回」
    expect(text).toContain("已归档 1 个");
    expect(text).toContain(".member-resets");
    expect(text).toContain("可手工移回");
    expect(text).toContain(sessionDir);
    // 归档确实执行了（旧文件已离开成员会话目录）
    expect(listMemberSessionFiles(sessionDir)).toEqual([]);
  });

  it("未归档（非 fresh）启动失败 → 不附归档信息（回归）", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const createMember = vi.fn(() => {
      const handle = createHandle("coder");
      handle.start = vi.fn().mockRejectedValue(new Error("spawn pi ENOENT"));
      return handle;
    });
    const { startMember } = register({ createMember });

    const result = await startMember.execute("call-1", { name: "coder" });
    const text = result.content[0].text;

    expect(text).toContain("启动失败");
    expect(text).not.toContain("已归档");
    expect(text).not.toContain("可手工移回");
  });

  it("归档先于启动（E2）：归档完成时进程尚未创建", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const order: string[] = [];
    const archive = vi.fn((params: any) => {
      order.push("archive");
      return archiveMemberSessionFiles(params);
    });
    const createMember = vi.fn((config: any) => {
      order.push("create");
      return createHandle("coder");
    });
    const { startMember } = register({ archive, createMember });

    await startMember.execute("call-1", { name: "coder", fresh: true });

    expect(order).toEqual(["archive", "create"]);
  });

  it("归档同步执行后配置不再续接（fresh 与自动探测的优先级由配置层锁定）", async () => {
    writeFileSync(join(sessionDir, "old.jsonl"), "{}\n");
    const { buildMemberConfig, startMember } = register({ archive: vi.fn(archiveMemberSessionFiles) });

    await startMember.execute("call-1", { name: "coder", fresh: true });

    // 工具层只负责把 fresh 传给配置层；续接判定由 member-lifecycle 保证
    expect(buildMemberConfig).toHaveBeenCalledWith("coder", { fresh: true });
  });
});
