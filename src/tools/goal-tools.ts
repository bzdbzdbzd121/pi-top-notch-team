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
  /** Session/lifecycle epoch captured with the candidate. */
  sessionEpoch: number;
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
  /** Suppress the candidate produced by the run started by a reminder. */
  suppressReminderCandidate: boolean;
  /** Every low-level prompt/continue signal seen in this outer run. */
  signals: Set<unknown>;
  /** Session identity captured when this outer run started. */
  sessionId: string | null;
  sessionEpoch: number;
  candidate: GoalReminderCandidate | null;
}

interface LastReminder {
  sessionId: string | null;
  goalGeneration: number;
  at: number;
}

/**
 * A reset can happen while the old outer run is still in post-agent_end
 * processing. No new run may be accepted until that old run emits its
 * agent_settled boundary; otherwise an unseen continuation signal could be
 * mistaken for a fresh run in the replacement session.
 */
interface ResetBarrier {
  runId: number;
}

interface ReminderSubmission {
  candidate: GoalReminderCandidate;
  /** Complete prompt marker carried through before_agent_start for correlation. */
  marker: string;
  watchdog: ReturnType<typeof setTimeout>;
}

interface ReminderAcknowledgement {
  candidate: GoalReminderCandidate;
  marker: string;
}

interface StaleRolloverSubmission extends ReminderAcknowledgement {
  /** The marker has reached before_agent_start and its next run is stale. */
  markerSeen: boolean;
}

interface UncertainSubmission {
  candidate: GoalReminderCandidate;
}

/** pi 0.83.0's sendUserMessage wrapper returns void; bound the no-ack fallback. */
const REMINDER_SUBMISSION_ACK_TIMEOUT_MS = 1_000;
const REMINDER_MARKER_PREFIX = "<!-- top-notch-team:goal-reminder:";
const REMINDER_MARKER_SUFFIX = " -->";

let nextRunId = 0;
let goalGeneration = 0;
let sessionEpoch = 0;
let observedSessionKey: string | null = null;
let currentRun: GoalReminderRunState | null = null;
let pendingReminder: GoalReminderCandidate | null = null;
let reminderTimer: ReturnType<typeof setTimeout> | null = null;
let lastReminder: LastReminder | null = null;
/** After reset, an agent_start must establish a new outer run before end events are accepted. */
let awaitingFreshRun = false;
let freshRunRequiresSignal = false;
let resetBarrier: ResetBarrier | null = null;
let pendingSubmission: ReminderSubmission | null = null;
let acknowledgedSubmission: ReminderAcknowledgement | null = null;
let staleRolloverSubmission: StaleRolloverSubmission | null = null;
/**
 * Timed-out void submissions remain matchable by their complete marker until
 * acknowledgement or goal/session reset. The dispatch gate below permits only
 * one uncertain submission, so this lifecycle-bound map cannot grow without
 * bound and no legal in-flight acknowledgement is evicted.
 */
const uncertainSubmissions = new Map<string, UncertainSubmission>();
let nextSubmissionId = 0;
/** Signal identities from invalidated runs; objects are weakly held to avoid unbounded growth. */
const invalidatedSignalObjects = new WeakSet<object>();

function clearReminderTimer(): void {
  if (reminderTimer !== null) {
    clearTimeout(reminderTimer);
    reminderTimer = null;
  }
}

function clearPendingSubmission(): void {
  if (pendingSubmission !== null) {
    clearTimeout(pendingSubmission.watchdog);
    pendingSubmission = null;
  }
}

/** Clear an in-flight submission; rollover handling may retain its stale marker. */
function clearSubmissionState(preserveStaleRollover = false): void {
  clearPendingSubmission();
  uncertainSubmissions.clear();
  acknowledgedSubmission = null;
  if (!preserveStaleRollover) {
    staleRolloverSubmission = null;
  }
}

function clearPendingSubmissionForMarker(marker: string): void {
  if (pendingSubmission?.marker === marker) {
    clearPendingSubmission();
  }
}

