import { describe, it, expect, vi } from "vitest";
import type { MemberOperationalState } from "../session/context";
import type { TeamMember } from "../team/definition";

// ── Mock pi-tui ────────────────────────────────────────────

vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: (text: string) => text.length,
}));

// ── Helpers ────────────────────────────────────────────────

function createMockTheme() {
  return {
    fg: vi.fn((_color: string, text: string) => text),
  };
}

function createMockTeamCtx() {
  return {
    memberHandles: new Map(),
    getHandle: (name: string) => undefined,
    setHandle: vi.fn(),
    clearHandles: vi.fn(),
  };
}

async function loadModule() {
  return await import("./team-status-widget");
}

function createTeamMember(name: string, label: string): TeamMember {
  return { name, label, systemPrompt: `You are ${name}` };
}

describe("createTeamStatusWidget", () => {
  it("should install widget with correct initial display", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();
    const memberOpsStates = new Map<string, MemberOperationalState>();
    memberOpsStates.set("analyzer", "idle");
    memberOpsStates.set("worker", "working");

    const widget = createTeamStatusWidget({
      teamName: "test-team",
      getMembers: () => [
        createTeamMember("analyzer", "分析员"),
        createTeamMember("worker", "编码员"),
      ],
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates,
    });

    widget.install(ui, theme);

    expect(setWidget).toHaveBeenCalledWith("team-status", expect.any(Array));
    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines.length).toBe(3); // top border, middle, bottom border
    expect(lines[0]).toContain("TEAM MODE");
    expect(lines[0]).toContain("test-team");
  });

  it("should show design phase text when 0 members", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createTeamStatusWidget({
      teamName: "dynamic-team",
      getMembers: () => [],
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates: new Map(),
    });

    widget.install(ui, theme);

    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("DYNAMIC TEAM");
    expect(lines[0]).toContain("设计阶段");
    expect(lines[1]).toContain("设计团队中");
  });

  it("should uninstall widget and clear state", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createTeamStatusWidget({
      teamName: "test-team",
      getMembers: () => [createTeamMember("analyzer", "分析员")],
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates: new Map([["analyzer", "idle"]]),
    });

    widget.install(ui, theme);
    widget.uninstall();

    // uninstall should set widget to undefined
    expect(setWidget).toHaveBeenLastCalledWith("team-status", undefined);
  });

  it("should show correct states for all member operational states", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const memberOpsStates = new Map<string, MemberOperationalState>([
      ["idle-member", "idle"],
      ["working-member", "working"],
      ["crashed-member", "crashed"],
      ["stopped-member", "stopped"],
    ]);

    const widget = createTeamStatusWidget({
      teamName: "test-team",
      getMembers: () => [
        createTeamMember("idle-member", "空闲员"),
        createTeamMember("working-member", "工作员"),
        createTeamMember("crashed-member", "崩溃员"),
        createTeamMember("stopped-member", "停止员"),
      ],
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates,
    });

    widget.install(ui, theme);

    const lines = setWidget.mock.calls[0][1] as string[];
    // Middle line should contain all 4 member names
    const middle = lines[1];
    expect(middle).toContain("空闲员");
    expect(middle).toContain("工作员");
    expect(middle).toContain("崩溃员");
    expect(middle).toContain("停止员");
  });

  it("should handle refresh after install", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createTeamStatusWidget({
      teamName: "test-team",
      getMembers: () => [createTeamMember("analyzer", "分析员")],
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates: new Map([["analyzer", "idle"]]),
    });

    widget.install(ui, theme);
    // Reset call count so we can verify refresh triggers a new call
    setWidget.mockClear();
    widget.refresh();

    // refresh should call setWidget with widget content
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenCalledWith("team-status", expect.any(Array));
  });

  it("should not throw when uninstall is called without install", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const widget = createTeamStatusWidget({
      teamName: "test-team",
      getMembers: () => [],
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates: new Map(),
    });

    expect(() => widget.uninstall()).not.toThrow();
  });

  it("should handle install with setWidget throwing (UI may be gone)", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const ui = {
      setWidget: vi.fn().mockImplementation(() => {
        throw new Error("UI gone");
      }),
    };
    const theme = createMockTheme();

    const widget = createTeamStatusWidget({
      teamName: "test-team",
      getMembers: () => [],
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates: new Map(),
    });

    expect(() => widget.install(ui, theme)).not.toThrow();
  });

  it("should reflect dynamically added members via getMembers callback", async () => {
    const { createTeamStatusWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();
    const members: TeamMember[] = [];
    const opsStates = new Map<string, MemberOperationalState>();

    const widget = createTeamStatusWidget({
      teamName: "test-team",
      getMembers: () => members,
      teamCtx: createMockTeamCtx() as any,
      memberOpsStates: opsStates,
    });

    widget.install(ui, theme);
    // Initially 0 members — design phase
    expect(setWidget.mock.calls[0][1][0]).toContain("DYNAMIC TEAM");

    // Add a member
    members.push(createTeamMember("new-member", "新成员"));
    opsStates.set("new-member", "idle");

    // Track calls after install
    setWidget.mockClear();
    widget.refresh();
    const linesAfter = setWidget.mock.calls[0][1] as string[];
    expect(linesAfter[1]).toContain("新成员");
  });

  describe("session origin marker (ADR-0003)", () => {
    it("shows 🤖 in the title for agent-initiated sessions", async () => {
      const { createTeamStatusWidget } = await loadModule();
      const setWidget = vi.fn();
      const widget = createTeamStatusWidget({
        teamName: "_dynamic_1",
        getMembers: () => [createTeamMember("coder", "编码员")],
        teamCtx: createMockTeamCtx() as any,
        memberOpsStates: new Map([["coder", "idle"]]),
        origin: "agent",
      });
      widget.install({ setWidget }, createMockTheme());
      expect(setWidget.mock.calls[0][1][0]).toContain("🤖");
    });

    it("shows 👤 in the title for user-initiated sessions (default)", async () => {
      const { createTeamStatusWidget } = await loadModule();
      const setWidget = vi.fn();
      const widget = createTeamStatusWidget({
        teamName: "my-team",
        getMembers: () => [createTeamMember("coder", "编码员")],
        teamCtx: createMockTeamCtx() as any,
        memberOpsStates: new Map([["coder", "idle"]]),
      });
      widget.install({ setWidget }, createMockTheme());
      expect(setWidget.mock.calls[0][1][0]).toContain("👤");
      expect(setWidget.mock.calls[0][1][0]).not.toContain("🤖");
    });

    it("shows the origin marker in design-phase (0 members) title", async () => {
      const { createTeamStatusWidget } = await loadModule();
      const setWidget = vi.fn();
      const widget = createTeamStatusWidget({
        teamName: "_dynamic_2",
        getMembers: () => [],
        teamCtx: createMockTeamCtx() as any,
        memberOpsStates: new Map(),
        origin: "agent",
      });
      widget.install({ setWidget }, createMockTheme());
      expect(setWidget.mock.calls[0][1][0]).toContain("🤖");
      expect(setWidget.mock.calls[0][1][0]).toContain("设计阶段");
    });
  });
});
