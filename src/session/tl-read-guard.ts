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

// ────────────────────────────────────────────────────────────────
// Design-phase read limiter (dynamic mode, before any Member exists)
//
// In the design phase `read` IS allowed (exploring the project to design
// the team is legitimate), but the TL must not fall into deep code analysis
// instead of discussing requirements. Unlike the execution-phase guard
// (sticky block until dispatch — there is nothing to dispatch to here),
// this guard applies a SOFT periodic reminder:
//   - Only non-.md `read` calls are counted (docs/shared-context reads are
//     legitimate design work and never counted — same rule as the pre-
//     dispatch guard).
//   - Every `threshold`-th code read is blocked ONCE with a reminder
//     ("do you really need to read this?"). The very next read call passes
//     again — if the read is genuinely needed the TL can simply retry.
//   - `firstBlock` marks the first block of the turn for UI notification;
//     later blocks of the same turn skip the notification (no spam).
//   - `resetTurn()` is called on `agent_start` so each user message gets a
//     fresh budget. Fail-open: non-read tools are never touched (the design-
//     phase whitelist already blocks them), .md reads / unknown paths never
//     count.

export interface DesignReadGuardOptions {
  /** Code reads allowed between reminders. Every `threshold`-th code read is blocked once. Default: 4 (same rhythm as the pre-dispatch guard's 4th-call block). */
  threshold?: number;
}

export interface DesignReadGuard {
  /** Reset per-turn counters. Call on agent_start (once per user-message turn). */
  resetTurn(): void;
  /**
   * Evaluate a tool call. Only `read` on non-.md files is in scope.
   * @returns soft block verdict (blocked call is followed by a passing one)
   */
  checkToolCall(toolName: string, filePath?: string): TlReadGuardVerdict;
  /** Non-.md read calls this turn (observability / testing). */
  readonly readCount: number;
}

export function createDesignReadGuard(options: DesignReadGuardOptions = {}): DesignReadGuard {
  const threshold = options.threshold ?? 4;

  let readCount = 0;
  let firstBlocked = false;
  let justBlocked = false;

  return {
    resetTurn() {
      readCount = 0;
      firstBlocked = false;
      justBlocked = false;
    },

    checkToolCall(toolName, filePath) {
      // Only `read` is in scope — the design-phase whitelist already blocks
      // every other non-management tool (bash, edit, web_search, ...).
      if (toolName !== "read") return { block: false };
      // .md reads / unknown paths never count — reading docs is legitimate design work.
      if (!filePath || filePath.endsWith(".md")) return { block: false };

      readCount += 1;
      // The read immediately after a soft block passes unconditionally —
      // a genuinely needed read is always retryable ("若确实需要可再次调用").
      if (justBlocked) {
        justBlocked = false;
        return { block: false };
      }
      if (readCount % threshold === 0) {
        justBlocked = true;
        const first = !firstBlocked;
        firstBlocked = true;
        return {
          block: true,
          ...(first ? { firstBlock: true } : {}),
          reason:
            `⚠️ 设计阶段已累计 ${readCount} 次非文档 read（代码/项目文件读取）。作为团队设计师，反复读取项目文件会偏离设计职责——请确认是否真的需要读取该文件：\n` +
            `• 若确需查证（如项目结构、需求细节）→ 直接再次调用 read 即可，本次为单次提醒，不会持续拦截；\n` +
            `• 若已进入代码分析 → 请停止，先与用户对齐需求；代码分析由执行阶段的 Member 完成。\n` +
            `• 读取 .md 文档（README/ADR/需求文档）不计数、不拦截。`,
        };
      }
      return { block: false };
    },

    get readCount() {
      return readCount;
    },
  };
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
