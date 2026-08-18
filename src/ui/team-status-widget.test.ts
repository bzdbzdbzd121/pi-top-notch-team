import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MemberOperationalState } from "../session/context";
import type { TeamMember } from "../team/definition";
import { createActivityTracker } from "../channel/activity-tracker";

// ── Mock pi-tui ────────────────────────────────────────────

vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: (text: string) => text.length,
}));

// ── Helpers ────────────────────────────────────────────────

function createMockTheme() {
  return {
    // Wrap with a color marker so tests can distinguish styled output
    // (the real theme.fg emits ANSI codes — the render gate compares styled
    // lines, so a pass-through mock would hide color-only changes, B1).
    fg: vi.fn((color: string, text: string) => `<${color}>${text}</${color}>`),
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
  let widgetFactory: (opts: any) => any;
  let tracker: ReturnType<typeof createActivityTracker>;

  beforeEach(async () => {
    const mod = await loadModule();
    widgetFactory = mod.createTeamStatusWidget;
    tracker = createActivityTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Build a widget + capture the last setWidget content (lines). */
  function build(opts: {
    teamName?: string;
    members: TeamMember[];
    opsStates: Record<string, MemberOperationalState>;
    teamCtx?: any;
    origin?: "user" | "agent";
  }) {
    const setWidget = vi.fn();
    let lastLines: string[] | null = null;
    setWidget.mockImplementation((key: string, content: any) => {
      if (key === "team-status") lastLines = content;
    });
    const ui = { setWidget };
    const theme = createMockTheme();
    const memberOpsStates = new Map<string, MemberOperationalState>(
      Object.entries(opts.opsStates)
    );
    const widget = widgetFactory({
      teamName: opts.teamName ?? "test-team",
      getMembers: () => opts.members,
      teamCtx: opts.teamCtx ?? createMockTeamCtx(),
      memberOpsStates,
      activityTracker: tracker,
      origin: opts.origin,
    });
    return {
      widget,
      setWidget,
      ui,
      theme,
      memberOpsStates,
      middle: () => lastLines?.[1] ?? "",
      lines: () => lastLines,
    };
  }

  /**
   * Member RPC event injection, mirroring the index.ts multi-cast order:
   * tracker.onEvent → (process death → tracker.delete, P3) → widget.onMemberEvent.
   */
  function emit(h: ReturnType<typeof build>, name: string, event: any) {
    tracker.onEvent(name, event);
    if (event?.type === "process_exit" || event?.type === "process_error") {
      tracker.delete(name);
    }
    h.widget.onMemberEvent(name, event);
  }

  it("should install widget with correct initial display", async () => {
    const h = build({
      members: [
        createTeamMember("analyzer", "分析员"),
        createTeamMember("worker", "编码员"),
      ],
      opsStates: { analyzer: "idle", worker: "working" },
    });
    h.widget.install(h.ui, h.theme);
    expect(h.setWidget).toHaveBeenCalledWith("team-status", expect.any(Array));
    const lines = h.lines()!;
    expect(lines.length).toBe(3); // top border, middle, bottom border
    expect(lines[0]).toContain("TEAM MODE");
    expect(lines[0]).toContain("test-team");
  });

  it("should show design phase text when 0 members", async () => {
    const h = build({ members: [], opsStates: {} });
    h.widget.install(h.ui, h.theme);
    const lines = h.lines()!;
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("DYNAMIC TEAM");
    expect(lines[0]).toContain("设计阶段");
    expect(lines[1]).toContain("设计团队中");
  });

  it("should uninstall widget and clear state", async () => {
    const h = build({ members: [createTeamMember("analyzer", "分析员")], opsStates: { analyzer: "idle" } });
    h.widget.install(h.ui, h.theme);
    h.widget.uninstall();
    // uninstall should set widget to undefined
    expect(h.setWidget).toHaveBeenLastCalledWith("team-status", undefined);
  });

  it("should show correct states for all member operational states", async () => {
    const h = build({
      members: [
        createTeamMember("idle-member", "空闲员"),
        createTeamMember("working-member", "工作员"),
        createTeamMember("crashed-member", "崩溃员"),
        createTeamMember("stopped-member", "停止员"),
      ],
      opsStates: {
        "idle-member": "idle",
        "working-member": "working",
        "crashed-member": "crashed",
        "stopped-member": "stopped",
      },
    });
    h.widget.install(h.ui, h.theme);
    const middle = h.middle();
    expect(middle).toContain("空闲员");
    expect(middle).toContain("工作员");
    expect(middle).toContain("崩溃员");
    expect(middle).toContain("停止员");
  });

  it("N1 render-side gate: refresh with unchanged content skips setWidget; changed content renders", async () => {
    const h = build({ members: [createTeamMember("analyzer", "分析员")], opsStates: { analyzer: "idle" } });
    h.widget.install(h.ui, h.theme);
    h.setWidget.mockClear();
    h.widget.refresh();
    // Identical content → the raw-line comparison gate skips setWidget entirely.
    expect(h.setWidget).not.toHaveBeenCalled();
    // Content change → renders exactly once.
    h.memberOpsStates.set("analyzer", "working");
    h.widget.refresh();
    expect(h.setWidget).toHaveBeenCalledTimes(1);
    expect(h.setWidget).toHaveBeenCalledWith("team-status", expect.any(Array));
  });

  it("should not throw when uninstall is called without install", async () => {
    const h = build({ members: [], opsStates: {} });
    expect(() => h.widget.uninstall()).not.toThrow();
  });

  it("should handle install with setWidget throwing (UI may be gone)", async () => {
    const h = build({ members: [], opsStates: {} });
    h.ui.setWidget.mockImplementation(() => {
      throw new Error("UI gone");
    });
    expect(() => h.widget.install(h.ui, h.theme)).not.toThrow();
  });

  it("should reflect dynamically added members via getMembers callback", async () => {
    const members: TeamMember[] = [];
    const h = build({ members, opsStates: {} });
    h.widget.install(h.ui, h.theme);
    expect(h.lines()![0]).toContain("DYNAMIC TEAM");
    // Add a member
    members.push(createTeamMember("new-member", "新成员"));
    h.memberOpsStates.set("new-member", "idle");
    h.setWidget.mockClear();
    h.widget.refresh();
    expect(h.lines()![1]).toContain("新成员");
  });

  describe("session origin marker (ADR-0003)", () => {
    it("shows 🤖 in the title for agent-initiated sessions", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "idle" }, origin: "agent" });
      h.widget.install(h.ui, h.theme);
      expect(h.lines()![0]).toContain("🤖");
    });

    it("shows 👤 in the title for user-initiated sessions (default)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "idle" } });
      h.widget.install(h.ui, h.theme);
      expect(h.lines()![0]).toContain("👤");
      expect(h.lines()![0]).not.toContain("🤖");
    });

    it("shows the origin marker in design-phase (0 members) title", async () => {
      const h = build({ members: [], opsStates: {}, origin: "agent" });
      h.widget.install(h.ui, h.theme);
      expect(h.lines()![0]).toContain("🤖");
      expect(h.lines()![0]).toContain("设计阶段");
    });
  });

  // ── Live phases + N1 gates (fake timers) ─────────────────

  describe("live phases (event-driven rendering)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    it("renders fine-grained phases from tracker events with icons and colors", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      h.setWidget.mockClear();

      // agent_start → thinking 💭 (accent)
      emit(h, "coder", { type: "agent_start" });
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.middle()).toContain("💭");
      expect(h.middle()).toContain("编码员");
      expect(h.middle()).toContain("<accent>");

      // tool execution → executing 🔧 (warning) — same icon+color as tool-calling
      emit(h, "coder", { type: "tool_execution_start", toolName: "bash -c make" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.middle()).toContain("🔧");
      expect(h.middle()).toContain("<warning>");
      expect(h.middle()).not.toContain("bash"); // v2: no tool name anywhere

      // executing ends while text stream active → output ✏️ (success)
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "text_delta" } });
      emit(h, "coder", { type: "tool_execution_end" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.middle()).toContain("✏️");
      expect(h.middle()).toContain("<success>");

      // agent_end → idle ✅ (the logical layer also flips working→idle right
      // after the activity hook fires — simulated here, mirrors event-handler)
      emit(h, "coder", { type: "agent_end" });
      h.memberOpsStates.set("coder", "idle");
      await vi.advanceTimersByTimeAsync(300);
      expect(h.middle()).toContain("✅");
      expect(h.middle()).not.toContain("💭");
    });

    it("working gap fallback shows 💭 (default); tool-calling shows 🔧 (warning)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      h.setWidget.mockClear();

      emit(h, "coder", { type: "agent_start" });
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
      await vi.advanceTimersByTimeAsync(300);
      // working: 💭 (neutral default color — no color wrap; thinking is the
      // SAME icon but accent — the color is the discriminator)
      expect(h.middle()).toContain("💭");
      expect(h.middle()).not.toContain("<accent>");
      expect(h.middle()).not.toContain("<warning>");

      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
      await vi.advanceTimersByTimeAsync(300);
      // tool-calling: 🔧 warning — distinct icon AND color from 💭 working
      expect(h.middle()).toContain("🔧");
      expect(h.middle()).toContain("<warning>");
    });

    it("logical-layer overlay wins over fine-grained phases (compacting/crashed/stopped)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      // tracker says executing — overlay must still win
      emit(h, "coder", { type: "agent_start" });
      emit(h, "coder", { type: "tool_execution_start", toolName: "bash" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.middle()).toContain("🔧");

      h.memberOpsStates.set("coder", "compacting");
      h.widget.refresh();
      expect(h.middle()).toContain("🗜️");
      h.memberOpsStates.set("coder", "crashed");
      h.widget.refresh();
      expect(h.middle()).toContain("💥");
      h.memberOpsStates.set("coder", "stopped");
      h.widget.refresh();
      expect(h.middle()).toContain("⏹️");
    });

    it("v2: tool-calling → executing renders IDENTICAL output → the render gate skips setWidget (correct N1 semantics)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      h.setWidget.mockClear();

      // tool-calling (🔧 warning)
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget.mock.calls.length).toBe(1);
      expect(h.middle()).toContain("<warning>");
      expect(h.middle()).toContain("🔧");

      // executing: same icon + same color → styled identical → gate skips.
      // (v2 icon matrix: tool-calling and executing are BOTH 🔧 warning — the
      // phases stay structurally distinct, the VISUAL does not change.)
      h.setWidget.mockClear();
      emit(h, "coder", { type: "tool_execution_start" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget).not.toHaveBeenCalled();
      expect(h.middle()).toContain("🔧"); // visual unchanged

      // a DIFFERENT icon/color transition still renders: executing → output ✏️
      // (toolcall_end closes the arg-generation stream first, then text takes
      // priority after tool_execution_end — realistic order)
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "toolcall_end" } });
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "text_delta" } });
      emit(h, "coder", { type: "tool_execution_end" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget.mock.calls.length).toBe(1);
      expect(h.middle()).toContain("✏️");
    });

    it("v2 display purity: segments contain only icon + label + percent (no duration/toolname/ellipsis)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      h.setWidget.mockClear();

      emit(h, "coder", { type: "agent_start" });
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      await vi.advanceTimersByTimeAsync(300);
      // no duration: no digits, no s/m units, no ellipsis, no tool names
      expect(h.middle()).not.toMatch(/\d+/);
      expect(h.middle()).not.toContain("…");
      expect(h.middle()).not.toContain("bash");

      emit(h, "coder", { type: "tool_execution_start", toolName: "bash -c make -j8" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.middle()).not.toMatch(/\d+/);
      expect(h.middle()).not.toContain("…");
      expect(h.middle()).not.toContain("bash");
    });

    it("working→tool-calling transition renders (icon+color both change: 💭 default → 🔧 warning)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      // Install rendered the working fallback: 💭 default (no color wrap).
      expect(h.middle()).toContain("💭");
      expect(h.middle()).not.toContain("<warning>");
      h.setWidget.mockClear();
      // toolcall delta on a fresh member → tool-calling: icon AND color change
      // (💭 plain → 🔧 warning) — must render.
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget.mock.calls.length).toBe(1);
      expect(h.middle()).toContain("<warning>");
      expect(h.middle()).toContain("🔧");
    });

    it("v2.2: working→thinking same-icon transition (💭 default → 💭 accent) passes the render gate — color-only change (B1)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      // Install rendered the working fallback: 💭 default — RAW identical to
      // thinking (same icon), the ONLY discriminator is the accent color.
      expect(h.middle()).toContain("💭");
      expect(h.middle()).not.toContain("<accent>");
      h.setWidget.mockClear();
      // agent_start → thinking 💭 accent: styled differs (color), raw identical
      // — the styled render gate MUST capture this transition (B1 guard).
      emit(h, "coder", { type: "agent_start" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget.mock.calls.length).toBe(1);
      expect(h.middle()).toContain("💭");
      expect(h.middle()).toContain("<accent>");

      // thinking → working (thinking_end, same icon): the reverse direction
      // must also render — accent color disappears.
      h.setWidget.mockClear();
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget.mock.calls.length).toBe(1);
      expect(h.middle()).toContain("💭");
      expect(h.middle()).not.toContain("<accent>");
    });

    it("S1: process death with an unchanged signature still re-renders promptly (no 30s poll lag)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "idle" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      h.setWidget.mockClear();
      // Idle member with NO tracker entry: process_exit leaves the signature
      // unchanged (idle|idle) — the force-schedule path must still render,
      // and by flush time the logical layer shows the process state.
      emit(h, "coder", { type: "process_exit", memberName: "coder", exitCode: 0, wasRunning: true });
      h.memberOpsStates.set("coder", "stopped"); // event-handler update, right after the multi-cast
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget.mock.calls.length).toBe(1);
      expect(h.middle()).toContain("⏹️");
    });

    it("N1 scheduling gate: no-change events never trigger a render", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      emit(h, "coder", { type: "agent_start" });
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      await vi.advanceTimersByTimeAsync(300); // renders 💭 once
      h.setWidget.mockClear();
      // 100 same-phase deltas within the same second → signature unchanged → zero renders
      for (let i = 0; i < 100; i++) {
        emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      }
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.setWidget).not.toHaveBeenCalled();
    });

    it("rapid signature changes within the window merge into a single flush", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      h.setWidget.mockClear();
      // Multiple phase changes at the same timestamp → one merged flush
      emit(h, "coder", { type: "agent_start" });
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      emit(h, "coder", { type: "message_update", assistantMessageEvent: { type: "text_delta" } });
      emit(h, "coder", { type: "tool_execution_start", toolName: "bash -c make" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget.mock.calls.length).toBe(1);
      expect(h.middle()).toContain("🔧"); // final state rendered
    });

    it("onMemberEvent before install is ignored (no scheduling)", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      emit(h, "coder", { type: "agent_start" });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.setWidget).not.toHaveBeenCalled();
      h.widget.install(h.ui, h.theme);
      expect(h.setWidget).toHaveBeenCalledTimes(1); // initial render only
    });

    it("uninstall cancels live-refresh timers and resets render state", async () => {
      const h = build({ members: [createTeamMember("coder", "编码员")], opsStates: { coder: "working" } });
      h.widget.install(h.ui, h.theme);
      await vi.advanceTimersByTimeAsync(0);
      emit(h, "coder", { type: "agent_start" });
      expect(vi.getTimerCount()).toBeGreaterThan(0); // poll + live refresh pending
      h.widget.uninstall();
      expect(vi.getTimerCount()).toBe(0);
      // Reinstall after uninstall must render (lastRenderKey reset)
      h.widget.install(h.ui, h.theme);
      expect(h.setWidget.mock.calls.length).toBeGreaterThan(0);
    });
  });
});
