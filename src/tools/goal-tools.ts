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
let lastReminderSeq = 0;

/**
 * A low-level agent loop can end more than once before the outer AgentSession
 * run is fully settled (for example while retrying, compacting, or draining a
 * queued continuation). Keep that lifecycle separate from the reminder
 * candidate so agent_end only prepares state and agent_settled is the sole
 * trigger for delivery.
 */
interface GoalReminderCandidate {
  runId: number;
  text: string;
  criteria: string;
}

interface GoalReminderRunState {
  runId: number;
  sawAgentEnd: boolean;
  aborted: boolean;
  settled: boolean;
  candidate: GoalReminderCandidate | null;
}

let nextRunId = 0;
let currentRun: GoalReminderRunState | null = null;
let pendingReminder: GoalReminderCandidate | null = null;
let reminderTimer: ReturnType<typeof setTimeout> | null = null;

// ── Public helpers (for tests and index.ts integration) ────

/** Get current goal state snapshot (for testing or display). */
export function getGoalState(): Readonly<GoalState | null> {
  return activeGoal ? { ...activeGoal } : null;
}

/** Reset goal state (for testing or session cleanup). */
export function resetGoal(): void {
  activeGoal = null;
  lastReminderSeq = 0;
}

/** Set goal state for testing. */
export function setGoalForTesting(goal: GoalState): void {
  activeGoal = goal;
}

/**
 * Programmatically set the active goal (resets the reminder cooldown).
 * Used by the set_goal tool and by the start_team_session tool, which
 * auto-seeds the goal from its `task` parameter (ADR-0003).
 */
export function setGoalInternal(text: string, criteria: string): void {
  activeGoal = { text, criteria, completed: false };
  lastReminderSeq = 0;
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
      goal.completed = true;
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
  // agent_start begins (or resumes) an outer AgentSession run. Retry,
  // compaction, and queued continuation starts occur before agent_settled and
  // therefore reuse this state instead of opening a new reminder window.
  pi.on("agent_start", (_event, ctx) => {
    if (!currentRun || currentRun.settled) {
      currentRun = {
        runId: ++nextRunId,
        sawAgentEnd: false,
        aborted: false,
        settled: false,
        candidate: null,
      };
    }
    if (ctx?.signal?.aborted) {
      currentRun.aborted = true;
    }
  });

  // agent_end only records the outcome and a candidate. It is deliberately
  // not a delivery boundary: pi may still retry, compact, or process queued
  // messages after this event and before agent_settled.
  pi.on("agent_end", async (event, ctx) => {
    if (!currentRun || currentRun.settled) {
      // Be tolerant of lightweight callers/tests that emit agent_end without
      // first emitting agent_start. Real AgentSession runs always emit both.
      currentRun = {
        runId: ++nextRunId,
        sawAgentEnd: false,
        aborted: false,
        settled: false,
        candidate: null,
      };
    }
    const run = currentRun;
    run.sawAgentEnd = true;

    // Preserve the existing abort guard at the low-level boundary. The
    // end→settled abort window is part of the follow-up cancellation phase.
    if (ctx?.signal?.aborted) {
      run.aborted = true;
    }

    // Check the structured assistant outcome when it is available. This is
    // intentionally limited to recording the run outcome; agent_settled still
    // owns the decision to schedule delivery.
    const messages = (event as any).messages ?? [];
    const assistantMsg = messages.findLast?.((m: any) => m?.role === "assistant");
    if (assistantMsg?.stopReason === "aborted") {
      run.aborted = true;
    }

    // Guard: only prepare a candidate when a goal exists and is NOT completed.
    if (!activeGoal || activeGoal.completed) return;

    // Guard: only prepare reminders during an active team session.
    if (!getSessionState().active) return;

    // Guard: an aborted low-level end cannot become a reminder candidate.
    if (run.aborted) return;

    // Guard: cooldown — prevent infinite re-trigger loops. The cooldown is
    // intentionally retained at this lifecycle stage; dispatch-time
    // re-accounting belongs to the subsequent race/guard phase.
    const now = Date.now();
    if (now - lastReminderSeq < REMINDER_COOLDOWN_MS) return;
    lastReminderSeq = now;

    // Check if TL *already* called finish_goal in this turn (race-safe guard).
    // The authoritative goal-completion check is retained for the subsequent
    // goal-generation phase; this protects existing behavior in this phase.
    const content = typeof assistantMsg?.content === "string"
      ? assistantMsg.content
      : Array.isArray(assistantMsg?.content)
        ? (assistantMsg.content as any[]).map((c: any) => c.text ?? "").join("")
        : "";
    if (content.includes("finish_goal")) return;

    run.candidate = {
      runId: run.runId,
      text: activeGoal.text,
      criteria: activeGoal.criteria,
    };
  });

  // agent_settled is the only reminder delivery boundary. The one-shot timer
  // merely avoids re-entering pi from inside the settled listener; it does
  // not attempt to infer lifecycle state from a timer tick.
  pi.on("agent_settled", async () => {
    const run = currentRun;
    if (!run || run.settled) return;
    run.settled = true;

    if (!run.sawAgentEnd || run.aborted || !run.candidate) return;

    pendingReminder = run.candidate;
    if (reminderTimer) return;

    reminderTimer = setTimeout(() => {
      reminderTimer = null;
      const candidate = pendingReminder;
      pendingReminder = null;
      if (!candidate) return;

      pi.sendUserMessage(
        `## ⚡ 目标提醒\n\n` +
        `当前目标 **"${candidate.text}"** 尚未完成。\n\n` +
        `**完成条件：**\n${candidate.criteria}\n\n` +
        `---\n` +
        `请检查当前进度：\n\n` +
        `1. **如果目标尚未完成** — 继续调度成员执行下一轮任务，直到所有条件满足\n` +
        `2. **如果目标已完成** — 调用 \`finish_goal\` 工具清理此目标\n` +
        `3. **如果遇到不可解决的阻塞问题** — 也调用 \`finish_goal\` 并告知用户情况`,
      );
    }, 0);
  });
}
