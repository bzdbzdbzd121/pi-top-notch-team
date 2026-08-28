import { describe, it, expect, vi, afterEach } from "vitest";
import { startSession, endSession } from "../session/state";
import {
  registerGoalAgentHandler,
  registerGoalTools,
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

async function finishLowLevelReminderRun(
  handlers: Record<string, (event: any, ctx: any) => unknown>,
  prompt: string,
  ctx: any = activeContext(),
) {
  await handlers["agent_start"]({}, ctx);
  await handlers["message_start"](
    {
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    },
    ctx,
  );
  await handlers["agent_end"]({ messages: [] }, ctx);
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

  it("isolates accepted markers from same-session goal replacement", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);
    const oldAckSignal = { aborted: false };

    await finishLowLevelRun(handlers, { messages: [] }, activeContext(oldAckSignal));
    await settleRun(handlers, activeContext(oldAckSignal));
    await flushReminderTimer();
    const oldReminderPrompt = pi.sendUserMessage.mock.calls[0][0];

    // Keep the accepted marker unresolved while only the goal generation
    // changes. The next agent_start must not be evaluated against the new goal.
    resetGoal();
    setGoalForTesting({ text: "replacement goal", criteria: "- replacement", completed: false });
    await handlers["before_agent_start"]({ prompt: oldReminderPrompt }, activeContext());
    await finishLowLevelReminderRun(handlers, oldReminderPrompt);
    await settleRun(handlers);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage.mock.calls[1][0]).toContain("replacement goal");
  });

  it("does not treat an earlier consumed marker as a stale rollover marker", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    // M0 is a normal reminder and is fully consumed before any rollover.
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    const historicalPrompt = pi.sendUserMessage.mock.calls[0][0];
    await handlers["before_agent_start"]({ prompt: historicalPrompt }, activeContext());
    await finishLowLevelReminderRun(handlers, historicalPrompt);
    await settleRun(handlers);
    await flushReminderTimer();

    // Generate M1 after cooldown, then capture only M1 in a goal rollover.
    await vi.advanceTimersByTimeAsync(10_001);
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    resetGoal();
    setGoalForTesting({ text: "replacement goal", criteria: "- replacement", completed: false });

    // M0 is historical and was never captured by this rollover. A pasted or
    // replayed M0 marker must not be widened into a stale-run token.
    const freshContext = {
      signal: { aborted: false },
      isIdle: () => true,
      abort: vi.fn(),
    };
    await handlers["before_agent_start"]({ prompt: historicalPrompt }, freshContext);
    await handlers["agent_start"]({}, freshContext);
    await handlers["message_start"](
      {
        message: {
          role: "user",
          content: [{ type: "text", text: historicalPrompt }],
        },
      },
      freshContext,
    );
    await handlers["agent_end"]({ messages: [] }, freshContext);
    await settleRun(handlers, freshContext);
    await flushReminderTimer();

    expect(freshContext.abort).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
    expect(pi.sendUserMessage.mock.calls[2][0]).toContain("replacement goal");
  });

  it("ignores stale marker text in assistant and tool message_start events", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    const staleReminderPrompt = pi.sendUserMessage.mock.calls[0][0];
    resetGoal();
    setGoalForTesting({ text: "replacement goal", criteria: "- replacement", completed: false });
    await handlers["before_agent_start"]({ prompt: staleReminderPrompt }, activeContext());

    const freshContext = {
      signal: { aborted: false },
      isIdle: () => true,
      abort: vi.fn(),
    };
    await handlers["agent_start"]({}, freshContext);
    await handlers["message_start"](
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "fresh user prompt" }],
        },
      },
      freshContext,
    );
    // The marker is only historical text here; neither response-side event
    // may turn it into a stale prompt or abort the fresh run.
    await handlers["message_start"](
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: `echo ${staleReminderPrompt}` }],
        },
      },
      freshContext,
    );
    await handlers["message_start"](
      {
        message: {
          role: "toolResult",
          content: [{ type: "text", text: `tool output ${staleReminderPrompt}` }],
        },
      },
      freshContext,
    );
    // A later queued user message is also not the run's first user prompt.
    await handlers["message_start"](
      {
        message: {
          role: "user",
          content: [{ type: "text", text: `queued echo ${staleReminderPrompt}` }],
        },
      },
      freshContext,
    );
    await handlers["agent_end"]({ messages: [] }, freshContext);
    await settleRun(handlers, freshContext);
    await flushReminderTimer();

    expect(freshContext.abort).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage.mock.calls[1][0]).toContain("replacement goal");
  });

  it("does not let a stale marker without agent_start swallow the next fresh run", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    const staleReminderPrompt = pi.sendUserMessage.mock.calls[0][0];

    // Rollover the goal while the accepted marker is still unresolved. Then
    // before_agent_start observes the old marker, but the host rejects/aborts
    // that prompt before emitting agent_start. The next real run must not
    // consume the old marker's suppression slot.
    resetGoal();
    setGoalForTesting({ text: "replacement goal", criteria: "- replacement", completed: false });
    const staleContext = {
      signal: { aborted: false },
      isIdle: () => true,
      abort: vi.fn(),
    };
    await handlers["before_agent_start"]({ prompt: staleReminderPrompt }, staleContext);

    const freshContext = activeContext();
    // This direct lifecycle sequence intentionally omits message_start: it
    // mirrors the reviewer repro and proves the provisional slot itself does
    // not swallow the next fresh agent_start/agent_end pair.
    await handlers["agent_start"]({}, freshContext);
    await handlers["agent_end"]({ messages: [] }, freshContext);
    await settleRun(handlers, freshContext);
    await flushReminderTimer();

    expect(staleContext.abort).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendUserMessage.mock.calls[1][0]).toContain("replacement goal");
  });

  it("retains multiple stale markers across two session rollovers", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    // S1 submits M1. Its before_agent_start is intentionally delayed.
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    const markerM1 = pi.sendUserMessage.mock.calls[0][0];

    endSession();
    resetGoal();
    startSession({ name: "test-team-s2", description: "", members: [] } as any, {
      sessionId: "goal-tools-s2",
    });
    setGoalForTesting({ text: "S2 goal", criteria: "- S2", completed: false });

    // A synthetic S2 lifecycle run uses the real handler state machine to
    // submit M2 while M1 is still unresolved. This is the race that a single
    // stale slot cannot represent.
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    const markerM2 = pi.sendUserMessage.mock.calls[1][0];

    endSession();
    resetGoal();
    startSession({ name: "test-team-s3", description: "", members: [] } as any, {
      sessionId: "goal-tools-s3",
    });
    setGoalForTesting({ text: "S3 goal", criteria: "- S3", completed: false });
    await vi.advanceTimersByTimeAsync(10_001);

    // Deliver M1 after M2 was captured by the second rollover. Both old runs
    // must be suppressed; neither may create a candidate for S3.
    await handlers["before_agent_start"]({ prompt: markerM1 }, activeContext());
    await finishLowLevelReminderRun(handlers, markerM1);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);

    await handlers["before_agent_start"]({ prompt: markerM2 }, activeContext());
    await finishLowLevelReminderRun(handlers, markerM2);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);

    // Once both delayed markers/runs are consumed, a genuinely fresh S3 run
    // remains eligible and uses the new goal text.
    await vi.advanceTimersByTimeAsync(10_001);
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
    expect(pi.sendUserMessage.mock.calls[2][0]).toContain("S3 goal");
  });

  it("cleans unresolved markers when the host session shuts down", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    // Leave M1 and M2 unacknowledged across two rollovers. The host session
    // shutdown is the explicit terminal boundary: no old before_agent_start
    // can arrive after the AgentSession has been destroyed.
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    const markerM1 = pi.sendUserMessage.mock.calls[0][0];

    endSession();
    resetGoal();
    startSession({ name: "test-team-s2", description: "", members: [] } as any, {
      sessionId: "goal-tools-cleanup-s2",
    });
    setGoalForTesting({ text: "S2 goal", criteria: "- S2", completed: false });
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    const markerM2 = pi.sendUserMessage.mock.calls[1][0];

    endSession();
    resetGoal();
    startSession({ name: "test-team-s3", description: "", members: [] } as any, {
      sessionId: "goal-tools-cleanup-s3",
    });
    setGoalForTesting({ text: "S3 goal", criteria: "- S3", completed: false });
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);

    const abort = vi.fn();
    await handlers["session_shutdown"]({}, { abort, signal: { aborted: false } });
    // Shutdown cleanup releases the quarantine because the old host prompt is
    // no longer capable of delivering a lifecycle event.
    const postShutdownContext = {
      signal: { aborted: false },
      isIdle: () => true,
      abort,
    };
    await handlers["before_agent_start"]({ prompt: markerM1 }, postShutdownContext);
    await handlers["before_agent_start"]({ prompt: markerM2 }, postShutdownContext);
    expect(abort).not.toHaveBeenCalled();

    // A new session remains fully usable after cleanup.
    endSession();
    resetGoal();
    startSession({ name: "test-team-s4", description: "", members: [] } as any, {
      sessionId: "goal-tools-cleanup-s4",
    });
    setGoalForTesting({ text: "S4 goal", criteria: "- S4", completed: false });
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
    expect(pi.sendUserMessage.mock.calls[2][0]).toContain("S4 goal");
  });

  it("bounds unresolved rollover markers and recovers after host shutdown", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);
    // Tests intentionally share module-level lifecycle state; start this
    // resource test from the same terminal cleanup used by the real host.
    await handlers["session_shutdown"]({}, {});

    // Keep every reminder unacknowledged while repeatedly replacing the team
    // session. The fixed quarantine cap must stop new submissions rather than
    // growing state without bound.
    for (let i = 0; i < 65; i += 1) {
      await finishLowLevelRun(handlers);
      await settleRun(handlers);
      await flushReminderTimer();
      if (i < 64) {
        endSession();
        resetGoal();
        startSession({ name: `test-team-cap-${i + 1}`, description: "", members: [] } as any, {
          sessionId: `goal-tools-cap-${i + 1}`,
        });
        setGoalForTesting({ text: `cap goal ${i + 1}`, criteria: "- cap", completed: false });
      }
    }

    // The 65th candidate is retained, not submitted, once 64 old markers are
    // unresolved. Shutdown is the explicit safe recovery boundary.
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(64);
    await handlers["session_shutdown"]({}, {});

    endSession();
    resetGoal();
    startSession({ name: "test-team-cap-recovered", description: "", members: [] } as any, {
      sessionId: "goal-tools-cap-recovered",
    });
    setGoalForTesting({ text: "recovered goal", criteria: "- recovered", completed: false });
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(65);
    expect(pi.sendUserMessage.mock.calls[64][0]).toContain("recovered goal");
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

  it("does not accept a marker that only shares a numeric prefix", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);
    const reminderPrompt = pi.sendUserMessage.mock.calls[0][0];
    const markerStart = reminderPrompt.indexOf("<!-- top-notch-team:goal-reminder:");
    const markerEnd = reminderPrompt.indexOf(" -->", markerStart);
    const markerWithoutClosing = reminderPrompt.slice(markerStart, markerEnd);
    const prefixCollisionPrompt = `${markerWithoutClosing}0 -->`;

    // First move the request into the uncertain-marker table, then submit a
    // prefix collision. `...:1` must not match `...:10`; match the complete
    // marker including its closing delimiter before the watchdog can be
    // cancelled.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    await handlers["before_agent_start"]({ prompt: prefixCollisionPrompt }, activeContext());

    // A real delayed prompt with the complete marker must still be able to
    // refresh the cooldown, proving the prefix collision did not consume it.
    await vi.advanceTimersByTimeAsync(10_001);
    await handlers["before_agent_start"]({ prompt: reminderPrompt }, activeContext());
    const signal = { aborted: false };
    await handlers["agent_start"]({}, activeContext(signal));
    await handlers["agent_end"]({ messages: [] }, activeContext(signal));
    await settleRun(handlers, activeContext(signal));
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not submit more reminders while an earlier void request remains uncertain", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);
    const firstReminderPrompt = pi.sendUserMessage.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(1_000);

    // Once the first void request is uncertain, lifecycle retries are
    // suppressed rather than evicting its marker to make room for another.
    for (let i = 0; i < 33; i += 1) {
      await vi.advanceTimersByTimeAsync(10_001);
      await finishLowLevelRun(handlers);
      await settleRun(handlers);
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // The original marker remains matchable after more than 32 cooldowns.
    await handlers["before_agent_start"]({ prompt: firstReminderPrompt }, activeContext());
  });

  it("retains a marker beyond the configured lease for unbounded native preflight", async () => {
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

    // Native AgentSession compaction/preflight has no plugin lease bound. Even
    // if autoCompact.timeoutMinutes is one minute, this accepted reminder's
    // marker must remain matchable beyond that setting.
    await vi.advanceTimersByTimeAsync(61_001);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    await handlers["before_agent_start"]({ prompt: reminderPrompt }, activeContext(signal));
    await handlers["agent_start"]({}, activeContext(signal));
    await handlers["agent_end"]({ messages: [] }, activeContext(signal));
    await settleRun(handlers, activeContext(signal));
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
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

    // A slow but accepted reminder may cross both the old 1s watchdog and the
    // 10s reminder cooldown. It must not cause a second reminder once its own
    // prompt is finally observable.
    await vi.advanceTimersByTimeAsync(10_001);
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

  it("anchors cooldown at API submission rather than delayed ACK", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);
    const reminderPrompt = pi.sendUserMessage.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(1_000);

    // ACK after 9s must only clear uncertainty. Its associated reminder run
    // is suppressed once, then the next normal run at t=10s should pass if
    // cooldown remains anchored at the API submission.
    await vi.advanceTimersByTimeAsync(8_000);
    await handlers["before_agent_start"]({ prompt: reminderPrompt }, activeContext());
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(1_001);
    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await vi.advanceTimersByTimeAsync(0);

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

describe("goal tool lifecycle wording", () => {
  it("describes reminders at the fully-settled boundary and in the set_goal result", async () => {
    const { pi } = createMockPi();
    registerGoalTools(pi as any);
    const setGoalDefinition = pi.registerTool.mock.calls.find(
      (call: any[]) => call[0]?.name === "set_goal",
    )?.[0] as any;
    const expected =
      "系统只会在 TL 的一次运行完全结算（不会再自动重试、自动压缩或处理排队续跑）且 Goal 仍处于激活状态（尚未关闭）时提醒你检查进度；`agent_end` 只是中间结束点，不会触发提醒。完成目标后请调用 finish_goal 工具。";

    expect(setGoalDefinition.description).toContain(
      "The system reminds you only after the TL run is fully settled",
    );
    expect(setGoalDefinition.description).toContain("without automatic retry, compaction, or queued continuation");
    expect(setGoalDefinition.promptGuidelines).toContain(expected);

    setupActiveGoal();
    const result = await setGoalDefinition.execute("call-1", {
      text: "完成目标",
      criteria: "- 条件满足",
    });
    expect(result.content[0].text).toContain(expected);
  });
});

describe("reminder prompt content + finish_goal tool", () => {
  it("delivered reminder contains the goal, criteria, and finish_goal-first decision structure", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
    // 目标与完成条件原文随提醒送达
    expect(prompt).toContain("探索全部模块");
    expect(prompt).toContain("- 12 个文件完成");
    // 只描述 Goal 激活状态，不追加对实际验收结果的判断或解释
    expect(prompt).toContain("仍处于激活状态");
    expect(prompt).not.toContain("尚未完成。");
    expect(prompt).not.toContain("不代表验收未完成");
    // 用简洁指令要求 TL 选择唯一匹配分支
    expect(prompt).toContain("执行下列唯一匹配的分支");
    expect(prompt).not.toContain("不得只用文字宣称目标已完成或已阻塞");
    // 完成/阻塞分支前置，需用户输入分支在中，继续调度分支最后
    const finishIdx = prompt.indexOf("如果全部完成条件已满足");
    const blockerIdx = prompt.indexOf("如果遇到不可解决的阻塞问题");
    const askIdx = prompt.indexOf("如果需要用户提供关键信息或做决策才能继续");
    const continueIdx = prompt.indexOf("仅当确有未满足的完成条件");
    expect(finishIdx).toBeGreaterThan(-1);
    expect(blockerIdx).toBeGreaterThan(-1);
    expect(askIdx).toBeGreaterThan(-1);
    expect(continueIdx).toBeGreaterThan(-1);
    expect(finishIdx).toBeLessThan(blockerIdx);
    expect(blockerIdx).toBeLessThan(askIdx);
    expect(askIdx).toBeLessThan(continueIdx);
    // 完成分支调用 finish_goal 且不再派发；需用户输入分支提问等待、不 finish
    expect(prompt).toContain("如果全部完成条件已满足** — 调用 \`finish_goal\` 关闭目标");
    expect(prompt).not.toContain("你的下一个动作必须立即");
    expect(prompt).toContain("不要再派发任务");
    expect(prompt).toContain("提出一个具体问题并等待");
    expect(prompt).toContain("不要调用 \`finish_goal\`");
  });

  it("marker is appended after the visible reminder text without polluting it", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();

    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
    expect(prompt).toMatch(/<!-- top-notch-team:goal-reminder:\d+ -->$/);
    const markerStart = prompt.lastIndexOf("<!-- top-notch-team:goal-reminder:");
    const visible = prompt.slice(0, markerStart).trimEnd();
    expect(visible).toContain("调用 \`finish_goal\` 关闭目标");
    expect(visible).not.toContain("top-notch-team:goal-reminder:");
    expect(visible.endsWith("派发下一轮任务")).toBe(true);
  });

  it("finish_goal definition is distinct from set_goal (snippet + guidelines)", async () => {
    const { pi } = createMockPi();
    registerGoalTools(pi as any);
    const defs = pi.registerTool.mock.calls.map((c: any[]) => c[0]);
    const setGoalDef = defs.find((d: any) => d?.name === "set_goal") as any;
    const finishGoalDef = defs.find((d: any) => d?.name === "finish_goal") as any;

    expect(finishGoalDef.description).toContain(
      "Mark the current goal as completed and stop the reminder system",
    );
    expect(finishGoalDef.description).toContain("unresolvable blocker");
    expect(finishGoalDef.description).toContain("No parameters");
    // snippet 与 set_goal 区分
    expect(finishGoalDef.promptSnippet).not.toBe(setGoalDef.promptSnippet);
    expect(finishGoalDef.promptSnippet).toMatch(/[Ff]inish/);
    expect(setGoalDef.promptSnippet).not.toMatch(/Finish the active goal/);
    // guidelines：精确短语断言（条件满足/阻塞时调用、条件未满足且仍可推进时不得调用、仅口头宣称不算）
    const guidelines = finishGoalDef.promptGuidelines.join("\n");
    expect(guidelines).toContain("the goal's completion criteria are fully met");
    expect(guidelines).toContain("an unresolvable blocker makes the goal impossible");
    expect(guidelines).toContain(
      "Do NOT call finish_goal when completion criteria remain unmet and work can still progress — dispatch the next round of tasks to members instead.",
    );
    expect(guidelines).toContain(
      "Merely claiming in text that the goal is done does not close it; the reminder system only stops after a real finish_goal call.",
    );
    // snippet 精确值
    expect(finishGoalDef.promptSnippet).toBe(
      "Finish the active goal — call when all criteria met or an unresolvable blocker",
    );
    expect(setGoalDef.promptSnippet).toBe("Set a session goal with verifiable completion criteria");
  });

  it("finish_goal execute marks the goal complete and later runs never remind again", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalTools(pi as any);
    registerGoalAgentHandler(pi as any);
    const finishGoalDef = pi.registerTool.mock.calls
      .map((c: any[]) => c[0])
      .find((d: any) => d?.name === "finish_goal") as any;

    const result = await finishGoalDef.execute("call-1", {});
    expect(result.content[0].text).toContain('目标"探索全部模块"已标记为完成');
    expect(result.content[0].text).toContain("提醒机制已停止");
    expect(getGoalState()?.completed).toBe(true);

    await finishLowLevelRun(handlers);
    await settleRun(handlers);
    await flushReminderTimer();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("finish_goal execute cancels an already-pending reminder (finish after settle, before delivery)", async () => {
    vi.useFakeTimers();
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalTools(pi as any);
    registerGoalAgentHandler(pi as any);
    const finishGoalDef = pi.registerTool.mock.calls
      .map((c: any[]) => c[0])
      .find((d: any) => d?.name === "finish_goal") as any;

    await finishLowLevelRun(handlers);
    await settleRun(handlers); // pendingReminder 已就绪，定时器已排
    await finishGoalDef.execute("call-1", {});
    await flushReminderTimer();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("finish_goal execute returns a hint when no goal is active", async () => {
    const { pi } = createMockPi();
    startSession({ name: "test-team", description: "", members: [] } as any);
    registerGoalTools(pi as any);
    const finishGoalDef = pi.registerTool.mock.calls
      .map((c: any[]) => c[0])
      .find((d: any) => d?.name === "finish_goal") as any;

    const result = await finishGoalDef.execute("call-1", {});
    expect(result.content[0].text).toContain("当前没有活跃的目标。");
  });

  it("finish_goal execute is guarded outside an active session", async () => {
    const { pi } = createMockPi();
    registerGoalTools(pi as any);
    const finishGoalDef = pi.registerTool.mock.calls
      .map((c: any[]) => c[0])
      .find((d: any) => d?.name === "finish_goal") as any;

    const result = await finishGoalDef.execute("call-1", {});
    expect(result.content[0].text).toContain("finish_goal 只能在活跃的团队会话中使用。");
  });
});

describe("mid-run session activation (start_team_session flow)", () => {
  it("delivers a reminder when the session was activated mid-run (start_team_session)", async () => {
    vi.useFakeTimers();
    // No session at agent_start — mirrors start_team_session being called as a
    // tool inside the run that also ends without finish_goal.
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const ctx = activeContext();

    await handlers["agent_start"]({}, ctx);

    // start_team_session equivalent: session + goal come into existence mid-run.
    startSession({ name: "test-team", description: "", members: [] } as any, {
      sessionId: "goal-tools-midrun",
    });
    setGoalForTesting({ text: "中途建会话目标", criteria: "- 提醒送达", completed: false });

    await handlers["agent_end"]({ messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await flushReminderTimer();

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("中途建会话目标"));
    expect(pi.sendUserMessage.mock.calls[0][0]).toContain("goal-reminder");
  });

  it("suppresses the reminder-started run after a mid-run activation (no re-remind)", async () => {
    vi.useFakeTimers();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    pi.sendUserMessage.mockImplementation(() => undefined as any);
    const ctx = activeContext();

    await handlers["agent_start"]({}, ctx);
    startSession({ name: "test-team", description: "", members: [] } as any, {
      sessionId: "goal-tools-midrun",
    });
    setGoalForTesting({ text: "中途建会话目标", criteria: "- c", completed: false });
    await handlers["agent_end"]({ messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt = pi.sendUserMessage.mock.calls[0][0] as string;

    // The run started by the reminder must not feed the same goal back in.
    await handlers["before_agent_start"]({ prompt }, ctx);
    await finishLowLevelReminderRun(handlers, prompt, ctx);
    await settleRun(handlers, ctx);
    await flushReminderTimer();
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not remind when the mid-run session is stopped before agent_end", async () => {
    vi.useFakeTimers();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const ctx = activeContext();

    await handlers["agent_start"]({}, ctx);
    startSession({ name: "test-team", description: "", members: [] } as any, {
      sessionId: "goal-tools-midrun-stop",
    });
    setGoalForTesting({ text: "g", criteria: "- c", completed: false });
    endSession();

    await handlers["agent_end"]({ messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("still rejects a run that started in session A when session B replaced it mid-run", async () => {
    vi.useFakeTimers();
    // The run starts while session A is already active — no mid-run activation.
    startSession({ name: "test-team-a", description: "", members: [] } as any, {
      sessionId: "goal-tools-a",
    });
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);
    const ctx = activeContext();

    await handlers["agent_start"]({}, ctx);
    setGoalForTesting({ text: "A goal", criteria: "- c", completed: false });

    // Session A torn down and replaced by B inside the same run. The old run
    // must not migrate into B (rollover protection preserved).
    endSession();
    startSession({ name: "test-team-b", description: "", members: [] } as any, {
      sessionId: "goal-tools-b",
    });
    setGoalForTesting({ text: "B goal", criteria: "- c", completed: false });

    await handlers["agent_end"]({ messages: [] }, ctx);
    await settleRun(handlers, ctx);
    await flushReminderTimer();

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
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
