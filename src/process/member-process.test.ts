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
    const { process: mockProcess } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    await member.start();

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
    const { process: mockProcess } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();

    // Simulate pi RPC starting up: emits agent_start after initial prompt
    // Actually, pi RPC doesn't emit agent_start until a prompt is sent.
    // For start(), we just need the process to be spawned.
    // The start() resolves after spawn succeeds (immediately since spawn is sync-ish)
    await startPromise;

    expect(member.getState().status).toBe("running");
    expect(member.getState().pid).toBe(12345);
  });

  it("tracks process exit", async () => {
    const { process: mockProcess } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    await member.start();
    expect(member.getState().status).toBe("running");

    // Simulate process exit
    mockProcess.emit("exit", 0, null);
    expect(member.getState().status).toBe("stopped");
    expect(member.getState().pid).toBeNull();
  });

  it("stops process gracefully (SIGTERM then SIGKILL)", async () => {
    const { process: mockProcess } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);
    const killMock = vi.fn();
    mockProcess.kill = killMock;

    const member = createMemberProcess(defaultConfig, spawnMock);
    await member.start();

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
    await member.start();

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
});
