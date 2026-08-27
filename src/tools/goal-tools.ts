import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionState, isActive } from "../session/state";
import { syncActiveManifest } from "../session/manifest";

// ── Types ──────────────────────────────────────────────────

export interface GoalState {
  /** 目标描述（一句概括） */
  text: string;
  /** 完成条件（多条可验证条件，供 TL 逐条对照） */
  criteria: string;
  /** 是否已完成 */
  completed: boolean;
}

// ── Module-level state ─────────────────────────────────────

let activeGoal: GoalState | null = null;

/** Cooldown between consecutive reminders (ms). Prevents infinite re-trigger loops. */
const REMINDER_COOLDOWN_MS = 10_000;

/**
 * A low-level agent loop can end more than once before the outer AgentSession
 * run is fully settled (for example while retrying, compacting, or draining a
 * queued continuation). Keep that lifecycle separate from the reminder
 * candidate so agent_end only prepares state and agent_settled is the sole
 * trigger for delivery.
 */
interface GoalReminderCandidate {
  /** Outer run that produced the candidate. */
  runId: number;
  /** Session identity captured with the candidate. */
  sessionId: string | null;
  /** Goal identity captured with the candidate. */
  goalGeneration: number;
  text: string;
  criteria: string;
}

interface GoalReminderRunState {
  runId: number;
  sawAgentEnd: boolean;
  aborted: boolean;
  settled: boolean;
  /** Captured low-level signal remains observable through the end→settled window. */
  signal: unknown;
  candidate: GoalReminderCandidate | null;
}

interface LastReminder {
  sessionId: string | null;
  goalGeneration: number;
  at: number;
}

let nextRunId = 0;
let goalGeneration = 0;
let currentRun: GoalReminderRunState | null = null;
let pendingReminder: GoalReminderCandidate | null = null;
let reminderTimer: ReturnType<typeof setTimeout> | null = null;
let lastReminder: LastReminder | null = null;

function clearReminderTimer(): void {
  if (reminderTimer !== null) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
}

/** Invalidate all reminder state without changing the active goal itself. */
function invalidateReminderState(resetRun = false): void {
  clearReminderTimer();
  pendingReminder = null;
  if (currentRun) {
    currentRun.candidate = null;
  }
  if (resetRun) {
    currentRun = null;
  }
}

function advanceGoalGeneration(resetRun = false): void {
  goalGeneration += 1;
  lastReminder = null;
  invalidateReminderState(resetRun);
}

function readSignal(ctx: unknown): unknown {
  try {
    return (ctx as { signal?: unknown } | null | undefined)?.signal;
  } catch {
    // A stale ExtensionContext can throw from its guarded getters. Treat the
    // signal as unavailable here; dispatch performs an independent fail-closed
    // context check before sending.
    return undefined;
  }
}

function signalAborted(signal: unknown): boolean {
  if (!signal) return false;
  try {
    return (signal as { aborted?: unknown }).aborted === true;
  } catch {
    // A captured signal should not normally throw, but never send a reminder
    // when its cancellation state cannot be read safely.
    return true;
  }
}

function createRun(ctx: unknown): GoalReminderRunState {
  const signal = readSignal(ctx);
  return {
    runId: ++nextRunId,
    sawAgentEnd: false,
    aborted: signalAborted(signal),
    settled: false,
    signal,
    candidate: null,
  };
}

function ensureRun(ctx: unknown): GoalReminderRunState {
  if (!currentRun || currentRun.settled) {
    // A new outer run supersedes a timer from the previous one. Keep a
    // still-valid pending candidate for a later settled event, but never let
    // the old timer race the new run.
    if (currentRun?.settled) {
      clearReminderTimer();
    }
    currentRun = createRun(ctx);
  } else {
    const signal = readSignal(ctx);
    if (signal !== undefined) {
      currentRun.signal = signal;
      if (signalAborted(signal)) {
        currentRun.aborted = true;
      }
    }
  }
  return currentRun;
}

function currentSessionIdentity(): { active: boolean; sessionId: string | null } | null {
  try {
    const session = getSessionState();
    return { active: session.active, sessionId: session.sessionId };
  } catch {
    return null;
  }
}

function candidateMatchesCurrentGoal(candidate: GoalReminderCandidate): boolean {
  const session = currentSessionIdentity();
  if (!session || !session.active || session.sessionId !== candidate.sessionId) {
    return false;
  }
  return Boolean(
    activeGoal &&
    !activeGoal.completed &&
    goalGeneration === candidate.goalGeneration
  );
}

