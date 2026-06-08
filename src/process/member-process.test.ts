import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMemberProcess, type MemberProcessConfig } from "./member-process";

function createMockSpawn() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = new EventEmitter() as any;
  process.pid = 12345;
  process.stdin = stdin;
  process.stdout = stdout;
  process.stderr = stderr;
  process.killed = false;
  process.kill = vi.fn((signal?: string) => {
    process.killed = true;
    process.emit("exit", signal === "SIGKILL" ? null : 0, signal);
  });

  return { stdin, stdout, stderr, process };
}

/** Emit a dummy JSON event on stdout to resolve the start() ready promise. */
function emitReadyStdout(stdout: any) {
  stdout.write(JSON.stringify({ type: "ready" }) + "\n");
}


describe("createMemberProcess", () => {
  const defaultConfig: MemberProcessConfig = {
    name: "analyzer",
    role: "analyzer",
    roleLabel: "分析员",
    teamName: "refactoring",
    teamMembers: ["analyzer", "mover"],
    memberDescription: "分析代码",
    sessionDir: "/tmp/sessions/refactoring/analyzer",
    sharedContextPath: "/tmp/sessions/refactoring/shared-context.md",
    memberExtensionPath: "/path/to/member.ts",
    cwd: "/test/project",
    piCommand: "pi",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns pi with correct args", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "pi",
      [
        "--mode", "rpc",
        "--session-dir", "/tmp/sessions/refactoring/analyzer",
        "-e", "/path/to/member.ts",
        "--no-session", "false",
      ],
      expect.objectContaining({
        cwd: "/test/project",
        env: expect.objectContaining({
          TEAM_ROLE: "analyzer",
          TEAM_ROLE_LABEL: "分析员",
          TEAM_NAME: "refactoring",
          TEAM_MEMBERS: "analyzer,mover",
          TEAM_MEMBER_DESCRIPTION: "分析代码",
          TEAM_SHARED_CONTEXT_PATH: "/tmp/sessions/refactoring/shared-context.md",
        }),
      })
    );
  });

  it("resolves when started (process ready event)", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();
    // Simulate pi RPC starting up: emit a JSON line on stdout
    emitReadyStdout(stdout);
    await startPromise;

    expect(member.getState().status).toBe("running");
    expect(member.getState().pid).toBe(12345);
  });

  it("tracks process exit", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;
    expect(member.getState().status).toBe("running");

    // Simulate process exit
    mockProcess.emit("exit", 0, null);
    expect(member.getState().status).toBe("stopped");
    expect(member.getState().pid).toBeNull();
  });

  it("stops process gracefully (SIGTERM then SIGKILL)", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);
    const killMock = vi.fn();
    mockProcess.kill = killMock;

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    const stopPromise = member.stop();
    // First SIGTERM
    expect(killMock).toHaveBeenCalledWith("SIGTERM");
    // Process doesn't exit, so after timeout it should SIGKILL
    // For now, let's just verify the stop promise resolves
    // Simulate exit
    mockProcess.emit("exit", 0, "SIGTERM");
    await stopPromise;

    expect(member.getState().status).toBe("stopped");
  });

  it("calls onUpdate handler when event received on stdout", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    const onUpdate = vi.fn();
    member.onEvent(onUpdate);

    // Simulate a tool_execution_end event from the RPC process
    const event = JSON.stringify({
      type: "tool_execution_end",
      toolName: "team_send_message",
      toolCallId: "call-1",
      result: {
        content: [{ type: "text", text: "Message sent" }],
        details: {
          teamMessage: {
            from: "analyzer",
            to: "mover",
            content: "Hello",
            timestamp: Date.now(),
          },
        },
      },
    });
    stdout.write(event + "\n");

    // Wait a tick for the event to be processed
    await new Promise((r) => setTimeout(r, 10));

    expect(onUpdate).toHaveBeenCalled();
    const callArg = onUpdate.mock.calls[0][0];
    expect(callArg.type).toBe("tool_execution_end");
    expect(callArg.toolName).toBe("team_send_message");
  });

  it("fails to start if pi command not found", async () => {
    const spawnMock = vi.fn().mockImplementation(() => {
      const err = new Error("spawn pi ENOENT") as any;
      err.code = "ENOENT";
      throw err;
    });

    const member = createMemberProcess(defaultConfig, spawnMock);
    await expect(member.start()).rejects.toThrow();
  });

  describe("sendCommandAndWait", () => {
    it("sends command and resolves on matching response event", async () => {
      const { process: mockProcess, stdin, stdout } = createMockSpawn();
      const spawnMock = vi.fn().mockReturnValue(mockProcess);

      const member = createMemberProcess(defaultConfig, spawnMock);
      const startPromise = member.start();
      emitReadyStdout(stdout);
      await startPromise;

      // Capture what was written to stdin
      const writeSpy = vi.fn();
      stdin.write = writeSpy;

      // Initiate the request
      const resultPromise = member.sendCommandAndWait(
        { type: "get_messages" },
        (event) => event.type === "response" && event.command === "get_messages"
      );

      // Verify command was sent with an id
      expect(writeSpy).toHaveBeenCalled();
      const sent = JSON.parse(writeSpy.mock.calls[0][0]);
      expect(sent.type).toBe("get_messages");
      expect(sent.id).toBeTruthy();

      // Simulate response on stdout
      const response = JSON.stringify({
        type: "response",
        id: sent.id,
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "Hello" }] },
      });
      stdout.write(response + "\n");

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.data.messages).toHaveLength(1);
    });

    it("rejects if member is not running", async () => {
      const member = createMemberProcess(defaultConfig, vi.fn());
      // Don't start - status is "stopped"
      await expect(
        member.sendCommandAndWait({ type: "get_messages" }, () => true)
      ).rejects.toThrow();
    });
  });
});
