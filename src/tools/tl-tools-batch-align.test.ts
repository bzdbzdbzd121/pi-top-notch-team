import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTlTools, planBatchCompaction } from "./tl-tools";
import type { BatchCompactionPlan } from "./tl-tools";
import { createAutoCompactRuntime } from "../channel/auto-compact";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle } from "../process/member-process";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { TeamMessage } from "../channel/types";
import type { MemberOperationalState } from "../session/context";
import type { ResolvedAutoCompact } from "../settings/resolve-auto-compact";

// ── Test helpers ────────────────────────────────────────────

const defaultCfg: ResolvedAutoCompact = {
  enabled: true,
  thresholdPercent: 80,
  thresholdTokens: undefined,
  timeoutMinutes: 10,
  batchMaxWaitMinutes: 15,
  percentIsDefaultFallback: false,
};

function usageResponse(percent: number, tokens?: number): any {
  return {
    type: "response",
    command: "get_session_stats",
    success: true,
    data: { contextUsage: { percent, tokens, contextWindow: 200000 } },
  };
}

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: vi.fn((def: any) => {
      tools.push(def);
    }),
    getAllTools: vi.fn().mockReturnValue(tools),
    getActiveTools: vi.fn().mockReturnValue(tools.map((t: any) => t.name)),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
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
    setOperationalState: vi.fn(),
    getOperationalState: vi.fn(),
    getOperationalStateMap: vi.fn(() => new Map()),
  };
}

function createMockResponseWaiter(): ResponseWaiter {
  return {
    // Immediately resolve — the all_done path wins the race in waitWithAllIdleCheck.
    waitForResponse: vi.fn().mockResolvedValue({ status: "response", from: "x", content: "done" }),
    resolveIfWaiting: vi.fn().mockReturnValue(false),
    cancelAll: vi.fn(),
    cancelByCorrId: vi.fn(),
    clearCorrelation: vi.fn(),
  };
}

interface HandleBehavior {
  stats?: () => any;
  compact?: () => any;
}

function createMemberHandle(name: string, order: string[], behavior: HandleBehavior = {}): MemberProcessHandle {
  return {
    name,
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => ({ name, pid: 1, status: "running" as const })),
    onEvent: vi.fn(),
    sendCommand: vi.fn((_cmd: any) => {
      order.push(`prompt:${name}`);
    }),
    sendCommandAndWait: vi.fn((cmd: any) => {
      if (cmd.type === "get_session_stats") {
        order.push(`stats:${name}`);
        return Promise.resolve(behavior.stats ? behavior.stats() : usageResponse(10, 1000));
      }
      if (cmd.type === "compact") {
        order.push(`compact:${name}`);
        return Promise.resolve(
          behavior.compact ? behavior.compact() : { type: "response", command: "compact", success: true, data: {} }
        );
      }
      return Promise.reject(new Error("unexpected command"));
    }),
  } as unknown as MemberProcessHandle;
}

interface SetupOptions {
  cfg?: ResolvedAutoCompact;
  states?: Record<string, MemberOperationalState>;
  /** Map member name → handle behavior. Members absent here get NO handle (getHandle → undefined). */
  handles?: Record<string, HandleBehavior>;
  /** Extra deps to inject. */
  deps?: Record<string, any>;
}

function setupBarrier(opts: SetupOptions = {}) {
  const order: string[] = [];
  const pi = createMockPi();
  const memberOpsStates = new Map<string, MemberOperationalState>();
  for (const [k, v] of Object.entries(opts.states ?? {})) memberOpsStates.set(k, v);
  const handles = new Map<string, MemberProcessHandle>();
  for (const [k, v] of Object.entries(opts.handles ?? {})) handles.set(k, createMemberHandle(k, order, v));
  const responseWaiter = createMockResponseWaiter();
  const messageQueue = createMockMessageQueue(order);
  const lastPendingCorrId = new Map<string, string>();

  let executeFn: Function = () => {};
  pi.registerTool = vi.fn((def: any) => {
    if (def.name === "team_send_and_wait") {
      executeFn = def.execute;
    }
  });

  registerTlTools({
    pi,
    manager: createMockManager(),
    responseWaiter,
    memberOpsStates,
    lastPendingCorrId,
    messageQueue,
    getAutoCompact: () => opts.cfg ?? defaultCfg,
    getHandle: (name: string) => handles.get(name),
    autoCompact: createAutoCompactRuntime(memberOpsStates),
    ...opts.deps,
  });

  return { executeFn, order, pi, memberOpsStates, messageQueue, lastPendingCorrId, handles };
}

