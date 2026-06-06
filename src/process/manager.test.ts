import { describe, it, expect, vi, beforeEach } from "vitest";
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
    ...overrides,
  };
}

describe("createProcessManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("triggers auto-restart on unexpected exit", async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    // Simulate a crashed member: status is stopped, not running
    const handle = createMockHandle("analyzer", {
      start: startMock,
      getState: vi.fn().mockReturnValue({ name: "analyzer", pid: null, status: "stopped" }),
    });

    const manager = createProcessManager([handle], { autoRestart: true });

    // Simulate crash
    manager.handleExit("analyzer", 1);

    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("does not auto-restart if autoRestart is false", async () => {
    const startMock = vi.fn().mockResolvedValue(undefined);
    const handle = createMockHandle("analyzer", { start: startMock });

    const manager = createProcessManager([handle], { autoRestart: false });
    manager.handleExit("analyzer", 1);

    expect(startMock).not.toHaveBeenCalled();
  });
});