/** Invalidate all reminder state without changing the active goal itself. */
function invalidateReminderState(resetRun = false): void {
  clearReminderTimer();
  // A session rollover may have captured an accepted old marker just before a
  // goal replacement/reset. Preserve that stale marker until its host run is
  // rejected; ordinary same-session goal changes have no marker to preserve.
  clearSubmissionState(staleRolloverSubmission !== null);
  pendingReminder = null;
  if (currentRun) {
    currentRun.candidate = null;
  }
  if (resetRun) {
    // Keep signal identities as tombstones: an old agent_end can arrive after
    // /team stop and a new session starts, but it must not be reinterpreted as
    // a run belonging to that new session.
    const runToInvalidate = currentRun && !currentRun.settled ? currentRun : null;
    freshRunRequiresSignal = Boolean(runToInvalidate && runToInvalidate.signals.size > 0);
    if (runToInvalidate) {
      tombstoneRun(runToInvalidate);
      resetBarrier = { runId: runToInvalidate.runId };
    }
    currentRun = null;
    awaitingFreshRun = true;
    sessionEpoch += 1;
  }
}

function advanceGoalGeneration(resetRun = false): void {
  // Detect a TeamSession rollover before goal replacement clears submission
  // state; otherwise an accepted old prompt could be reinterpreted under the
  // new goal when startSession/endSession happen between lifecycle callbacks.
  currentSessionIdentity();
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

function sessionKey(session: { active: boolean; sessionId: string | null }): string {
  return session.active ? `active:${session.sessionId ?? "<none>"}` : "inactive";
}

function currentSessionIdentity(): { active: boolean; sessionId: string | null } | null {
  try {
    const session = getSessionState();
    const key = sessionKey(session);
    if (key !== observedSessionKey) {
      observedSessionKey = key;
      sessionEpoch += 1;
      // A session switch invalidates any fire-and-forget acknowledgement from
      // the previous session; never let its marker acknowledge new work. Keep
      // the marker separately until before_agent_start/agent_start so an
      // already accepted old reminder cannot become a candidate for the new
      // session. If no marker arrives, a genuinely new run is unaffected.
      const staleSubmission = pendingSubmission
        ? { candidate: pendingSubmission.candidate, marker: pendingSubmission.marker }
        : uncertainSubmissions.size > 0
          ? (() => {
              const first = uncertainSubmissions.entries().next().value as
                | [string, UncertainSubmission]
                | undefined;
              return first ? { candidate: first[1].candidate, marker: first[0] } : null;
            })()
          : acknowledgedSubmission
            ? { candidate: acknowledgedSubmission.candidate, marker: acknowledgedSubmission.marker }
            : null;
      clearSubmissionState(true);
      staleRolloverSubmission = staleSubmission
        ? { ...staleSubmission, markerSeen: false }
        : null;
    }
    return { active: session.active, sessionId: session.sessionId };
  } catch {
    return null;
  }
}

function hasSignal(signal: unknown): boolean {
  return signal !== undefined && signal !== null;
}

function runWasAborted(run: GoalReminderRunState): boolean {
  if (run.aborted) return true;
  for (const signal of run.signals) {
    if (signalAborted(signal)) return true;
  }
  return false;
}

function tombstoneSignal(signal: unknown): void {
  if (typeof signal === "object" && signal !== null) {
    invalidatedSignalObjects.add(signal);
  }
}

function isTombstonedSignal(signal: unknown): boolean {
  return typeof signal === "object" && signal !== null && invalidatedSignalObjects.has(signal);
}

function tombstoneRun(run: GoalReminderRunState): void {
  for (const signal of run.signals) {
    tombstoneSignal(signal);
  }
}

function addRunSignal(
  run: GoalReminderRunState,
  signal: unknown,
  allowNewSignal: boolean,
): boolean {
  if (!hasSignal(signal)) {
    // Once a run has an identifiable controller, accepting a later event with
    // no controller would make a delayed old event indistinguishable from a
    // continuation of this run.
    return run.signals.size === 0;
  }
  if (isTombstonedSignal(signal)) return false;
  if (!allowNewSignal && run.signals.size > 0 && !run.signals.has(signal)) {
    return false;
  }
  run.signals.add(signal);
  if (signalAborted(signal)) run.aborted = true;
  return true;
}

function createRun(ctx: unknown): GoalReminderRunState {
  const signal = readSignal(ctx);
  const session = currentSessionIdentity();
  const signals = new Set<unknown>();
  if (hasSignal(signal)) signals.add(signal);
  return {
    runId: ++nextRunId,
    sawAgentEnd: false,
    aborted: signalAborted(signal),
    settled: false,
    suppressReminderCandidate: false,
    signals,
    sessionId: session?.sessionId ?? null,
    sessionEpoch,
    candidate: null,
  };
}

/** Ensure a run for agent_start; unlike agent_end, this may introduce a new low-level signal. */
function ensureStartRun(ctx: unknown): GoalReminderRunState | null {
  // A reset barrier stays closed until the invalidated outer run emits its
  // agent_settled event. This rejects even an unseen continuation controller.
  if (resetBarrier) return null;

  const signal = readSignal(ctx);
  if (hasSignal(signal) && isTombstonedSignal(signal)) return null;
  // If reset invalidated an identifiable old run, a late start without a new
  // controller is not enough to establish a fresh run. This keeps an old
  // continuation from clearing the reset tombstone.
  if (awaitingFreshRun && freshRunRequiresSignal && !hasSignal(signal)) return null;

  const session = currentSessionIdentity();
  const sessionChanged = Boolean(
    currentRun && !currentRun.settled && session && currentRun.sessionEpoch !== sessionEpoch
  );
  if (!currentRun || currentRun.settled || sessionChanged) {
    if (currentRun) {
      tombstoneRun(currentRun);
      clearReminderTimer();
    }
    currentRun = createRun(ctx);
    awaitingFreshRun = false;
    freshRunRequiresSignal = false;
    return currentRun;
  }

  if (!addRunSignal(currentRun, signal, true)) return null;
  if (awaitingFreshRun) {
    awaitingFreshRun = false;
    freshRunRequiresSignal = false;
  }
  return currentRun;
}

/** Ensure a run for agent_end; unknown/missing signals are rejected once a run has an identity. */
function ensureEndRun(ctx: unknown): GoalReminderRunState | null {
  if (resetBarrier) return null;

  const signal = readSignal(ctx);
  if (hasSignal(signal) && isTombstonedSignal(signal)) return null;

  if (!currentRun) {
    // A post-reset late end must never lazily create a run in the new session.
    if (awaitingFreshRun) return null;
    currentRun = createRun(ctx);
    return currentRun;
  }
  if (currentRun.settled) return null;

  const session = currentSessionIdentity();
  if (session && currentRun.sessionEpoch !== sessionEpoch) {
    // A new session needs a fresh agent_start. Do not let an old end event
    // migrate into it merely because its payload has no run identifier.
    return null;
  }
  if (!addRunSignal(currentRun, signal, false)) return null;
  return currentRun;
}

function candidateMatchesCurrentGoal(candidate: GoalReminderCandidate): boolean {
  const session = currentSessionIdentity();
  if (!session || !session.active || session.sessionId !== candidate.sessionId) {
    return false;
  }
  return Boolean(
    activeGoal &&
    !activeGoal.completed &&
    goalGeneration === candidate.goalGeneration &&
    sessionEpoch === candidate.sessionEpoch
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

/**
 * Carry a non-rendered correlation marker through pi's before_agent_start event.
 * The marker is an HTML comment so it does not alter the visible reminder,
 * while the exact prompt remains available to the LLM runtime.
 */
function buildReminderPrompt(candidate: GoalReminderCandidate, marker: string): string {
  return `${buildReminderText(candidate)}\n\n${marker}`;
}

function sendReminderSafely(
  pi: ExtensionAPI,
  text: string,
  onFailure: (error?: unknown) => void,
  onAccepted: () => void,
  onUnobservable: () => void,
): void {
  const recover = (error?: unknown): void => {
    try {
      onFailure(error);
    } catch {
      // Recovery is best effort and must not escape a lifecycle callback.
    }
  };
  const accept = (): void => {
    try {
      onAccepted();
    } catch {
      // Acceptance bookkeeping is best effort and must not escape a lifecycle callback.
    }
  };

  try {
    // pi 0.83.0 types this API as void and its ExtensionAPI wrapper discards
    // the underlying AgentSession Promise. Observable adapters can still
    // return a Promise; the void path is handled by the bounded agent_start
    // acknowledgement watchdog below.
    const result = (pi.sendUserMessage as unknown as (content: string) => unknown)(text);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).then(accept, recover);
    } else if (result === undefined) {
      onUnobservable();
    } else {
      accept();
    }
  } catch (error) {
    // A new run can begin between the idle check and this call. Do not retry
    // with followUp: that would reintroduce the original premature-trigger
    // behavior. Restore the candidate for a later settled boundary instead.
    recover(error);
  }
}

function describeReminderFailure(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "未知错误";
}

function notifyReminderFailure(pi: ExtensionAPI, error: unknown): void {
  try {
    const sendMessage = (pi as unknown as {
      sendMessage?: (message: {
        customType: string;
        content: string;
        display: boolean;
      }) => unknown;
    }).sendMessage;
    if (typeof sendMessage !== "function") return;
    const result = sendMessage.call(pi, {
      customType: "team-message",
      content: `⚠️ 目标提醒提交失败（原因：${describeReminderFailure(error)}），已保留并将在下一次完全结算后重试。`,
      display: true,
    });
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {
        // The diagnostic itself is best effort.
      });
    }
  } catch {
    // Failure reporting must not turn a best-effort reminder into an
    // unhandled lifecycle error.
  }
}

