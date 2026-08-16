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

function createTeamMember(name: string, label: string): TeamMember {
  return { name, label, systemPrompt: `You are ${name}` };
}

/**
 * Integration harness: tracker + widget wired exactly like the index.ts
 * multi-cast (tracker.onEvent → process-death delete (P3) → widget.onMemberEvent).
 * The logical layer (memberOpsStates) is driven by the test to simulate the
 * event-handler's state machine updates.
 */
function createHarness(options: {
  members: TeamMember[];
  opsStates: Record<string, MemberOperationalState>;
  teamCtx?: any;
}) {
  const tracker = createActivityTracker();
  const setWidget = vi.fn();
  let lastLines: string[] | null = null;
  setWidget.mockImplementation((key: string, content: any) => {
    if (key === "team-status") lastLines = content;
  });
  const ui = { setWidget };
  const theme = createMockTheme();
  const memberOpsStates = new Map<string, MemberOperationalState>(
    Object.entries(options.opsStates)
  );

  // Late import so the pi-tui mock is registered first.
  let widget: any;
  const getWidget = async () => {
    if (!widget) {
      const mod = await import("./team-status-widget");
      widget = mod.createTeamStatusWidget({
        teamName: "test-team",
        getMembers: () => options.members,
        teamCtx: options.teamCtx ?? createMockTeamCtx(),
        memberOpsStates,
        activityTracker: tracker,
      });
    }
    return widget;
  };

  const emit = (name: string, event: any) => {
    tracker.onEvent(name, event);
    if (event?.type === "process_exit" || event?.type === "process_error") {
      tracker.delete(name);
    }
    widget?.onMemberEvent(name, event);
  };

  return {
    tracker,
    setWidget,
    ui,
    theme,
    memberOpsStates,
    emit,
    getWidget,
    middle: () => lastLines?.[1] ?? "",
  };
}

// ── Integration tests ──────────────────────────────────────