function createMockMessageQueue(order: string[]): MessageQueue {
  return {
    enqueue: vi.fn((msg: TeamMessage) => {
      order.push(`enqueue:${msg.to}`);
    }),
    length: vi.fn().mockReturnValue(0),
    drain: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
}

/** Enqueued payloads for a given target, in order. */
function enqueuedFor(queue: MessageQueue, to: string): TeamMessage[] {
  return (queue.enqueue as ReturnType<typeof vi.fn>).mock.calls
    .map((c: any[]) => c[0] as TeamMessage)
    .filter((m) => m.to === to);
}

// ── planBatchCompaction (pure function) ────────────────────

describe("planBatchCompaction", () => {
  it("classifies idle members into toQuery", () => {
    const plan = planBatchCompaction(["a", "b"], (n) => (n === "a" ? "idle" : "idle"), defaultCfg);
    expect(plan).toEqual({ toQuery: ["a", "b"], toWait: [], skip: [] });
  });

  it("classifies compacting members into toWait (never re-compact, E3)", () => {
    const plan = planBatchCompaction(["a", "b"], (n) => (n === "a" ? "compacting" : "idle"), defaultCfg);
    expect(plan.toWait).toEqual(["a"]);
    expect(plan.toQuery).toEqual(["b"]);
  });

  it("classifies working/crashed/stopped members into skip", () => {
    const states: Record<string, MemberOperationalState> = { a: "working", b: "crashed", c: "stopped" };
    const plan = planBatchCompaction(
      ["a", "b", "c", "d"],
      (n) => states[n] ?? "idle",
      defaultCfg
    );
    expect(plan).toEqual({ toQuery: ["d"], toWait: [], skip: ["a", "b", "c"] });
  });

  it("treats members with no recorded state as idle", () => {
    const plan = planBatchCompaction(["a"], () => "idle", defaultCfg);
    expect(plan.toQuery).toEqual(["a"]);
  });

  it("handles an empty target set", () => {
    const plan = planBatchCompaction([], () => "idle", defaultCfg);
    expect(plan).toEqual({ toQuery: [], toWait: [], skip: [] });
  });
});

// ── Batch alignment barrier (via team_send_and_wait execute) ──

describe("team_send_and_wait batch barrier (phase 3)", () => {
  let order: string[];
  let pi: ExtensionAPI;
  let memberOpsStates: Map<string, MemberOperationalState>;
  let messageQueue: MessageQueue;
  let lastPendingCorrId: Map<string, string>;
  let executeFn: Function;
  let setup: ReturnType<typeof setupBarrier>;

  beforeEach(() => {
    vi.useRealTimers();
    setup = setupBarrier();
    ({ executeFn, order, pi, memberOpsStates, messageQueue, lastPendingCorrId } = setup);
  });

  it("orders: B's prompt dispatch never precedes A's compact completion (call-order array)", async () => {
    // A over threshold (needs compaction), B below threshold (no compaction).
    // Barrier: stats A+B in parallel → compact A → COMMIT enqueue A+B.
    setup = setupBarrier({
      states: { a: "idle", b: "idle" },
      handles: {
        a: { stats: () => usageResponse(95, 190000) },
        b: { stats: () => usageResponse(50, 100000) },
      },
    });
    ({ executeFn, order, pi, memberOpsStates, messageQueue, lastPendingCorrId } = setup);

    await executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    // Strict call-order assertion (no sleeps): every prompt enqueue happens
    // AFTER a's compaction finished; b is never prompted before a is compacted.
    expect(order).toEqual(["stats:a", "stats:b", "compact:a", "enqueue:a", "enqueue:b"]);
  });

  it("compacts serially when both members are over threshold (B's compact never precedes A's)", async () => {
    setup = setupBarrier({
      states: { a: "idle", b: "idle" },
      handles: {
        a: { stats: () => usageResponse(95, 190000) },
        b: { stats: () => usageResponse(90, 180000) },
      },
    });
    ({ executeFn, order } = setup);

    await executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    // stats run in parallel, compactions strictly serial (at most one compact
    // RPC at a time — no PD separation, concurrent prefill is the problem).
    expect(order).toEqual(["stats:a", "stats:b", "compact:a", "compact:b", "enqueue:a", "enqueue:b"]);
  });

  it("invariant E1: messageQueue stays empty until ALL compactions complete", async () => {
    let resolveCompactA: (v: any) => void;
    const compactAPromise = new Promise((r) => { resolveCompactA = r; });
    setup = setupBarrier({
      states: { a: "idle", b: "idle" },
      handles: {
        a: { stats: () => usageResponse(95, 190000), compact: () => compactAPromise },
        b: { stats: () => usageResponse(90, 180000) },
      },
    });
    ({ executeFn, order, messageQueue } = setup);

    const execPromise = executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });
    await vi.waitFor(() => expect(order).toContain("compact:a"));

    // Mid-compaction: NOTHING may be enqueued yet (all-idle can never fire
    // early — the wait logic starts only after the barrier commits).
    expect(order.filter((e) => e.startsWith("enqueue:"))).toEqual([]);

    resolveCompactA!({ type: "response", command: "compact", success: true, data: {} });
    await execPromise;

    expect(order).toEqual(["stats:a", "stats:b", "compact:a", "compact:b", "enqueue:a", "enqueue:b"]);
  });

  it("per-member fail-open: a failed compaction still dispatches (with skip), others continue compacting", async () => {
    setup = setupBarrier({
      states: { a: "idle", b: "idle" },
      handles: {
        a: { stats: () => usageResponse(95, 190000), compact: () => ({ type: "response", command: "compact", success: false, error: "boom" }) },
        b: { stats: () => usageResponse(90, 180000) },
      },
    });
    ({ executeFn, order, pi, memberOpsStates, messageQueue } = setup);

    await executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    // Both members attempted a compaction → both messages carry the marker.
    // B still gets compacted after A's failure (D1: per-member fail-open).
    expect(order).toEqual(["stats:a", "stats:b", "compact:a", "compact:b", "enqueue:a", "enqueue:b"]);
    expect(enqueuedFor(messageQueue, "a")[0].skipAutoCompact).toBe(true);
    expect(enqueuedFor(messageQueue, "b")[0].skipAutoCompact).toBe(true);
    // Failure notification + start notification, both visible to TL
    const notices = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0].content as string);
    expect(notices.some((n) => n.includes("[批屏障]") && n.includes("需自动压缩"))).toBe(true);
    expect(notices.some((n) => n.includes("[批屏障]") && n.includes("压缩失败") && n.includes("a"))).toBe(true);
    // finally-reset invariant: both members back to idle after the barrier
    expect(memberOpsStates.get("a")).toBe("idle");
    expect(memberOpsStates.get("b")).toBe("idle");
  });

  it("notifies ONCE when all compactions succeed (start notice only, success silent)", async () => {
    setup = setupBarrier({
      states: { a: "idle", b: "idle" },
      handles: { a: { stats: () => usageResponse(95, 190000) } },
    });
    ({ executeFn, pi } = setup);

    await executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    const notices = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0].content as string);
    const barrierNotices = notices.filter((n) => n.includes("[批屏障]"));
    expect(barrierNotices).toHaveLength(1);
    expect(barrierNotices[0]).toContain("需自动压缩");
    expect(barrierNotices[0]).toContain("a");
  });

  it("maxWait budget exceeded: stops remaining compactions, un-attempted member gets NO skip", async () => {
    vi.useFakeTimers();
    try {
      let resolveCompactA: (v: any) => void;
      const compactAPromise = new Promise((r) => { resolveCompactA = r; });
      setup = setupBarrier({
        cfg: { ...defaultCfg, batchMaxWaitMinutes: 1 }, // 1-minute total budget
        states: { a: "idle", b: "idle" },
        handles: {
          a: { stats: () => usageResponse(95, 190000), compact: () => compactAPromise },
          b: { stats: () => usageResponse(90, 180000) },
        },
      });
      ({ executeFn, order, pi, messageQueue } = setup);

      const execPromise = executeFn("call-1", {
        tasks: [
          { to: "a", content: "task-a" },
          { to: "b", content: "task-b" },
        ],
        nextSteps: "next",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["stats:a", "stats:b", "compact:a"]); // b not compacted yet

      // A's compaction eats the whole budget
      await vi.advanceTimersByTimeAsync(61_000);
      resolveCompactA!({ type: "response", command: "compact", success: true, data: {} });
      await vi.advanceTimersByTimeAsync(0);
      await execPromise;

      // B never compacted → B's message carries NO skip (inline path gets a
      // second chance naturally). A attempted → skip.
      expect(order.filter((e) => e.startsWith("compact:"))).toEqual(["compact:a"]);
      expect(enqueuedFor(messageQueue, "a")[0].skipAutoCompact).toBe(true);
      expect(enqueuedFor(messageQueue, "b")[0].skipAutoCompact).toBeUndefined();
      const notices = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0].content as string);
      expect(notices.some((n) => n.includes("[批屏障]") && n.includes("超预算"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a compacting member to reach idle instead of re-compacting (E3), then aligns", async () => {
    vi.useFakeTimers();
    try {
      setup = setupBarrier({
        states: { a: "compacting", b: "idle" }, // a: inline compaction already in flight
        handles: { b: { stats: () => usageResponse(95, 190000) } },
      });
      ({ executeFn, order, memberOpsStates, messageQueue } = setup);

      const execPromise = executeFn("call-1", {
        tasks: [
          { to: "a", content: "task-a" },
          { to: "b", content: "task-b" },
        ],
        nextSteps: "next",
      });
      await vi.advanceTimersByTimeAsync(0);

      // a is compacting → NO stats/compact for a; the barrier waits (1s poll)
      expect(order).toEqual([]);

      // a's in-flight compaction finishes (simulated by the inline path resetting state)
      memberOpsStates.set("a", "idle");
      await vi.advanceTimersByTimeAsync(1000);
      await execPromise;

      // b compacted (over threshold); both enqueued only after a is idle;
      // a never re-compacted and carries no skip (not attempted by the barrier)
      expect(order).toEqual(["stats:b", "compact:b", "enqueue:a", "enqueue:b"]);
      expect(enqueuedFor(messageQueue, "a")[0].skipAutoCompact).toBeUndefined();
      expect(enqueuedFor(messageQueue, "b")[0].skipAutoCompact).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes same-member multi-tasks: one stats query + one compaction for the member", async () => {
    setup = setupBarrier({
      states: { a: "idle", b: "idle" },
      handles: {
        a: { stats: () => usageResponse(95, 190000) },
        b: { stats: () => usageResponse(50, 100000) },
      },
    });
    ({ executeFn, order, messageQueue } = setup);

    await executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a1" },
        { to: "a", content: "task-a2" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    expect(order.filter((e) => e === "stats:a")).toHaveLength(1);
    expect(order.filter((e) => e === "compact:a")).toHaveLength(1);
    // both a-tasks carry the marker (a attempted)
    expect(enqueuedFor(messageQueue, "a").map((m) => m.skipAutoCompact)).toEqual([true, true]);
    expect(enqueuedFor(messageQueue, "b")[0].skipAutoCompact).toBeUndefined();
  });

  it("single-task path: zero pre-check (no stats), message carries NO marker", async () => {
    setup = setupBarrier({
      states: { a: "idle" },
      handles: { a: { stats: () => usageResponse(95, 190000) } },
    });
    ({ executeFn, order, messageQueue } = setup);

    await executeFn("call-1", {
      tasks: [{ to: "a", content: "task-a" }],
      nextSteps: "next",
    });

    expect(order).toEqual(["enqueue:a"]);
    expect(enqueuedFor(messageQueue, "a")[0].skipAutoCompact).toBeUndefined();
  });

  it("disabled auto-compaction: zero pre-check even for batches", async () => {
    setup = setupBarrier({
      cfg: { ...defaultCfg, enabled: false },
      states: { a: "idle", b: "idle" },
      handles: { a: { stats: () => usageResponse(95, 190000) } },
    });
    ({ executeFn, order, messageQueue } = setup);

    await executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    expect(order).toEqual(["enqueue:a", "enqueue:b"]);
    expect(enqueuedFor(messageQueue, "a")[0].skipAutoCompact).toBeUndefined();
    expect(enqueuedFor(messageQueue, "b")[0].skipAutoCompact).toBeUndefined();
  });

  it("to:\"all\" entries are rejected by existing validation — broadcasts are not batch semantics (E13)", async () => {
    setup = setupBarrier({
      states: { a: "idle" },
      handles: { a: { stats: () => usageResponse(95, 190000) } },
    });
    ({ executeFn, order, messageQueue } = setup);

    const result = await executeFn("call-1", {
      tasks: [
        { to: "all", content: "broadcast" },
        { to: "a", content: "task-a" },
      ],
      nextSteps: "next",
    });

    // "all" is not a member — the existing unknown-target validation rejects
    // the batch BEFORE any barrier work: zero pre-check, zero enqueue. The
    // barrier never sees broadcast entries (they are filtered out of the
    // explicit target set by construction).
    expect(order).toEqual([]);
    expect(result.content[0].text).toContain("不存在或未启动");
    expect(messageQueue.enqueue).not.toHaveBeenCalled();
  });

  it("member with no handle is skipped by the barrier (fail-open), others proceed", async () => {
    setup = setupBarrier({
      states: { a: "idle", b: "idle" },
      handles: { b: { stats: () => usageResponse(95, 190000) } }, // a has NO handle
    });
    ({ executeFn, order, messageQueue } = setup);

    await executeFn("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    expect(order.filter((e) => e.startsWith("stats:"))).toEqual(["stats:b"]);
    expect(enqueuedFor(messageQueue, "a")[0].skipAutoCompact).toBeUndefined();
    expect(enqueuedFor(messageQueue, "b")[0].skipAutoCompact).toBe(true);
  });

  it("non-barrier paths produce NO marked messages (summarizer hard requirement)", async () => {
    // Legacy call without DI (no getAutoCompact/getHandle/autoCompact): batch
    // messages must go through the exact legacy path — no marker anywhere.
    const orderLegacy: string[] = [];
    const piLegacy = createMockPi();
    const states = new Map<string, MemberOperationalState>([["a", "idle"], ["b", "idle"]]);
    let execLegacy: Function = () => {};
    piLegacy.registerTool = vi.fn((def: any) => {
      if (def.name === "team_send_and_wait") execLegacy = def.execute;
    });
    const mqLegacy = createMockMessageQueue(orderLegacy);
    registerTlTools({
      pi: piLegacy,
      manager: createMockManager(),
      responseWaiter: createMockResponseWaiter(),
      memberOpsStates: states,
      lastPendingCorrId: new Map<string, string>(),
      messageQueue: mqLegacy,
      // NOTE: no getAutoCompact / getHandle / autoCompact
    });

    await execLegacy("call-1", {
      tasks: [
        { to: "a", content: "task-a" },
        { to: "b", content: "task-b" },
      ],
      nextSteps: "next",
    });

    expect(orderLegacy).toEqual(["enqueue:a", "enqueue:b"]);
    expect(enqueuedFor(mqLegacy, "a")[0].skipAutoCompact).toBeUndefined();
    expect(enqueuedFor(mqLegacy, "b")[0].skipAutoCompact).toBeUndefined();
  });
});
