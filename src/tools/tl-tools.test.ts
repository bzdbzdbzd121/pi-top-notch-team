import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTlTools } from "./tl-tools";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: vi.fn((def: any) => {
      tools.push(def);
    }),
    getAllTools: vi.fn().mockReturnValue(tools),
    getActiveTools: vi.fn().mockReturnValue(tools.map((t: any) => t.name)),
    setActiveTools: vi.fn(),
  } as any;
}

function createMockManager(): ProcessManager {
  return {
    listStatus: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    handleExit: vi.fn(),
  };
}

describe("registerTlTools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers 4 tools", () => {
    const pi = createMockPi();
    const manager = createMockManager();
    const createMember = vi.fn();

    registerTlTools(pi, manager, createMember);
    expect(pi.registerTool).toHaveBeenCalledTimes(4);
  });

  it("registers start_member tool", () => {
    const pi = createMockPi();
    const manager = createMockManager();
    const createMember = vi.fn();

    registerTlTools(pi, manager, createMember);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "start_member" })
    );
  });

  it("registers stop_member tool", () => {
    const pi = createMockPi();
    const manager = createMockManager();
    const createMember = vi.fn();

    registerTlTools(pi, manager, createMember);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "stop_member" })
    );
  });

  it("registers list_members tool", () => {
    const pi = createMockPi();
    const manager = createMockManager();
    const createMember = vi.fn();

    registerTlTools(pi, manager, createMember);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "list_members" })
    );
  });

  it("registers get_member_log tool", () => {
    const pi = createMockPi();
    const manager = createMockManager();
    const createMember = vi.fn();

    registerTlTools(pi, manager, createMember);
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "get_member_log" })
    );
  });
});