function readContextSignalState(ctx: unknown): { readable: boolean; aborted: boolean } {
  try {
    const signal = (ctx as { signal?: unknown } | null | undefined)?.signal;
    return { readable: true, aborted: signalAborted(signal) };
  } catch {
    return { readable: false, aborted: true };
  }
}

function contextIsIdle(ctx: unknown): { readable: boolean; idle: boolean } {
  try {
    const isIdle = (ctx as { isIdle?: unknown } | null | undefined)?.isIdle;
    if (typeof isIdle !== "function") {
      return { readable: false, idle: false };
    }
    return { readable: true, idle: (isIdle as () => unknown)() === true };
  } catch {
    return { readable: false, idle: false };
  }
}

function buildReminderText(candidate: GoalReminderCandidate): string {
  return (
    `## ⚡ 目标提醒\n\n` +
    `当前目标 **"${candidate.text}"** 尚未完成。\n\n` +
    `**完成条件：**\n${candidate.criteria}\n\n` +
    `---\n` +
    `请检查当前进度：\n\n` +
    `1. **如果目标尚未完成** — 继续调度成员执行下一轮任务，直到所有条件满足\n` +
    `2. **如果目标已完成** — 调用 \`finish_goal\` 工具清理此目标\n` +
    `3. **如果遇到不可解决的阻塞问题** — 也调用 \`finish_goal\` 并告知用户情况`
  );
}

function sendReminderSafely(pi: ExtensionAPI, text: string): void {
  try {
    // pi 0.83.0 types this API as void, while adapters/mocks may return a
    // Promise. Handle both forms so a busy-race rejection cannot escape as an
    // unhandled rejection.
    const result = (pi.sendUserMessage as unknown as (content: string) => unknown)(text);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {
        // Fire-and-forget submission: the candidate was consumed at the API
        // boundary, and a later run will be responsible for a new reminder.
      });
    }
  } catch {
    // A new run can begin between the idle check and this call. Do not retry
    // with followUp: that would reintroduce the original premature-trigger
    // behavior. The failed request is intentionally fail-closed.
  }
}

// ── Public helpers (for tests and index.ts integration) ────

/** Get current goal state snapshot (for testing or display). */
export function getGoalState(): Readonly<GoalState | null> {
  return activeGoal ? { ...activeGoal } : null;
}

/** Reset goal state (for testing or session cleanup). */
export function resetGoal(): void {
  activeGoal = null;
  advanceGoalGeneration(true);
}

/** Set goal state for testing. */
export function setGoalForTesting(goal: GoalState): void {
  advanceGoalGeneration();
  activeGoal = goal;
}

/**
 * Programmatically set the active goal (resets the reminder cooldown).
 * Used by the set_goal tool and by the start_team_session tool, which
 * auto-seeds the goal from its `task` parameter (ADR-0003).
 */
export function setGoalInternal(text: string, criteria: string): void {
  advanceGoalGeneration();
  activeGoal = { text, criteria, completed: false };
}

// ── Prompt snippet for TL tools ────────────────────────────

const GOAL_PROMPT_SNIPPET = "Set/finish a session goal to track overall objective";

// ── Goal tool names (for setActiveTools lifecycle) ───────

export const GOAL_TOOL_NAMES = ["set_goal", "finish_goal"];

// ── Register goal tools (called on-demand at session start) ─