function notifyReminderUnconfirmed(pi: ExtensionAPI, error: unknown): void {
  try {
    const sendMessage = (pi as unknown as {
      sendMessage?: (message: {
        customType: string;
        content: string;
        display: boolean;
      }) => unknown;
    }).sendMessage;
    if (typeof sendMessage !== "function") return;
    const result = sendMessage.call(pi, {
      customType: "team-message",
      content:
        `⚠️ 目标提醒未确认（原因：${describeReminderFailure(error)}）。` +
        "pi 当前版本不提供 sendUserMessage 的可观察结果，未将其他 agent_start 视为确认；在确认或会话/目标重置前不会再次提交该提醒。",
      display: true,
    });
    if (result && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {
        // The diagnostic itself is best effort.
      });
    }
  } catch {
    // Failure reporting must not turn a best-effort reminder into an
    // unhandled lifecycle error.
  }
}

function armUnobservableSubmission(
  candidate: GoalReminderCandidate,
  marker: string,
  pi: ExtensionAPI,
): void {
  clearPendingSubmission();
  const watchdog = setTimeout(() => {
    // A matching before_agent_start clears this watchdog. Do not restore the
    // candidate here: the request may still be accepted after this timeout,
    // and restoring it could cause a duplicate reminder. Keep the timed-out
    // marker matchable so a delayed accepted prompt cannot be mistaken for a
    // new request.
    if (!pendingSubmission || pendingSubmission.candidate !== candidate) return;
    const submission = pendingSubmission;
    clearPendingSubmission();
    uncertainSubmissions.set(submission.marker, {
      candidate: submission.candidate,
    });
    notifyReminderUnconfirmed(
      pi,
      new Error(
        `pi 0.83.0 sendUserMessage returned no Promise and no matching before_agent_start was observed within ${REMINDER_SUBMISSION_ACK_TIMEOUT_MS}ms`,
      ),
    );
  }, REMINDER_SUBMISSION_ACK_TIMEOUT_MS);
  pendingSubmission = { candidate, marker, watchdog };
}

