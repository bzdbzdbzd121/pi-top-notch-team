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

afterEach(() => {
  endSession();
  resetGoal();
  vi.restoreAllMocks();
});

describe("registerGoalAgentHandler reminder", () => {
  it("should send the reminder with deliverAs followUp so it queues when the TL agent is streaming", async () => {
    // Regression: the reminder fires from an agent_end handler via setTimeout(0).
    // agent_end fires while pi's isStreaming is still true (post-run settlement
    // window); without deliverAs, sendUserMessage throws
    // "Agent is already processing..." and the reminder is lost.
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await handlers["agent_end"]({ messages: [] }, { signal: undefined });
    // Reminder is deferred via setTimeout(0)
    await new Promise((r) => setTimeout(r, 10));

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("目标提醒"),
      { deliverAs: "followUp" }
    );
  });

  it("should not send a reminder when there is no active goal", async () => {
    startSession({ name: "test-team", description: "", members: [] } as any);
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await handlers["agent_end"]({ messages: [] }, { signal: undefined });
    await new Promise((r) => setTimeout(r, 10));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("should not send a reminder when the goal is completed", async () => {
    setupActiveGoal();
    setGoalForTesting({ text: "g", criteria: "c", completed: true });
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await handlers["agent_end"]({ messages: [] }, { signal: undefined });
    await new Promise((r) => setTimeout(r, 10));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("should not send a reminder outside an active team session", async () => {
    // Goal set but session ended
    setGoalForTesting({ text: "g", criteria: "c", completed: false });
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await handlers["agent_end"]({ messages: [] }, { signal: undefined });
    await new Promise((r) => setTimeout(r, 10));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("should not send a reminder when the turn was aborted (Esc)", async () => {
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await handlers["agent_end"]({ messages: [] }, { signal: { aborted: true } });
    await new Promise((r) => setTimeout(r, 10));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("should not send a reminder if finish_goal was already called this turn", async () => {
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await handlers["agent_end"](
      {
        messages: [
          { role: "assistant", content: "目标已完成，调用 finish_goal 清理。" },
        ],
      },
      { signal: undefined }
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("should respect the reminder cooldown", async () => {
    setupActiveGoal();
    const { pi, handlers } = createMockPi();
    registerGoalAgentHandler(pi as any);

    await handlers["agent_end"]({ messages: [] }, { signal: undefined });
    await new Promise((r) => setTimeout(r, 10));
    // Second agent_end immediately after — within the 10s cooldown window
    await handlers["agent_end"]({ messages: [] }, { signal: undefined });
    await new Promise((r) => setTimeout(r, 10));

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