export function registerGoalTools(pi: ExtensionAPI): void {
  // ── set_goal ────────────────────────────────────────────
  pi.registerTool({
    name: "set_goal",
    label: "Set Goal",
    description:
      "Set a session goal with completion criteria. " +
      "Call this at the start of a task so the system can remind you if you stop before the goal is met. " +
      "The goal must include concrete, verifiable completion criteria so you can check progress against it. " +
      "Parameters: text (goal summary), criteria (completion conditions).",
    promptGuidelines: [
      "Use set_goal at the start of a team session to define what success looks like.",
      "Write concrete, verifiable completion criteria — not vague aspirations.",
      "Example: { text: '探索 module_a 的全部文件', criteria: '- module_a 的 12 个文件全部完成探索\\n- 所有裁决报告已合并\\n- 所有写入已通过 validate.py 校验' }",
      "After setting the goal, if you stop and try to ask the user for permission, the system will remind you to check the goal first.",
    ],
    promptSnippet: GOAL_PROMPT_SNIPPET,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Goal summary (e.g. '探索 module_a 的全部文件')",
        },
        criteria: {
          type: "string",
          description: "Verifiable completion criteria, one per line, for checking progress against the goal",
        },
      },
      required: ["text", "criteria"],
    },
    async execute(
      _toolCallId: string,
      params: { text: string; criteria: string }
    ): Promise<{ details: Record<string, unknown>; content: Array<{ type: "text"; text: string }> }> {
      // Guard: only available during active team sessions
      if (!isActive()) {
        return {
          details: {},
          content: [{ type: "text" as const, text: "set_goal 只能在活跃的团队会话中使用。请先通过 /team start 或 /team dynamic 启动团队会话。" }],
        };
      }

      setGoalInternal(params.text, params.criteria);
      // Persist into the session manifest so the goal survives TL restarts.
      syncActiveManifest({ goal: { text: params.text, criteria: params.criteria } });
      return {
        details: { goal: params.text },
        content: [
          {
            type: "text" as const,
            text: `目标已设定：${params.text}\n完成条件：\n${params.criteria}\n\n系统将在你停止时提醒你检查目标进度。完成目标后请调用 finish_goal 工具。`,
          },
        ],
      };
    },
  });

  // ── finish_goal ─────────────────────────────────────────
  pi.registerTool({
    name: "finish_goal",
    label: "Finish Goal",
    description:
      "Mark the current goal as completed and stop the reminder system. " +
      "Call this when the goal criteria are all met, or when an unresolvable blocker is encountered. " +
      "No parameters.",
    promptGuidelines: [
      "Call finish_goal when the goal's completion criteria are fully met or when an unresolvable blocker makes the goal impossible.",
    ],
    promptSnippet: GOAL_PROMPT_SNIPPET,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(): Promise<{ details: Record<string, unknown>; content: Array<{ type: "text"; text: string }> }> {
      // Guard: only available during active team sessions
      if (!isActive()) {
        return {
          details: {},
          content: [{ type: "text" as const, text: "finish_goal 只能在活跃的团队会话中使用。" }],
        };
      }

      const goal = activeGoal;
      if (!goal) {
        return {
          details: {},
          content: [{ type: "text" as const, text: "当前没有活跃的目标。" }],
        };
      }
      // Mark completion before invalidating reminder state so a candidate
      // already prepared by agent_end cannot survive the finish operation.
      goal.completed = true;
      advanceGoalGeneration();
      // Clear the goal from the persisted manifest (completed goals don't resume).
      syncActiveManifest({ goal: null });
      return {
        details: { goal: goal.text, completed: true },
        content: [
          {
            type: "text" as const,
            text: `目标"${goal.text}"已标记为完成。提醒机制已停止。`,
          },
        ],
      };
    },
  });

}

// ── Agent lifecycle reminder handler (safe to register at module init) ─

