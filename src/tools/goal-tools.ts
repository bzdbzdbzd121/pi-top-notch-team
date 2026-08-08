import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionState, isActive } from "../session/state";

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

// ── agent_end reminder handler (safe to register at module init) ─

export function registerGoalAgentHandler(pi: ExtensionAPI): void {
  pi.on("agent_end", async (event, ctx) => {
    // Guard: only fire if a goal exists and is NOT completed
    if (!activeGoal || activeGoal.completed) return;

    // Guard: only fire during an active team session (avoid side effects outside sessions)
    if (!getSessionState().active) return;

    // Guard: if user pressed Esc or typed a new message to abort/redirect,
    // skip the reminder — the signal from the aborted turn is marked as aborted.
    if (ctx.signal?.aborted) return;

    // Guard: cooldown — prevent infinite re-trigger loops
    const now = Date.now();
    if (now - lastReminderSeq < REMINDER_COOLDOWN_MS) return;
    lastReminderSeq = now;

    // Check if TL *already* called finish_goal in this turn (race-safe guard)
    const messages = (event as any).messages ?? [];
    const assistantMsg = messages.findLast?.((m: any) => m?.role === "assistant");
    const content = typeof assistantMsg?.content === "string"
      ? assistantMsg.content
      : Array.isArray(assistantMsg?.content)
        ? (assistantMsg.content as any[]).map((c: any) => c.text ?? "").join("")
        : "";
    if (content.includes("finish_goal")) return;

    // Defer sending to next tick — agent_end fires while agent is still in a
    // processing lifecycle state (pi's isStreaming stays true through the
    // post-agent_end settlement window: listener drain, auto-retry,
    // auto-compaction). deliverAs: "followUp" makes the reminder queue instead
    // of throwing "Agent is already processing..." if the TL agent is still
    // streaming (or already streaming again) when the timer fires; it is
    // ignored when the agent is idle, so the reminder triggers a turn normally.
    // Capture the goal in a local: TS narrowing does not survive the closure.
    const goal = activeGoal;
    if (!goal) return;
    setTimeout(() => {
      pi.sendUserMessage(
        `## ⚡ 目标提醒\n\n` +
        `当前目标 **"${goal.text}"** 尚未完成。\n\n` +
        `**完成条件：**\n${goal.criteria}\n\n` +
        `---\n` +
        `请检查当前进度：\n\n` +
        `1. **如果目标尚未完成** — 继续调度成员执行下一轮任务，直到所有条件满足\n` +
        `2. **如果目标已完成** — 调用 \`finish_goal\` 工具清理此目标\n` +
        `3. **如果遇到不可解决的阻塞问题** — 也调用 \`finish_goal\` 并告知用户情况`,
        { deliverAs: "followUp" }
      );
    }, 0);
  });
}
