import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProcessManager } from "./manager";
import type { MemberProcessHandle } from "./member-process";

function createMockHandle(
  name: string,
  overrides?: Partial<MemberProcessHandle>
): MemberProcessHandle {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue({ name, pid: 12345, status: "running" }),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn().mockResolvedValue({ data: { messages: [] } }),
    ...overrides,
  };
}

describe("createProcessManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts all members", async () => {
    const handles = [
      createMockHandle("analyzer"),
      createMockHandle("mover"),
    ];

    const manager = createProcessManager(handles);
    expect(manager.getStatus("analyzer")?.status).toBe("running");

    // All should be running
    const allStatus = manager.listStatus();
    expect(allStatus).toHaveLength(2);
  });

  it("stops all members", async () => {
    const handles = [
      createMockHandle("analyzer"),
      createMockHandle("mover"),
    ];

    const manager = createProcessManager(handles);
    await manager.stopAll();

    expect(handles[0].stop).toHaveBeenCalled();
    expect(handles[1].stop).toHaveBeenCalled();
  });

  it("stops a single member", async () => {
    const handles = [
      createMockHandle("analyzer"),
      createMockHandle("mover"),
    ];

    const manager = createProcessManager(handles);
    await manager.stop("analyzer");

    expect(handles[0].stop).toHaveBeenCalled();
    expect(handles[1].stop).not.toHaveBeenCalled();
  });

  it("reports member status", () => {
    const handles = [
      createMockHandle("analyzer", {
        getState: vi.fn().mockReturnValue({ name: "analyzer", pid: 12345, status: "running" }),
      }),
      createMockHandle("mover", {
        getState: vi.fn().mockReturnValue({ name: "mover", pid: null, status: "stopped" }),
      }),
    ];

    const manager = createProcessManager(handles);
    const allStatus = manager.listStatus();

    expect(allStatus).toEqual([
      { name: "analyzer", pid: 12345, status: "running" },
      { name: "mover", pid: null, status: "stopped" },
    ]);
  });

  it("returns null for unknown member status", () => {
    const manager = createProcessManager([]);
    expect(manager.getStatus("nonexistent")).toBeNull();
  });

  it("triggers auto-restart on unexpected exit with backoff delay", async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    // Simulate a crashed member: status is stopped, not running
    const handle = createMockHandle("analyzer", {
      start: startMock,
      getState: vi.fn().mockReturnValue({ name: "analyzer", pid: null, status: "stopped" }),
    });

    const manager = createProcessManager([handle], { autoRestart: true });

    // Simulate crash
    manager.handleExit("analyzer", 1);
    // start should NOT be called immediately — it's delayed
    expect(startMock).not.toHaveBeenCalled();

    // Advance past the initial backoff (1000ms)
    await vi.advanceTimersByTimeAsync(1500);

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("does not auto-restart if autoRestart is false", async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    const handle = createMockHandle("analyzer", { start: startMock });

    const manager = createProcessManager([handle], { autoRestart: false });
    manager.handleExit("analyzer", 1);

    expect(startMock).not.toHaveBeenCalled();
  });

  it("adds a new handle dynamically via addHandle", () => {
    const manager = createProcessManager([]);
    expect(manager.listStatus()).toHaveLength(0);

    const handle = createMockHandle("new-member");
    manager.addHandle(handle);

    expect(manager.listStatus()).toHaveLength(1);
    expect(manager.getStatus("new-member")?.status).toBe("running");
  });

  it("stopAll works with dynamically added handles", async () => {
    const stopMock = vi.fn().mockResolvedValue(undefined);
    const handle = createMockHandle("dynamic", { stop: stopMock });

    const manager = createProcessManager([]);
    manager.addHandle(handle);
    await manager.stopAll();

    expect(stopMock).toHaveBeenCalled();
  });

  it("applies exponential backoff on repeated crashes", async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    const handle = createMockHandle("crashy", {
      start: startMock,
      getState: vi.fn().mockReturnValue({ name: "crashy", pid: null, status: "stopped" }),
    });

    const manager = createProcessManager([handle], { autoRestart: true });

    // Crash 3 times — each restart uses increasing backoff
    manager.handleExit("crashy", 1);
    await vi.advanceTimersByTimeAsync(1500); // 1st backoff ~1s
    expect(startMock).toHaveBeenCalledTimes(1);

    manager.handleExit("crashy", 1);
    await vi.advanceTimersByTimeAsync(2500); // 2nd backoff ~2s
    expect(startMock).toHaveBeenCalledTimes(2);

    manager.handleExit("crashy", 1);
    await vi.advanceTimersByTimeAsync(4500); // 3rd backoff ~4s
    expect(startMock).toHaveBeenCalledTimes(3);
  });

  it("detects crash loop and stops auto-restart after maxRestarts", async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    const handle = createMockHandle("loopy", {
      start: startMock,
      getState: vi.fn().mockReturnValue({ name: "loopy", pid: null, status: "stopped" }),
    });

    const crashLoopSpy = vi.fn();
    const manager = createProcessManager([handle], {
      autoRestart: true,
      maxRestarts: 3, // Low threshold for test
      restartWindowMs: 60_000,
      initialBackoffMs: 10, // Fast for test
      onCrashLoopDetected: crashLoopSpy,
    });

    // Crash 4 times (maxRestarts=3 means the 4th triggers loop detection)
    for (let i = 0; i < 4; i++) {
      manager.handleExit("loopy", 1);
      await vi.advanceTimersByTimeAsync(100);
    }

    // Only 3 restarts should have happened (the 4th triggers crash loop)
    expect(startMock).toHaveBeenCalledTimes(3);
    expect(crashLoopSpy).toHaveBeenCalledWith("loopy", 4);
  });

  it("shows error status for frozen members via listStatus", async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    const handle = createMockHandle("loopy", {
      start: startMock,
      getState: vi.fn().mockReturnValue({ name: "loopy", pid: null, status: "stopped" }),
    });

    const manager = createProcessManager([handle], {
      autoRestart: true,
      maxRestarts: 2,
      restartWindowMs: 60_000,
      initialBackoffMs: 10,
    });

    // Exceed the crash limit
    for (let i = 0; i < 3; i++) {
      manager.handleExit("loopy", 1);
      await vi.advanceTimersByTimeAsync(100);
    }

    // Status should show as "error"
    expect(manager.getStatus("loopy")?.status).toBe("error");
    expect(manager.listStatus()[0].status).toBe("error");
  });

  describe("stopAll with allSettled", () => {
    it("should continue stopping other members when one member's stop fails", async () => {
      const stopMock1 = vi.fn().mockResolvedValue(undefined);
      const stopMock2 = vi.fn().mockRejectedValue(new Error("Connection lost"));
      const stopMock3 = vi.fn().mockResolvedValue(undefined);

      const handles = [
        createMockHandle("member1", { stop: stopMock1 }),
        createMockHandle("member2", { stop: stopMock2 }),
        createMockHandle("member3", { stop: stopMock3 }),
      ];

      const manager = createProcessManager(handles);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Should not reject
      await expect(manager.stopAll()).resolves.toBeUndefined();

      // All handles should have stop called
      expect(stopMock1).toHaveBeenCalled();
      expect(stopMock2).toHaveBeenCalled();
      expect(stopMock3).toHaveBeenCalled();

      // Should warn about the failure
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("1 member(s) failed to stop")
      );

      warnSpy.mockRestore();
    });

    it("should resolve successfully when all members stop cleanly", async () => {
      const handles = [
        createMockHandle("member1"),
        createMockHandle("member2"),
      ];

      const manager = createProcessManager(handles);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(manager.stopAll()).resolves.toBeUndefined();

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("member(s) failed to stop")
      );

      warnSpy.mockRestore();
    });

    it("should not reject with empty members", async () => {
      const manager = createProcessManager([]);
      await expect(manager.stopAll()).resolves.toBeUndefined();
    });

    it("should cancel pending restart timers before stopping", async () => {
      const startMock = vi.fn().mockResolvedValue(undefined);
      const stopMock = vi.fn().mockResolvedValue(undefined);
      const handle = createMockHandle("restarty", {
        start: startMock,
        stop: stopMock,
        getState: vi.fn().mockReturnValue({ name: "restarty", pid: null, status: "stopped" }),
      });

      const manager = createProcessManager([handle], {
        autoRestart: true,
        initialBackoffMs: 1000,
      });

      // Trigger crash handling (schedules pending restart timer)
      manager.handleExit("restarty", 1);

      // stopAll should cancel the timer and stop the member
      await manager.stopAll();

      // start should NOT have been called (timer was cancelled)
      expect(startMock).not.toHaveBeenCalled();
      expect(stopMock).toHaveBeenCalled();
    });
  });
});
