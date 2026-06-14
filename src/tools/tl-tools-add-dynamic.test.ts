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
  it("is NOT registered by registerTlTools (only registered dynamically in /team dynamic)", () => {
    const pi = createMockPi();
    registerTlTools(createMinimalDeps({ pi }));
    // Should NOT have add_dynamic_member — it's registered dynamically in /team dynamic handler
    const registeredNames = pi.registerTool.mock.calls.map((c: any[]) => c[0].name);
    expect(registeredNames).not.toContain("add_dynamic_member");
  });
});
