import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemberProcess, hasSessionFiles, MAX_COMMAND_SIZE, MAX_PENDING_WRITES, type MemberProcessConfig } from "./member-process";

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
      ],
      expect.objectContaining({
        cwd: "/test/project",
        env: expect.objectContaining({
          TEAM_ROLE: "analyzer",
          TEAM_ROLE_LABEL: "分析员",
          TEAM_NAME: "refactoring",
          TEAM_MEMBERS: '["analyzer","mover"]',
          TEAM_MEMBER_DESCRIPTION: "分析代码",
          TEAM_SHARED_CONTEXT_PATH: "/tmp/sessions/refactoring/shared-context.md",
        }),
      })
    );
  });

  it("spawns pi with --model when config.model is set", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(
      { ...defaultConfig, model: "anthropic/claude-sonnet-4-5" },
      spawnMock
    );
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "pi",
      [
        "--mode", "rpc",
        "--session-dir", "/tmp/sessions/refactoring/analyzer",
        "-e", "/path/to/member.ts",
        "--model", "anthropic/claude-sonnet-4-5",
      ],
      expect.objectContaining({ cwd: "/test/project" })
    );
  });

  it("spawns pi with --thinking when config.thinking is set (alone and with --model)", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(
      { ...defaultConfig, model: "anthropic/claude-sonnet-4-5", thinking: "high" },
      spawnMock
    );
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "pi",
      [
        "--mode", "rpc",
        "--session-dir", "/tmp/sessions/refactoring/analyzer",
        "-e", "/path/to/member.ts",
        "--model", "anthropic/claude-sonnet-4-5",
        "--thinking", "high",
      ],
      expect.objectContaining({ cwd: "/test/project" })
    );

    // thinking alone (no model override)
    const { process: p2, stdout: s2 } = createMockSpawn();
    const spawnMock2 = vi.fn().mockReturnValue(p2);
    const member2 = createMemberProcess({ ...defaultConfig, thinking: "off" }, spawnMock2);
    const startPromise2 = member2.start();
    emitReadyStdout(s2);
    await startPromise2;

    const args2 = spawnMock2.mock.calls[0][1] as string[];
    expect(args2).toContain("--thinking");
    expect(args2[args2.indexOf("--thinking") + 1]).toBe("off");
    expect(args2).not.toContain("--model");
  });

  it("omits --thinking when config.thinking is unset (pi default thinking level)", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain("--thinking");
  });

  // ── Session persistence & resume (team session resume, ADR-0004) ──

  it("never passes --no-session (member sessions must persist for resume)", async () => {
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess(defaultConfig, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain("--no-session");
  });

  it("adds --continue when resume is requested and session files exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "member-resume-"));
    // pi nests session files under a per-cwd subdir — hasSessionFiles must be recursive
    mkdirSync(join(dir, "nested-cwd"), { recursive: true });
    writeFileSync(join(dir, "nested-cwd", "2024-01-01T00-00-00_abc123.jsonl"), "{}\n");
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess({ ...defaultConfig, sessionDir: dir, resume: true }, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    expect(spawnMock.mock.calls[0][1] as string[]).toContain("--continue");
  });

  it("omits --continue when resume is requested but no session files exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "member-resume-empty-"));
    const { process: mockProcess, stdout } = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValue(mockProcess);

    const member = createMemberProcess({ ...defaultConfig, sessionDir: dir, resume: true }, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(stdout);
    await startPromise;

    expect(spawnMock.mock.calls[0][1] as string[]).not.toContain("--continue");
  });

  it("auto-resumes with --continue on restart after a successful first start (crash recovery)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "member-restart-"));
    writeFileSync(join(dir, "session.jsonl"), "{}\n"); // pi persists incrementally
    const first = createMockSpawn();
    const second = createMockSpawn();
    const spawnMock = vi.fn().mockReturnValueOnce(first.process).mockReturnValue(second.process);

    const member = createMemberProcess({ ...defaultConfig, sessionDir: dir }, spawnMock);
    const startPromise = member.start();
    emitReadyStdout(first.stdout);
    await startPromise;
    // First start: fresh (no --continue — files exist but this handle never ran)
    expect(spawnMock.mock.calls[0][1] as string[]).not.toContain("--continue");

    // Simulate crash, then auto-restart via the same handle
    first.process.emit("exit", 1, null);
    const restartPromise = member.start();
    emitReadyStdout(second.stdout);
    await restartPromise;

    expect(spawnMock.mock.calls[1][1] as string[]).toContain("--continue");
  });

  it("hasSessionFiles detects nested .jsonl and tolerates missing dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "hsf-"));
    expect(hasSessionFiles(dir)).toBe(false);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.jsonl"), "{}\n");
    expect(hasSessionFiles(dir)).toBe(true);
    expect(hasSessionFiles(join(dir, "does-not-exist"))).toBe(false);
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

    it("rejects on oversized command", async () => {
      const { process: mockProcess, stdout } = createMockSpawn();
      const spawnMock = vi.fn().mockReturnValue(mockProcess);

      const member = createMemberProcess(defaultConfig, spawnMock);
      const startPromise = member.start();
      emitReadyStdout(stdout);
      await startPromise;

      const largeObj = { data: "x".repeat(2 * 1024 * 1024) };
      await expect(
        member.sendCommandAndWait(largeObj, () => true)
      ).rejects.toThrow(/exceeds MAX_COMMAND_SIZE/);
    });

    it("rejects if member is not running", async () => {
      const member = createMemberProcess(defaultConfig, vi.fn());
      // Don't start - status is "stopped"
      await expect(
        member.sendCommandAndWait({ type: "get_messages" }, () => true)
      ).rejects.toThrow();
    });
  });

  describe("sendCommand", () => {
    it("sends command JSON to stdin", async () => {
      const { process: mockProcess, stdin, stdout } = createMockSpawn();
      const spawnMock = vi.fn().mockReturnValue(mockProcess);

      const member = createMemberProcess(defaultConfig, spawnMock);
      const startPromise = member.start();
      emitReadyStdout(stdout);
      await startPromise;

      const writeSpy = vi.spyOn(stdin, "write");
      member.sendCommand({ type: "prompt", message: "hello" });

      const sent = JSON.parse(writeSpy.mock.calls[0][0] as string);
      expect(sent.type).toBe("prompt");
      expect(sent.message).toBe("hello");
    });

    it("throws on oversized command", async () => {
      const { process: mockProcess, stdout } = createMockSpawn();
      const spawnMock = vi.fn().mockReturnValue(mockProcess);

      const member = createMemberProcess(defaultConfig, spawnMock);
      const startPromise = member.start();
      emitReadyStdout(stdout);
      await startPromise;

      const largeObj = { data: "x".repeat(2 * 1024 * 1024) };
      expect(() => member.sendCommand(largeObj)).toThrow(/exceeds MAX_COMMAND_SIZE/);
    });

    it("handles drain event when stdin buffer is full", async () => {
      const { process: mockProcess, stdin, stdout } = createMockSpawn();
      const spawnMock = vi.fn().mockReturnValue(mockProcess);

      const member = createMemberProcess(defaultConfig, spawnMock);
      const startPromise = member.start();
      emitReadyStdout(stdout);
      await startPromise;

      // Spy on stdin.write — first call returns false to simulate full buffer
      const writeSpy = vi.spyOn(stdin, "write");
      writeSpy.mockImplementationOnce(() => false);

      member.sendCommand({ type: "test", data: "hello" });

      // First call returned false, data should be queued
      expect(writeSpy).toHaveBeenCalledTimes(1);

      // Manually emit drain to trigger flush
      stdin.emit("drain");

      // Wait for microtasks
      await new Promise((r) => setTimeout(r, 10));

      // The write should have been retried (second call through original impl)
      expect(writeSpy).toHaveBeenCalledTimes(2);
    });

    it("throws if member is not running", () => {
      const member = createMemberProcess(defaultConfig, vi.fn());
      expect(() => member.sendCommand({ type: "test" })).toThrow(/not running/);
    });
  });

  describe("MAX_COMMAND_SIZE", () => {
    it("is exported and equals 1MB", () => {
      expect(MAX_COMMAND_SIZE).toBe(1024 * 1024);
    });
  });

  describe("MAX_PENDING_WRITES", () => {
    it("is exported and equals 1000", () => {
      expect(MAX_PENDING_WRITES).toBe(1000);
    });
  });

  describe("startingInProgress flag", () => {
    it("should prevent concurrent start() calls", async () => {
      const { process: mockProcess, stdout } = createMockSpawn();
      const spawnMock = vi.fn().mockReturnValue(mockProcess);

      const member = createMemberProcess(defaultConfig, spawnMock);

      // Call start twice concurrently
      const start1 = member.start();
      const start2 = member.start();
      emitReadyStdout(stdout);
      await Promise.all([start1, start2]);

      // Only one spawn should have happened
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(member.getState().status).toBe("running");
    });
  });
});
