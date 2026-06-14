import { describe, it, expect, vi } from "vitest";
import { registerTlTools } from "./tl-tools";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function createMinimalDeps(overrides?: Record<string, any>) {
  return {
    pi: createMockPi(),
    manager: { listStatus: vi.fn(), getStatus: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), handleExit: vi.fn(), addHandle: vi.fn(), setOperationalState: vi.fn(), getOperationalState: vi.fn(), getOperationalStateMap: vi.fn(() => new Map()) } as any,
    responseWaiter: { waitForResponse: vi.fn(), resolveIfWaiting: vi.fn(), cancelAll: vi.fn(), cancelByCorrId: vi.fn() } as any,
    memberOpsStates: new Map(),
    lastPendingCorrId: new Map(),
    messageQueue: { enqueue: vi.fn(), length: vi.fn(), drain: vi.fn(), stop: vi.fn() } as any,
    ...overrides,
  };
}

describe("add_dynamic_member tool", () => {
  it("registers add_dynamic_member tool", () => {
    const pi = createMockPi();
    registerTlTools(createMinimalDeps({ pi }));
    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "add_dynamic_member" })
    );
  });

  it("rejects when not in dynamic session mode", async () => {
    const pi = createMockPi();
    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "add_dynamic_member") executeFn = def.execute;
    });

    registerTlTools(createMinimalDeps({ pi }));

    const result = await executeFn("call-1", {
      name: "coder",
      label: "\u7f16\u7801\u5458",
      systemPrompt: "You are a coder",
    });
    expect(result.content[0].text).toContain("\u4ec5\u5728 /team dynamic");
  });

  it("adds member when in dynamic session mode", async () => {
    const pi = createMockPi();
    const addMemberMock = vi.fn();
    const onAddedMock = vi.fn();

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "add_dynamic_member") executeFn = def.execute;
    });

    registerTlTools(createMinimalDeps({
      pi,
      isDynamicSession: true,
      addMemberToSession: addMemberMock,
      onDynamicMemberAdded: onAddedMock,
    }));

    const result = await executeFn("call-2", {
      name: "coder",
      label: "\u7f16\u7801\u5458",
      systemPrompt: "You are a coding expert",
      model: "claude-3",
    });

    expect(addMemberMock).toHaveBeenCalledWith({
      name: "coder",
      label: "\u7f16\u7801\u5458",
      systemPrompt: "You are a coding expert",
      model: "claude-3",
    });
    expect(onAddedMock).toHaveBeenCalled();
    expect(result.content[0].text).toContain("\u7f16\u7801\u5458");
    expect(result.content[0].text).toContain("coder");
  });

  it("adds member with dynamic isDynamicSession getter", async () => {
    const pi = createMockPi();
    let dynamicFlag = false;
    const addMemberMock = vi.fn();
    const onAddedMock = vi.fn();

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "add_dynamic_member") executeFn = def.execute;
    });

    registerTlTools(createMinimalDeps({
      pi,
      isDynamicSession: () => dynamicFlag,
      addMemberToSession: addMemberMock,
      onDynamicMemberAdded: onAddedMock,
    }));

    // Not dynamic -> should reject
    let result = await executeFn("call-3", {
      name: "coder",
      label: "\u7f16\u7801\u5458",
      systemPrompt: "Code",
    });
    expect(result.content[0].text).toContain("\u4ec5\u5728 /team dynamic");
    expect(addMemberMock).not.toHaveBeenCalled();

    // Now dynamic -> should work
    dynamicFlag = true;
    result = await executeFn("call-4", {
      name: "coder",
      label: "\u7f16\u7801\u5458",
      systemPrompt: "Code",
    });
    expect(addMemberMock).toHaveBeenCalled();
    expect(result.content[0].text).toContain("\u5df2\u6dfb\u52a0");
  });

  it("returns error when addMemberToSession throws", async () => {
    const pi = createMockPi();
    const addMemberMock = vi.fn().mockImplementation(() => {
      throw new Error("No active session");
    });

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "add_dynamic_member") executeFn = def.execute;
    });

    registerTlTools(createMinimalDeps({
      pi,
      isDynamicSession: true,
      addMemberToSession: addMemberMock,
      onDynamicMemberAdded: vi.fn(),
    }));

    const result = await executeFn("call-5", {
      name: "coder",
      label: "\u7f16\u7801\u5458",
      systemPrompt: "Code",
    });
    expect(result.content[0].text).toContain("\u6dfb\u52a0\u6210\u5458\u5931\u8d25");
    expect(result.content[0].text).toContain("No active session");
  });

  it("accepts only required params without model", async () => {
    const pi = createMockPi();
    const addMemberMock = vi.fn();

    let executeFn: Function = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === "add_dynamic_member") executeFn = def.execute;
    });

    registerTlTools(createMinimalDeps({
      pi,
      isDynamicSession: true,
      addMemberToSession: addMemberMock,
      onDynamicMemberAdded: vi.fn(),
    }));

    await executeFn("call-6", {
      name: "reviewer",
      label: "\u5ba1\u67e5\u5458",
      systemPrompt: "Review code",
    });

    expect(addMemberMock).toHaveBeenCalledWith({
      name: "reviewer",
      label: "\u5ba1\u67e5\u5458",
      systemPrompt: "Review code",
      model: undefined,
    });
  });
});