describe("team-status-widget integration (tracker → widget live path)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("live render flow: thinking → executing → output → idle via mock RPC events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = createHarness({
      members: [createTeamMember("coder", "编码员")],
      opsStates: { coder: "working" },
    });
    const widget = await h.getWidget();
    widget.install(h.ui, h.theme);
    await vi.advanceTimersByTimeAsync(0);
    h.setWidget.mockClear();

    h.emit("coder", { type: "agent_start" });
    h.emit("coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.middle()).toContain("💭");

    h.emit("coder", { type: "tool_execution_start", toolName: "bash -c make" });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.middle()).toContain("⚙️");
    expect(h.middle()).toContain("bash -…");

    h.emit("coder", { type: "message_update", assistantMessageEvent: { type: "text_delta" } });
    h.emit("coder", { type: "tool_execution_end" });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.middle()).toContain("📤");

    h.emit("coder", { type: "agent_end" });
    h.memberOpsStates.set("coder", "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.middle()).toContain("✅");
  });

  it("P3: process_exit deletes the tracker entry — a crash during executing must not stick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = createHarness({
      members: [createTeamMember("coder", "编码员")],
      opsStates: { coder: "working" },
    });
    const widget = await h.getWidget();
    widget.install(h.ui, h.theme);
    await vi.advanceTimersByTimeAsync(0);

    h.emit("coder", { type: "agent_start" });
    h.emit("coder", { type: "tool_execution_start", toolName: "bash -c make" });
    expect(h.tracker.getActivity("coder")?.phase).toBe("executing");

    // Event-handler updates the logical layer, then the P3 delete runs.
    h.memberOpsStates.set("coder", "crashed");
    h.emit("coder", { type: "process_exit", memberName: "coder", exitCode: 1, wasRunning: true });
    expect(h.tracker.getActivity("coder")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(300);
    expect(h.middle()).toContain("💥");
    expect(h.middle()).not.toContain("⚙️");
  });

  it("N2: 15s poll keeps duration/pct moving during event-less periods; 30s staleness closes the anti-stuck loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const statsHandle = {
      sendCommandAndWait: vi.fn().mockResolvedValue({
        data: { contextUsage: { percent: 45, tokens: 10, contextWindow: 100 } },
      }),
    };
    const teamCtx = { ...createMockTeamCtx(), getHandle: () => statsHandle };
    const h = createHarness({
      members: [createTeamMember("coder", "编码员")],
      opsStates: { coder: "working" },
      teamCtx,
    });
    const widget = await h.getWidget();
    widget.install(h.ui, h.theme);
    await vi.advanceTimersByTimeAsync(0); // install-time initial query settles

    h.emit("coder", { type: "agent_start" });
    h.emit("coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
    await vi.advanceTimersByTimeAsync(300);
    h.setWidget.mockClear();

    // 15s later the active poll fires → duration text + pct updated (N2: poll
    // completion keeps refresh(); the render-side gate only skips no-change).
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.setWidget.mock.calls.length).toBeGreaterThan(0);
    expect(h.middle()).toContain("💭");
    expect(h.middle()).toContain("15s");
    expect(h.middle()).toContain("45%");

    // t≈30000 — exactly at the staleness boundary: still thinking.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.middle()).toContain("💭");

    // t≈45000 — 30s+ since the last delta: lazy staleness downgrades to working.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.middle()).toContain("🔧");
    expect(h.middle()).not.toContain("💭");
  });

  it("N3: parallel stats polling — one poll bounded by max timeout, not 3N", async () => {
    vi.useRealTimers();
    const members = Array.from({ length: 8 }, (_, i) => createTeamMember(`m${i + 1}`, `成员${i + 1}`));
    const handles = members.map(() => ({
      sendCommandAndWait: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("timeout")), 350);
          })
      ),
    }));
    const teamCtx = {
      ...createMockTeamCtx(),
      getHandle: (name: string) => handles[members.findIndex((m) => m.name === name)],
    };
    const h = createHarness({
      members,
      opsStates: Object.fromEntries(members.map((m) => [m.name, "working"])),
      teamCtx,
    });
    const widget = await h.getWidget();
    const t0 = performance.now();
    widget.install(h.ui, h.theme);
    // All 8 queries run in parallel; wait until they have all settled (~350ms).
    await vi.waitFor(() => {
      expect(handles.every((hd) => hd.sendCommandAndWait.mock.calls.length === 1)).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 100)); // allSettled continuation + refresh
    const elapsed = performance.now() - t0;
    // Serial worst case would be 8×350ms = 2.8s; parallel is bounded by the
    // max timeout (~350ms) — the ≤3s worst-case bound follows from max semantics.
    expect(elapsed).toBeLessThan(1500);
    widget.uninstall();
  });

  it("N6: 8-member × 500-event storm — setWidget bounded ≤100, tracker path < 50ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const members = Array.from({ length: 8 }, (_, i) => createTeamMember(`m${i + 1}`, `成员${i + 1}`));
    const h = createHarness({
      members,
      opsStates: Object.fromEntries(members.map((m) => [m.name, "working"])),
    });
    const widget = await h.getWidget();
    widget.install(h.ui, h.theme);
    await vi.advanceTimersByTimeAsync(0);
    h.setWidget.mockClear();

    const pool = [
      { type: "agent_start" },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } },
      { type: "tool_execution_start", toolName: "bash -c make -j8 all" },
      { type: "tool_execution_update", toolName: "bash -c make -j8 all" },
      { type: "tool_execution_end" },
      { type: "agent_end" },
    ];

    // Phase 1: pure tracker load — the O(1) event path (N5/N6 hard bound).
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      const e = pool[i % pool.length];
      for (const m of members) h.tracker.onEvent(m.name, e);
    }
    const trackerMs = performance.now() - t0;

    // Phase 2: the same storm through the full path (tracker + widget scheduling).
    for (let i = 0; i < 500; i++) {
      const e = pool[i % pool.length];
      for (const m of members) h.emit(m.name, e);
    }
    await vi.advanceTimersByTimeAsync(3000);

    expect(h.setWidget.mock.calls.length).toBeLessThanOrEqual(100);
    expect(trackerMs).toBeLessThan(50);
    // eslint-disable-next-line no-console
    console.log(
      `[N6] 4000 events: tracker ${trackerMs.toFixed(1)}ms (${(trackerMs / 4000 * 1000).toFixed(2)}µs/ev), setWidget ${h.setWidget.mock.calls.length}`
    );
  });

  it("N6: 'content unchanged never renders' + 'content changed always renders' (semantic pair)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = createHarness({
      members: [createTeamMember("coder", "编码员")],
      opsStates: { coder: "working" },
    });
    const widget = await h.getWidget();
    widget.install(h.ui, h.theme);
    await vi.advanceTimersByTimeAsync(0);

    // Change → renders (idle ✅ → thinking 💭)
    h.setWidget.mockClear();
    h.emit("coder", { type: "agent_start" });
    h.emit("coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.setWidget.mock.calls.length).toBeGreaterThan(0);
    expect(h.middle()).toContain("💭");

    // Unchanged → never renders (100 same-phase deltas, same second)
    h.setWidget.mockClear();
    for (let i = 0; i < 100; i++) {
      h.emit("coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.setWidget).not.toHaveBeenCalled();

    // Change → renders again (⚙️ executing)
    h.emit("coder", { type: "tool_execution_start", toolName: "bash -c make" });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.setWidget.mock.calls.length).toBe(1);
    expect(h.middle()).toContain("⚙️");
  });

  it("N6: uninstall leaves no timers behind (poll + live refresh + inflight abort)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = createHarness({
      members: [createTeamMember("coder", "编码员")],
      opsStates: { coder: "working" },
    });
    const widget = await h.getWidget();
    widget.install(h.ui, h.theme);
    await vi.advanceTimersByTimeAsync(0);
    h.emit("coder", { type: "agent_start" });
    h.emit("coder", { type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
    expect(vi.getTimerCount()).toBeGreaterThan(0); // poll (15s) + live flush pending
    widget.uninstall();
    expect(vi.getTimerCount()).toBe(0);
    // Uninstall-during-poll must not reschedule: re-advance a full poll period.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("N6: single-frame build cost measured and recorded (doRender-side 留档)", async () => {
    vi.useRealTimers();
    const h = createHarness({
      members: [createTeamMember("coder", "编码员")],
      opsStates: { coder: "working" },
    });
    const widget = await h.getWidget();
    widget.install(h.ui, h.theme);
    h.emit("coder", { type: "agent_start" });

    // Warm-up (allocations, module-level lazies)
    for (let i = 0; i < 50; i++) {
      h.tracker.onEvent("coder", { type: "tool_execution_start", toolName: `tool-${i}` });
      widget.refresh();
    }
    const N = 500;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      h.tracker.onEvent("coder", { type: "tool_execution_start", toolName: `tool-${i}` });
      widget.refresh();
    }
    const perFrameMs = (performance.now() - t0) / N;
    // eslint-disable-next-line no-console
    console.log(`[N6-bench] buildDisplay+setWidget: ${(perFrameMs * 1000).toFixed(1)} µs/frame (N=${N})`);
    // Loose safety bound — the measured value is ~µs; the real doRender full
    // screen pass happens upstream of setWidget and is recorded in DESIGN.md.
    expect(perFrameMs).toBeLessThan(5);
    widget.uninstall();
  });
});
