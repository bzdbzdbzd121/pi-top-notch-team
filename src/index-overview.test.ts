import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockContext } from "./test/fixtures/mock-extension-api";
import type { MemberInspectorDeps } from "./ui/member-inspector";

const { createProcess } = vi.hoisted(() => ({ createProcess: vi.fn() }));
vi.mock("./process/member-process", () => ({
  createMemberProcess: (...args: any[]) => createProcess(...args),
  hasSessionFiles: () => false,
}));

describe("index overview session wiring", () => {
  let root: string;
  let pi: any;
  let ctx: ReturnType<typeof createMockContext>;
  let command: any;
  let deps: MemberInspectorDeps;
  let emit: (event: any) => void;
  let observer: ReturnType<typeof vi.fn>;

  const tool = (name: string) => pi.registerTool.mock.calls.find(([def]: any[]) => def.name === name)![0];
  const handler = (name: string) => pi.on.mock.calls.find(([event]: any[]) => event === name)![1];
  const open = () => pi.registerShortcut.mock.calls.find(([key]: any[]) => key === "alt+t")![1].handler(ctx);

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    root = mkdtempSync(join(tmpdir(), "index-overview-"));
    process.env.TOP_NOTCH_TEAM_ROOT = root;
    const tools: any[] = [];
    pi = {
      registerShortcut: vi.fn(), registerCommand: vi.fn(),
      registerTool: vi.fn((def: any) => tools.push(def)), on: vi.fn(),
      getAllTools: () => tools, getActiveTools: () => tools.map(def => def.name),
      setActiveTools: vi.fn(), sendMessage: vi.fn(), sendUserMessage: vi.fn(),
    };
    ctx = createMockContext();
    observer = vi.fn();
    const inspector = await import("./ui/member-inspector");
    vi.spyOn(inspector, "openMemberInspector").mockImplementation((_ctx, injected) => {
      deps = injected;
      return { close: vi.fn(), isOpen: () => false, markDirty: vi.fn(), onMemberEvent: observer };
    });
    const extension = await import("../index");
    extension.default(pi);
    command = pi.registerCommand.mock.calls.find(([name]: any[]) => name === "team")![1];
    await command.handler("dynamic", ctx);
    await tool("add_dynamic_member").execute("add", { name: "coder", label: "开发员", systemPrompt: "实现授权任务" });
    await tool("write_shared_context").execute("context", { content: "# 总览接线测试" });
    createProcess.mockReset();
    createProcess.mockImplementation(() => ({
      name: "coder", start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
      getState: () => ({ name: "coder", pid: 12345, status: "running" }),
      onEvent: vi.fn((callback: (event: any) => void) => { emit = callback; }),
      sendCommand: vi.fn(), sendCommandAndWait: vi.fn().mockResolvedValue({}),
    }));
    await tool("start_member").execute("start", { name: "coder" });
  });

  afterEach(async () => {
    await handler("session_shutdown")({ type: "session_shutdown" });
    vi.restoreAllMocks();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it("collects bounded semantic actions before first open and while closed", async () => {
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    for (let i = 0; i < 1000; i++) emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x" } });
    emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read" });
    emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {} });
    emit({ type: "agent_end" });
    await open();
    expect(deps.getRecentActions?.("coder").map(action => action.kind)).toEqual(["thinking", "read", "complete"]);
    expect(deps.getActivity?.("coder")?.phase).toBe("idle");
    expect(deps.getStartedMembers?.()).toContain("coder");
    emit({ type: "agent_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    await open();
    expect(deps.getRecentActions?.("coder").at(-1)?.kind).toBe("output");
    expect(deps.getActivity?.("coder")?.phase).toBe("output");
  });

  it("exposes cumulative per-member action totals beyond the retained history", async () => {
    emit({ type: "agent_start" });
    for (let i = 0; i < 100; i++) {
      emit({ type: "tool_execution_start", toolCallId: `read-${i}`, toolName: "read" });
      emit({ type: "tool_execution_end", toolCallId: `read-${i}`, toolName: "read" });
    }
    await open();
    expect(deps.getRecentActions?.("coder")).toHaveLength(64);
    expect(deps.getActionCount?.("coder")).toBe(100);
    await open();
    expect(deps.getActionCount?.("coder")).toBe(100);
    await command.handler("stop", ctx);
    expect(deps.getActionCount?.("coder")).toBe(0);
  });

  it.each([100, 600000])("distinguishes stats preflight from real compaction at %i tokens", async (tokens) => {
    vi.useFakeTimers();
    try {
      const { setSessionSetting } = await import("./settings/session-settings");
      setSessionSetting("autoCompact", { enabled: true, thresholdTokens: 524288, timeoutMinutes: 30 });
      await open();
      const handle = createProcess.mock.results.at(-1)!.value;
      const preflightStates: string[] = [];
      const displayCompacting: (boolean | undefined)[] = [];
      const confirmedStates: (boolean | undefined)[] = [];
      handle.sendCommandAndWait.mockImplementation(async (command: any) => {
        if (command.type === "compact") {
          emit({ type: "compaction_start", reason: "manual" });
          confirmedStates.push(deps.isCompacting?.("coder"));
          emit({ type: "compaction_end", reason: "manual", result: { summary: "compacted", firstKeptEntryId: "kept", tokensBefore: tokens }, aborted: false });
          confirmedStates.push(deps.isCompacting?.("coder"));
          const response = { type: "response", command: "compact", success: true };
          emit(response);
          return response;
        }
        if (command.type !== "get_session_stats") return {};
        preflightStates.push(deps.memberOpsStates.get("coder")!);
        const response = { type: "response", command: "get_session_stats", success: true, data: { contextUsage: { percent: 1, tokens } } };
        // The real RPC observer sees this before the await resolves and before
        // the dispatch path releases its temporary compacting reservation.
        emit(response);
        displayCompacting.push(deps.isCompacting?.("coder"));
        return response;
      });
      handle.sendCommand.mockImplementation((command: any) => {
        if (command.type !== "prompt") return;
        emit({ type: "agent_start" });
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
        emit({ type: "agent_end", messages: [] });
      });
      const pending = tool("team_send_and_wait").execute("dispatch", { tasks: [{ to: "coder", content: "目标：检查。非目标：修改。范围：只读。验收：返回结果。" }], nextSteps: "检查总览历史" });
      await vi.advanceTimersByTimeAsync(15000);
      await pending;
      expect(preflightStates).toEqual(["compacting"]); // Preserve the scheduling lock.
      expect(displayCompacting).toEqual([false]);
      const shouldCompact = tokens >= 524288;
      expect(handle.sendCommandAndWait.mock.calls.filter(([command]: any[]) => command.type === "compact")).toHaveLength(shouldCompact ? 1 : 0);
      expect(confirmedStates).toEqual(shouldCompact ? [true, false] : []);
      expect(deps.getRecentActions?.("coder").map(action => action.kind)).toEqual(shouldCompact ? ["compacting", "thinking", "complete"] : ["thinking", "complete"]);
      expect(deps.isCompacting?.("coder")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not prepend a compaction to a fresh member's real first operation", async () => {
    await open();
    expect(deps.memberOpsStates.get("coder")).toBe("idle");
    expect(deps.getRecentActions?.("coder")).toEqual([]);
    emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, errorMessage: "Nothing to compact" });
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    emit({ type: "tool_execution_start", toolCallId: "first-read", toolName: "read" });
    expect(deps.getRecentActions?.("coder").map(action => action.kind)).toEqual(["thinking", "read"]);
  });

  it("updates tracker and actions before notifying an observer that throws", async () => {
    await open();
    let activitySeen = "";
    observer.mockImplementation(() => {
      activitySeen = deps.getActivity?.("coder")?.phase ?? "";
      throw new Error("inspector gone");
    });
    emit({ type: "agent_start" });
    emit({ type: "tool_execution_start", toolCallId: "read-2", toolName: "read" });
    expect(activitySeen).toBe("executing");
    expect(deps.getRecentActions?.("coder").at(-1)?.kind).toBe("read");
    expect(deps.memberOpsStates.get("coder")).toBe("working");
    emit({ type: "process_exit", exitCode: 143, wasRunning: false });
    expect(deps.getActivity?.("coder")).toBeUndefined();
    expect(deps.getRecentActions?.("coder").at(-1)?.kind).toBe("stopped");
  });

  it("records real compaction events without interpreting the preflight lock as a start", async () => {
    await open();
    deps.memberOpsStates.set("coder", "compacting");
    expect(deps.getRecentActions?.("coder")).toEqual([]);
    expect(deps.isCompacting?.("coder")).toBe(false);
    emit({ type: "compaction_start", reason: "manual" });
    expect(deps.isCompacting?.("coder")).toBe(true);
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "compaction_end" });
    emit({ type: "agent_end" });
    const kinds = deps.getRecentActions?.("coder").map(action => action.kind);
    expect(kinds).toEqual(["compacting"]);
    expect(deps.getRecentActions?.("coder")[0].status).toBe("done");
    expect(deps.isCompacting?.("coder")).toBe(false);
  });

  it("records compaction and another stop after restarting without an agent turn", async () => {
    emit({ type: "process_exit", exitCode: 143, wasRunning: false });
    await tool("start_member").execute("restart", { name: "coder" });
    emit({ type: "compaction_start" });
    emit({ type: "compaction_end" });
    emit({ type: "process_exit", exitCode: 143, wasRunning: false });
    await open();
    expect(deps.getRecentActions?.("coder").map(action => action.kind)).toEqual(["stopped", "compacting", "stopped"]);
  });

  it("resets the display gate when the manager restarts the same handle", async () => {
    emit({ type: "process_exit", exitCode: 143, wasRunning: false });
    const handle = createProcess.mock.results.at(-1)!.value;
    handle.getState = () => ({ name: "coder", status: "stopped", pid: null });
    await handle.start();
    emit({ type: "compaction_start" });
    emit({ type: "compaction_end" });
    emit({ type: "process_exit", exitCode: 143, wasRunning: false });
    await open();
    expect(deps.getRecentActions?.("coder").map(action => action.kind)).toEqual(["stopped", "compacting", "stopped"]);
  });

  it("rejects callbacks from an older team session or a replaced member handle", async () => {
    const oldEmit = emit;
    await tool("start_member").execute("replace", { name: "coder" });
    await open();
    oldEmit({ type: "agent_start" });
    oldEmit({ type: "tool_execution_start", toolCallId: "old-handle", toolName: "read" });
    expect(deps.getRecentActions?.("coder")).toEqual([]);
    const previousSessionEmit = emit;
    await handler("session_shutdown")({ type: "session_shutdown" });
    await command.handler("dynamic", ctx);
    await tool("add_dynamic_member").execute("add-new", { name: "coder", label: "新开发员", systemPrompt: "新任务" });
    await open();
    previousSessionEmit({ type: "agent_start" });
    previousSessionEmit({ type: "tool_execution_start", toolCallId: "old-session", toolName: "read" });
    expect(deps.getRecentActions?.("coder")).toEqual([]);
    expect(deps.getStartedMembers?.()).toEqual([]);
    expect(deps.getActivity?.("coder")).toBeUndefined();
  });

  it("preserves actions across a turn boundary but clears on team stop and shutdown", async () => {
    emit({ type: "agent_start" });
    emit({ type: "tool_execution_start", toolCallId: "read-3", toolName: "read" });
    await open();
    await handler("before_agent_start")({ prompt: "继续", systemPrompt: "base" }, ctx);
    expect(deps.getRecentActions?.("coder")).toHaveLength(1);
    await command.handler("stop", ctx);
    expect(deps.getRecentActions?.("coder")).toEqual([]);
    expect(deps.getStartedMembers?.()).toEqual([]);
    // Late events from a stopped team must not recreate the old store.
    emit({ type: "agent_start" });
    expect(deps.getRecentActions?.("coder")).toEqual([]);
  });
});
