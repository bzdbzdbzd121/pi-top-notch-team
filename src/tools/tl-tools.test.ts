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
    addHandle: vi.fn(),
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

  it("start_member execute calls createMember when buildMemberConfig returns a config", async () => {
    const pi = createMockPi();
    const manager = createMockManager();
    const createMember = vi.fn().mockReturnValue({
      name: "analyzer",
      start: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue({ name: "analyzer", pid: 12345, status: "running" }),
      stop: vi.fn(),
      onEvent: vi.fn(),
      sendCommand: vi.fn(),
    });
    const buildConfig = vi.fn().mockReturnValue({
      name: "analyzer",
      role: "analyzer",
      teamName: "test",
    });

    // Capture the registerTool call for start_member
    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") {
        executeFn = def.execute;
      }
    });

    registerTlTools(pi, manager, createMember, buildConfig);

    const result = await executeFn("call-1", { name: "analyzer" });
    expect(buildConfig).toHaveBeenCalledWith("analyzer");
    expect(createMember).toHaveBeenCalled();
    expect(result.content[0].text).toContain("已启动");
  });

  it("start_member returns error when buildMemberConfig returns null", async () => {
    const pi = createMockPi();
    const manager = createMockManager();
    const buildConfig = vi.fn().mockReturnValue(null);

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "start_member") {
        executeFn = def.execute;
      }
    });

    registerTlTools(pi, manager, vi.fn(), buildConfig);

    const result = await executeFn("call-2", { name: "nonexistent" });
    expect(result.content[0].text).toContain("无法启动");
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
