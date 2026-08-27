import { describe, it, expect, vi, afterEach } from "vitest";
import { startSession, endSession } from "../session/state";
import {
  registerGoalAgentHandler,
  setGoalForTesting,
  resetGoal,
  getGoalState,
} from "./goal-tools";

// ── Test helpers ───────────────────────────────────────────

function createMockPi() {
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  const pi = {
    on: vi.fn((event: string, cb: (event: any, ctx: any) => unknown) => {
      handlers[event] = cb;
    }),
    sendUserMessage: vi.fn(),
    registerTool: vi.fn(),
  };
  return { pi, handlers };
}

function setupActiveGoal() {
  startSession({ name: "test-team", description: "", members: [] } as any);
  setGoalForTesting({ text: "探索全部模块", criteria: "- 12 个文件完成", completed: false });
}

function activeContext(
  signal?: { aborted?: boolean },
  isIdle: () => boolean = () => true,
) {
  return { signal, isIdle };
}

async function finishLowLevelRun(
  handlers: Record<string, (event: any, ctx: any) => unknown>,
  event: any = { messages: [] },
  ctx: any = activeContext(),
) {
  await handlers["agent_start"]({}, ctx);
  await handlers["agent_end"](event, ctx);
}

async function settleRun(
  handlers: Record<string, (event: any, ctx: any) => unknown>,
  ctx: any = activeContext(),
) {
  await handlers["agent_settled"]({}, ctx);
}

async function flushReminderTimer() {
  await vi.runAllTimersAsync();
}

afterEach(() => {
  endSession();
  resetGoal();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registerGoalAgentHandler reminder", () => {
  it("does not send from agent_end before the outer run is settled", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("sends once after agent_end followed by agent_settled, without followUp delivery", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    // The settled listener uses one timer tick only to avoid re-entering the
    // lifecycle listener; it is not the lifecycle boundary itself.
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("目标提醒"));
    expect(pi.sendUserMessage.mock.calls[0]).toHaveLength(1);
  });

  it("waits through retry/compaction/queued continuation ends and sends once after the final settled event", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    // A single outer run can contain several low-level starts/ends while pi
    // handles retry, compaction, or a queued continuation.
    await finishLowLevelRun(handlers);
    await flushReminderTimer();
    await finishLowLevelRun(handlers);
    await flushReminderTimer();
    await finishLowLevelRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not send a reminder when there is no active goal", async () => {
    vi.useFakeTimers();
    startSession({ name: "test-team", description: "", members: [] } as any);
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send a reminder when the goal is completed", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    setGoalForTesting({ text: "g", criteria: "c", completed: true });
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send a reminder outside an active team session", async () => {
    vi.useFakeTimers();
    setGoalForTesting({ text: "g", criteria: "c", completed: false });
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send a reminder when the turn was aborted (Esc)", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const ctx = activeContext({ aborted: true });

    await finishLowLevelRun(handlers, { messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not treat a plain finish_goal text mention as goal completion", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(
      handlers,
      {
        messages: [
          { role: "assistant", content: "目标已完成，调用 finish_goal 清理。" },
        ],
      },
    );
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not send a candidate when the goal is completed before settlement", async () => {
    vi.useFakeTimers();
    startSession({ name: "test-team", description: "", members: [] } as any);
    const goal = { text: "g", criteria: "c", completed: false };
    setGoalForTesting(goal);
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    // Model the authoritative finish_goal state update in the settlement
    // window without clearing the candidate, proving the final goal guard is
    // independent of cleanup performed by finish_goal itself.
    goal.completed = true;
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send after the session is stopped before settlement", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    // Keep the candidate alive to exercise the settled/timer session guard;
    // teardown's resetGoal path is covered separately below.
    endSession();
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("cancels a scheduled reminder when the goal is reset after settlement", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    resetGoal();
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send when the abort signal changes after agent_end", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const signal = { aborted: false };
    const ctx = activeContext(signal);

    await finishLowLevelRun(handlers, { messages: [] }, ctx);
    signal.aborted = true;
    await settleRun(handlers, ctx);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("starts a fresh reminder run after an aborted settled run", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const abortedSignal = { aborted: true };

    await finishLowLevelRun(handlers, { messages: [] }, activeContext(abortedSignal));
    await settleRun(handlers, activeContext(abortedSignal));
    await flushReminderTimer();

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not send or use followUp while the TL is busy, then retries a pending reminder on settlement", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    let idle = false;
    const ctx = activeContext(undefined, () => idle);

    await finishLowLevelRun(handlers, { messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    idle = true;
    await settleRun(handlers, ctx);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0]).toHaveLength(1);
  });

  it("fails closed when the settled context is stale and isIdle throws", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const ctx = activeContext(undefined, () => {
      throw new Error("stale context");
    });

    await finishLowLevelRun(handlers, { messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await expect(flushReminderTimer()).resolves.toBeUndefined();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("swallows synchronous and asynchronous sendUserMessage failures", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage
      .mockImplementationOnce(() => {
        throw new Error("busy race");
      })
      .mockImplementationOnce(() => Promise.reject(new Error("transport failure")));

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await expect(flushReminderTimer()).resolves.toBeUndefined();
    await Promise.resolve();

    vi.advanceTimersByTime(10_001);
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await expect(flushReminderTimer()).resolves.toBeUndefined();
    await Promise.resolve();

    // Both failed submits are handled; no synchronous exception or unhandled
    // rejection escapes the lifecycle callback.
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("respects the reminder cooldown across settled runs", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    // A second outer run immediately after the first is still within the
    // existing ten-second cooldown.
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

describe("goal state helpers", () => {
  it("setGoalForTesting / getGoalState / resetGoal round-trip", () => {
    setGoalForTesting({ text: "g", criteria: "c", completed: false });
    expect(getGoalState()).toEqual({ text: "g", criteria: "c", completed: false });
    resetGoal();
    expect(getGoalState()).toBeNull();
  });
});