function extractReminderMarker(prompt: string): string | null {
  const markerStart = prompt.lastIndexOf(REMINDER_MARKER_PREFIX);
  if (markerStart < 0) return null;
  const markerEnd = prompt.indexOf(REMINDER_MARKER_SUFFIX, markerStart);
  if (markerEnd < 0) return null;
  const marker = prompt.slice(markerStart, markerEnd + REMINDER_MARKER_SUFFIX.length);
  const id = marker.slice(
    REMINDER_MARKER_PREFIX.length,
    marker.length - REMINDER_MARKER_SUFFIX.length,
  );
  return /^\d+$/.test(id) ? marker : null;
}

function acknowledgeReminderPrompt(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  const marker = extractReminderMarker(prompt);
  if (!marker) return false;

  if (staleRolloverSubmission?.marker === marker) {
    // This is an accepted prompt from the previous session. It must not ACK
    // any new submission; its next run is cancelled/suppressed instead.
    staleRolloverSubmission.markerSeen = true;
    return true;
  }

  if (pendingSubmission?.marker === marker) {
    const candidate = pendingSubmission.candidate;
    clearPendingSubmission();
    // ACK only resolves uncertainty. lastReminder remains anchored at the
    // API submission point; suppression is attached to the next run instead.
    acknowledgedSubmission = { candidate, marker };
    return false;
  }

  const uncertainSubmission = uncertainSubmissions.get(marker);
  if (!uncertainSubmission) return false;
  uncertainSubmissions.delete(marker);
  // Keep the cooldown anchor unchanged for the same API-only semantics as the
  // pending path; the confirmed run is suppressed separately at agent_end.
  acknowledgedSubmission = { candidate: uncertainSubmission.candidate, marker };
  return false;
}

