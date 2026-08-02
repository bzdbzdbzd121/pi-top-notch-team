/**
 * TL pre-dispatch guard — runtime enforcement for "TL does Member work itself".
 *
 * Background: during team sessions the TL sometimes starts reading/analyzing
 * code itself instead of dispatching the task to Members. Prompt-level rules
 * alone are unreliable (the base coding-assistant system prompt pushes the
 * model toward doing the work directly), so this guard adds a deterministic
 * runtime nudge on top of the prompt rules.
 *
 * The guard counts ALL non-management tool calls (read, bash, ctx_execute,
 * web_search, etc.) — not just `read` — because the TL can easily bypass a
 * read-only guard by using `bash` with grep/rg/cat or ctx_execute to read
 * code files. The only tools exempt from counting are the team-management
 * tools (start_member, stop_member, team_send_and_wait, etc.) and write/edit
 * (already restricted to .md-only during sessions).
 *
 * Behavior (per user-message turn):
 * - Management tools (start/stop/list members, team_send_and_wait, set_goal,
 *   add_dynamic_member, write, edit) never count and are never blocked.
 * - For `read` specifically: .md files never count (reading docs / shared
 *   context is legitimate TL work).
 * - Once the TL has dispatched a task (`team_send_and_wait`), the guard
 *   stands down for the rest of the turn — post-dispatch tool calls (e.g.
 *   reviewing Member output) are fine.
 * - When non-management tool calls exceed the threshold before any dispatch,
 *   the guard enters STICKY blocking mode: every subsequent non-management
 *   tool call is blocked until the TL dispatches a task or the turn ends.
 *   A one-shot soft block proved too weak in practice — the model saw one
 *   error and continued analyzing with the next tool. Sticky blocking forces
 *   the TL to either dispatch (the intended behavior) or reply to the user.
 *   `firstBlock` is set on the first blocked call so the UI can notify the
 *   user; the reason text distinguishes first vs. repeated blocks.
 * - `resetTurn()` is called on `agent_start` so each user message gets a
 *   fresh budget. Fail-open by design.
 *
 * Design phase note: this guard is intentionally NOT applied during the
 * dynamic-mode design phase — no Members exist yet to dispatch to, and
 * exploring code to understand the project is legitimate design work there.
 */

/** Tools that are explicitly team-management/coordination and never count. */
export const MANAGEMENT_TOOLS = new Set([
  "start_member", "stop_member", "list_members", "get_member_log",
  "wait_and_get_member_status", "team_send_and_wait",
  "set_goal", "finish_goal", "add_dynamic_member",
  "write", "edit",  // Restricted to .md-only during sessions; legitimate TL management work
]);

export interface TlReadGuardOptions {
  /** Non-management tool calls allowed per turn before sticky blocking. Default: 3. */
  threshold?: number;
}

export interface TlReadGuardVerdict {
  block: boolean;
  reason?: string;
  /** true on the FIRST blocked call of the turn (used for user-facing notification). */
  firstBlock?: boolean;
}

export interface TlReadGuard {
  /** Reset per-turn counters. Call on agent_start (once per user-message turn). */
  resetTurn(): void;
  /** Mark that the TL dispatched a task this turn (team_send_and_wait called). */
  recordDispatch(): void;
  /**
   * Evaluate a tool call.
   * @param toolName - name of the tool being called
   * @param filePath - path extracted from input (only for read/write/edit); may be undefined
   * @returns block decision + corrective reason (sticky once threshold exceeded)
   */
  checkToolCall(toolName: string, filePath?: string): TlReadGuardVerdict;
  /** Current non-management tool call count this turn (observability / testing). */
  readonly preDispatchCalls: number;
}

export function createTlReadGuard(options: TlReadGuardOptions = {}): TlReadGuard {
  const threshold = options.threshold ?? 3;

  let callCount = 0;
  let dispatched = false;
  let sticky = false;

  return {
    resetTurn() {
      callCount = 0;
      dispatched = false;
      sticky = false;
    },

    recordDispatch() {
      dispatched = true;
    },

    checkToolCall(toolName, filePath) {
      // Management tools never count — they are coordination, not "doing the work".
      if (MANAGEMENT_TOOLS.has(toolName)) return { block: false };
      // After a dispatch, everything passes — post-dispatch tool calls are coordination/review.
      if (dispatched) return { block: false };
      // For `read` specifically: .md files / unknown paths never count — reading docs is legitimate.
      if (toolName === "read" && (!filePath || filePath.endsWith(".md"))) return { block: false };

      callCount += 1;

      // Sticky mode: every non-management call is blocked until dispatch.
      if (sticky) {
        return {
          block: true,
          reason:
            `🚫 仍未派发任务却继续调用工具（已累计 ${callCount} 次非管理调用）。` +
            `派发前工具调用会被持续拦截，继续调用只会浪费 token：\n` +
            `• 立即停止亲自分析，用 team_send_and_wait 把任务派给合适的 Member；\n` +
            `• 或者直接回复用户说明当前情况，等待用户指示。`,
        };
      }

      if (callCount > threshold) {
        sticky = true;
        return {
          block: true,
          firstBlock: true,
          reason:
            `⚠️ 检测到你在尚未派发任何任务的情况下已连续调用 ${callCount} 次非管理工具（如 read/bash/search 等）。` +
            `作为 Team Lead，代码分析/排查工作必须通过 team_send_and_wait 分派给 Member 完成，而不是自己动手。\n` +
            `• 立即停止当前分析，改用 team_send_and_wait 把任务派给合适的 Member。\n` +
            `• 注意：在派发任务之前，后续工具调用都会被持续拦截（这是提醒不是围墙——派发后全部恢复）。`,
        };
      }
      return { block: false };
    },

    get preDispatchCalls() {
      return callCount;
    },
  };
}
