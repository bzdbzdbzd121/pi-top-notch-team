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

  it("samples compaction edges without duplicating the heartbeat lifecycle", async () => {
    await open();
    deps.memberOpsStates.set("coder", "compacting");
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "compaction_end" });
    emit({ type: "agent_end" });
    const kinds = deps.getRecentActions?.("coder").map(action => action.kind);
    expect(kinds).toEqual(["compacting"]);
    expect(deps.getRecentActions?.("coder")[0].status).toBe("done");
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
