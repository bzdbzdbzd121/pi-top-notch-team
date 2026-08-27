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
    // Most tests use an injected observable sender. A dedicated test below
    // models pi 0.83.0's real fire-and-forget wrapper, which returns void.
    sendUserMessage: vi.fn((_content: string) => Promise.resolve()),
    sendMessage: vi.fn(),
    registerTool: vi.fn(),
  };
  return { pi, handlers };
}

function setupActiveGoal() {
  startSession({ name: "test-team", description: "", members: [] } as any);
  setGoalForTesting({ text: "探索全部模块", criteria: "- 12 个文件完成", completed: false });
}

function activeContext(
  signal: { aborted?: boolean } | undefined = { aborted: false },
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

  it("does not send when an earlier low-level signal aborts after a healthy continuation signal", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const signalA = { aborted: false };
    const signalB = { aborted: false };

    // Pi may create one AbortController for each low-level prompt/continue.
    await finishLowLevelRun(handlers, { messages: [] }, activeContext(signalA));
    await finishLowLevelRun(handlers, { messages: [] }, activeContext(signalB));
    signalA.aborted = true;
    await settleRun(handlers, activeContext(signalB));
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not let a reset run's late agent_end create a reminder in a new session", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const oldSignal = { aborted: false };

    await finishLowLevelRun(handlers, { messages: [] }, activeContext(oldSignal));
    // /team stop/session shutdown resets the reminder run while the old TL
    // process may still emit its delayed agent_end.
    resetGoal();
    startSession({ name: "new-team", description: "", members: [] } as any);
    setGoalForTesting({ text: "new goal", criteria: "new criteria", completed: false });

    await handlers["agent_end"]({ messages: [] }, activeContext(oldSignal));
    await settleRun(handlers, activeContext({ aborted: false }));
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("blocks an unknown reset-time continuation until the old outer run settles", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const oldSignal = { aborted: false };
    const continuationSignal = { aborted: false };
    const freshSignal = { aborted: false };

    await finishLowLevelRun(handlers, { messages: [] }, activeContext(oldSignal));
    resetGoal();
    startSession({ name: "new-team", description: "", members: [] } as any);
    setGoalForTesting({ text: "new goal", criteria: "new criteria", completed: false });

    // This start/end pair belongs to the old outer run but uses a controller
    // first observed after reset. It must be blocked by the lifecycle barrier.
    await handlers["agent_start"]({}, activeContext(continuationSignal));
    await handlers["agent_end"]({ messages: [] }, activeContext(continuationSignal));
    await settleRun(handlers, activeContext(continuationSignal));
    await flushReminderTimer();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // Once the old outer run's settled event has crossed the barrier, a truly
    // fresh run is allowed to produce the new-session reminder.
    await handlers["agent_start"]({}, activeContext(freshSignal));
    await handlers["agent_end"]({ messages: [] }, activeContext(freshSignal));
    await settleRun(handlers, activeContext(freshSignal));
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("new goal"));
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
    const ctx = activeContext({ aborted: false }, () => idle);

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
    const ctx = activeContext({ aborted: false }, () => {
      throw new Error("stale context");
    });

    await finishLowLevelRun(handlers, { messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await expect(flushReminderTimer()).resolves.toBeUndefined();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("restores a candidate after an asynchronous send failure for a later settled retry", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementationOnce(() => Promise.reject(new Error("transport failure")));

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    await Promise.resolve();

    // The failed Promise must clear its cooldown and leave one candidate for
    // the next settled boundary rather than silently losing the reminder.
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-message",
        content: expect.stringContaining("目标提醒提交失败"),
        display: true,
      }),
    );
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("surfaces an unobservable fire-and-forget send without silently losing the reminder", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    // This is the actual pi 0.83.0 ExtensionAPI shape: the underlying async
    // failure is caught inside agent-session.js and the wrapper returns void.
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // No matching before_agent_start means the void API cannot be confirmed.
    // The bounded fallback makes that uncertainty visible without restoring
    // the candidate (which could duplicate an accepted-but-delayed request).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "team-message",
        content: expect.stringContaining("目标提醒未确认"),
        display: true,
      }),
    );
  });

  it("does not treat an unrelated agent_start as a fire-and-forget acknowledgement", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);
    const reminderPrompt = pi.sendUserMessage.mock.calls[0][0];

    // A normal run can start while pi's internal async preflight is still in
    // flight. Its agent_start has no prompt and must not cancel this attempt.
    const unrelatedSignal = { aborted: false };
    await handlers["agent_start"]({}, activeContext(unrelatedSignal));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("目标提醒未确认"),
      }),
    );
    expect(reminderPrompt).toContain("top-notch-team:goal-reminder:");
    unrelatedSignal.aborted = true;
    await handlers["agent_end"]({ messages: [] }, activeContext(unrelatedSignal));
    await settleRun(handlers, activeContext(unrelatedSignal));
  });

  it("correlates a delayed fire-and-forget acknowledgement by before_agent_start prompt", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);
    const signal = { aborted: false };

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);
    const reminderPrompt = pi.sendUserMessage.mock.calls[0][0];

    // A slow but accepted reminder may cross the old 1s watchdog. It must not
    // cause a second reminder once its own prompt is finally observable.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    await handlers["before_agent_start"]({ prompt: reminderPrompt }, activeContext(signal));
    await handlers["agent_start"]({}, activeContext(signal));
    await handlers["agent_end"]({ messages: [] }, activeContext(signal));
    await settleRun(handlers, activeContext(signal));
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not let a late observable result clear a newer void submission watchdog", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    let resolveFirst!: () => void;
    const firstResult = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    pi.sendUserMessage
      .mockImplementationOnce(() => firstResult)
      .mockImplementationOnce(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // Let the first observable request remain unresolved until a later
    // reminder attempt has armed its own fire-and-forget watchdog.
    vi.advanceTimersByTime(10_001);
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);

    resolveFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("目标提醒未确认"),
      }),
    );
  });

  it("swallows synchronous and asynchronous sendUserMessage failures", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementationOnce(() => {
      throw new Error("busy race");
    });

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await expect(flushReminderTimer()).resolves.toBeUndefined();

    // The failed submit is handled and retained for a later settled boundary;
    // no synchronous exception escapes the lifecycle callback.
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
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