function restoreFailedCandidate(candidate: GoalReminderCandidate, pi: ExtensionAPI, error: unknown): void {
  if (!candidateMatchesCurrentGoal(candidate)) return;
  const run = currentRun;
  if (!run || run.runId !== candidate.runId || !run.settled || runWasAborted(run)) {
    return;
  }
  pendingReminder = candidate;
  if (
    lastReminder?.sessionId === candidate.sessionId &&
    lastReminder.goalGeneration === candidate.goalGeneration
  ) {
    lastReminder = null;
  }
  notifyReminderFailure(pi, error);
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
const GOAL_REMINDER_LIFECYCLE_NOTICE =
  "系统只会在 TL 的一次运行完全结算（不会再自动重试、自动压缩或处理排队续跑）且目标仍未完成时提醒你检查进度；`agent_end` 只是中间结束点，不会触发提醒。完成目标后请调用 finish_goal 工具。";

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
      "The system reminds you only after the TL run is fully settled (without automatic retry, compaction, or queued continuation) and the goal remains incomplete. " +
      "agent_end is only an intermediate end point and does not trigger a reminder. " +
      "The goal must include concrete, verifiable completion criteria so you can check progress against it. " +
      "Parameters: text (goal summary), criteria (completion conditions).",
    promptGuidelines: [
      "Use set_goal at the start of a team session to define what success looks like.",
      "Write concrete, verifiable completion criteria — not vague aspirations.",
      "Example: { text: '探索 module_a 的全部文件', criteria: '- module_a 的 12 个文件全部完成探索\\n- 所有裁决报告已合并\\n- 所有写入已通过 validate.py 校验' }",
      GOAL_REMINDER_LIFECYCLE_NOTICE,
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
            text: `目标已设定：${params.text}\n完成条件：\n${params.criteria}\n\n${GOAL_REMINDER_LIFECYCLE_NOTICE}`,
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
      if (!run.sawAgentEnd || !run.settled || runWasAborted(run)) {
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
        runWasAborted(run)
      ) {
        pendingReminder = null;
        return;
      }
      const postIdleSignal = readContextSignalState(ctx);
      if (!postIdleSignal.readable || postIdleSignal.aborted) {
        pendingReminder = null;
        return;
      }

      // An unobservable request remains in flight until its correlated
      // before_agent_start arrives. Do not submit another candidate while its
      // outcome is unknown: native compaction has no bounded lease, so any
      // timeout-based retry could duplicate a request that is merely delayed.
      if (pendingSubmission || uncertainSubmissions.size > 0) {
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
      const marker = `${REMINDER_MARKER_PREFIX}${++nextSubmissionId}${REMINDER_MARKER_SUFFIX}`;
      const prompt = buildReminderPrompt(candidate, marker);
      sendReminderSafely(
        pi,
        prompt,
        (error) => restoreFailedCandidate(candidate, pi, error),
        () => clearPendingSubmissionForMarker(marker),
        () => armUnobservableSubmission(candidate, marker, pi),
      );
    }, 0);
  };

  // before_agent_start is the first lifecycle event carrying the prompt. It
  // is the only event that can associate a fire-and-forget request with the
  // run it eventually starts; agent_start has no payload in pi 0.83.0.
  pi.on("before_agent_start", (event, ctx) => {
    const stale = acknowledgeReminderPrompt((event as { prompt?: unknown } | null | undefined)?.prompt);
    if (stale) {
      // Best-effort cancellation while the stale prompt is entering the new
      // session. agent_start below repeats the cancellation once a run exists.
      try {
        ctx.abort();
      } catch {
        // A stale context must never break the host lifecycle.
      }
    }
  });

  // agent_start begins (or resumes) an outer AgentSession run. Retry,
  // compaction, and queued continuation starts occur before agent_settled and
  // therefore reuse this state instead of opening a new reminder window.
  pi.on("agent_start", (_event, ctx) => {
    const run = ensureStartRun(ctx);
    if (!run) return;

    // The matching before_agent_start precedes this event in pi. Associate
    // exactly the next fresh run with that reminder so its own later
    // agent_end cannot create a second reminder after the API cooldown.
    const acknowledgement = acknowledgedSubmission;
    if (acknowledgement && run.runId !== acknowledgement.candidate.runId) {
      if (
        acknowledgement.candidate.sessionId === run.sessionId &&
        acknowledgement.candidate.sessionEpoch === run.sessionEpoch &&
        acknowledgement.candidate.goalGeneration === goalGeneration &&
        activeGoal &&
        !activeGoal.completed
      ) {
        run.suppressReminderCandidate = true;
      }
      acknowledgedSubmission = null;
    }

    const staleSubmission = staleRolloverSubmission;
    if (staleSubmission?.markerSeen && run.runId !== staleSubmission.candidate.runId) {
      if (
        staleSubmission.candidate.sessionId !== run.sessionId ||
        staleSubmission.candidate.sessionEpoch !== run.sessionEpoch
      ) {
        run.suppressReminderCandidate = true;
        try {
          ctx.abort();
        } catch {
          // Stale prompt cancellation is best effort; candidate suppression
          // remains the correctness guard if the host cannot abort here.
        }
      }
      staleRolloverSubmission = null;
    }

    if (runWasAborted(run)) {
      pendingReminder = null;
    }
  });

  // agent_end only records the outcome and a candidate. It is deliberately
  // not a delivery boundary: pi may still retry, compact, or process queued
  // messages after this event and before agent_settled.
  pi.on("agent_end", async (event, ctx) => {
    const run = ensureEndRun(ctx);
    if (!run) return;
    run.sawAgentEnd = true;

    // Record structured cancellation from the final assistant message. An
    // abort signal can also flip after this callback, so dispatch re-checks the
    // captured signal rather than relying on this snapshot alone.
    const messages = (event as any).messages ?? [];
    const assistantMsg = messages.findLast?.((m: any) => m?.role === "assistant");
    if (assistantMsg?.stopReason === "aborted") {
      run.aborted = true;
    }

    // The run started by a confirmed reminder must not feed that same goal
    // back into the reminder pipeline, even when preflight exceeded cooldown.
    // Keep this flag for every low-level continuation until agent_settled.
    if (run.suppressReminderCandidate) {
      run.candidate = null;
      return;
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
    if (runWasAborted(run)) {
      pendingReminder = null;
      return;
    }

    if (session.sessionId !== run.sessionId || sessionEpoch !== run.sessionEpoch) {
      pendingReminder = null;
      return;
    }

    run.candidate = {
      runId: run.runId,
      sessionId: run.sessionId,
      sessionEpoch: run.sessionEpoch,
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
    if (!run) {
      // The old run was invalidated by resetGoal while still in its
      // post-agent_end window. Consume its settlement to open the barrier;
      // no candidate can be revived because reset already cleared all goal
      // state and pending timers.
      if (resetBarrier) {
        resetBarrier = null;
      }
      return;
    }

    const settledSignal = readContextSignalState(ctx);
    if (settledSignal.aborted || runWasAborted(run)) {
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