export function registerGoalAgentHandler(pi: ExtensionAPI): void {
  const scheduleReminder = (ctx: unknown): void => {
    if (reminderTimer !== null) return;

    reminderTimer = setTimeout(() => {
      reminderTimer = null;
      const candidate = pendingReminder;
      if (!candidate) return;

      // Re-check every identity at dispatch time. A finish_goal call, session
      // teardown, or replacement goal may have invalidated this candidate
      // after agent_end and before this timer executes.
      if (!candidateMatchesCurrentGoal(candidate)) {
        pendingReminder = null;
        return;
      }

      const run = currentRun;
      if (!run || run.runId !== candidate.runId) {
        // A newer run may have started before this tick. Keep the candidate
        // for that run's eventual settled event, but never send into a busy
        // run or revive a run that has already settled.
        if (run && !run.settled && !run.aborted) return;
        pendingReminder = null;
        return;
      }
      if (!run.sawAgentEnd || !run.settled || run.aborted || signalAborted(run.signal)) {
        pendingReminder = null;
        return;
      }

      const settledSignal = readContextSignalState(ctx);
      if (!settledSignal.readable || settledSignal.aborted) {
        pendingReminder = null;
        return;
      }

      // The timer is only a re-entry barrier. It must not enqueue a reminder
      // into a new active run; only an idle TL may receive a normal prompt.
      const idle = contextIsIdle(ctx);
      if (!idle.readable) {
        pendingReminder = null;
        return;
      }
      if (!idle.idle) {
        // Preserve the candidate. A later settled event can retry it without
        // using followUp (which would hide the lifecycle race).
        return;
      }

      // isIdle() is user/context code and can itself trigger a new run. Close
      // that unavoidable check→send race by validating the run again.
      if (currentRun !== run) {
        if (currentRun && !currentRun.settled && !currentRun.aborted) return;
        pendingReminder = null;
        return;
      }

      // Re-read identity and cancellation state after the idle callback too:
      // the check itself is synchronous user/context code and can cause a
      // goal/session transition or observe an abort in the same turn.
      if (
        !candidateMatchesCurrentGoal(candidate) ||
        run.aborted ||
        signalAborted(run.signal)
      ) {
        pendingReminder = null;
        return;
      }
      const postIdleSignal = readContextSignalState(ctx);
      if (!postIdleSignal.readable || postIdleSignal.aborted) {
        pendingReminder = null;
        return;
      }

      const now = Date.now();
      if (
        lastReminder &&
        lastReminder.sessionId === candidate.sessionId &&
        lastReminder.goalGeneration === candidate.goalGeneration &&
        now - lastReminder.at < REMINDER_COOLDOWN_MS
      ) {
        // A candidate that loses the cooldown is consumed; a later run after
        // the cooldown expires can produce a fresh candidate.
        pendingReminder = null;
        return;
      }

      // Clear pending before the API call so a synchronous re-entry cannot
      // schedule/submit this candidate a second time. The API has no
      // observable synchronous delivery result, so this is the submission
      // point used for cooldown accounting.
      pendingReminder = null;
      lastReminder = {
        sessionId: candidate.sessionId,
        goalGeneration: candidate.goalGeneration,
        at: now,
      };
      sendReminderSafely(pi, buildReminderText(candidate));
    }, 0);
  };

  // agent_start begins (or resumes) an outer AgentSession run. Retry,
  // compaction, and queued continuation starts occur before agent_settled and
  // therefore reuse this state instead of opening a new reminder window.
  pi.on("agent_start", (_event, ctx) => {
    const run = ensureRun(ctx);
    if (run.aborted) {
      pendingReminder = null;
    }
  });

  // agent_end only records the outcome and a candidate. It is deliberately
  // not a delivery boundary: pi may still retry, compact, or process queued
  // messages after this event and before agent_settled.
  pi.on("agent_end", async (event, ctx) => {
    const run = ensureRun(ctx);
    run.sawAgentEnd = true;

    const signal = readSignal(ctx);
    if (signal !== undefined) {
      run.signal = signal;
      if (signalAborted(signal)) {
        run.aborted = true;
      }
    }

    // Record structured cancellation from the final assistant message. An
    // abort signal can also flip after this callback, so dispatch re-checks the
    // captured signal rather than relying on this snapshot alone.
    const messages = (event as any).messages ?? [];
    const assistantMsg = messages.findLast?.((m: any) => m?.role === "assistant");
    if (assistantMsg?.stopReason === "aborted") {
      run.aborted = true;
    }

    // Guard: only prepare a candidate when a goal exists and is NOT completed.
    if (!activeGoal || activeGoal.completed) {
      pendingReminder = null;
      return;
    }

    const session = currentSessionIdentity();
    if (!session || !session.active) {
      pendingReminder = null;
      return;
    }

    // Guard: an aborted low-level end cannot become a reminder candidate.
    if (run.aborted) {
      pendingReminder = null;
      return;
    }

    run.candidate = {
      runId: run.runId,
      sessionId: session.sessionId,
      goalGeneration,
      text: activeGoal.text,
      criteria: activeGoal.criteria,
    };
  });

  // agent_settled is the only reminder delivery boundary. The one-shot timer
  // merely avoids re-entering pi from inside the settled listener; it does
  // not attempt to infer lifecycle state from a timer tick.
  pi.on("agent_settled", async (_event, ctx) => {
    const run = currentRun;
    if (!run) return;

    const settledSignal = readContextSignalState(ctx);
    if (settledSignal.aborted || signalAborted(run.signal)) {
      run.aborted = true;
    }
    // Mark the outer run settled even when it was aborted. Otherwise a later
    // legitimate agent_start would be mistaken for the same aborted run and
    // could never produce a fresh candidate.
    run.settled = true;
    if (run.aborted) {
      run.candidate = null;
      pendingReminder = null;
      return;
    }

    if (!run.sawAgentEnd) return;

    // Transfer the latest candidate to the single pending slot. If a previous
    // timer observed a busy TL, rebind its still-valid candidate to this
    // settled run so a later settled event can safely consume it.
    const candidate = run.candidate;
    run.candidate = null;
    if (candidate) {
      if (!candidateMatchesCurrentGoal(candidate)) {
        pendingReminder = null;
        return;
      }
      pendingReminder = candidate;
    } else if (pendingReminder) {
      if (!candidateMatchesCurrentGoal(pendingReminder)) {
        pendingReminder = null;
        return;
      }
      pendingReminder = { ...pendingReminder, runId: run.runId };
    }

    if (pendingReminder) {
      scheduleReminder(ctx);
    }
  });
}
