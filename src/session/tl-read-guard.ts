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
 * tools (start_member, stop_member, team_send_and_wait, write_shared_context,
 * etc.), write/edit (already restricted to .md-only during sessions), and the
 * third-party orchestration aids ask_user_question / todo (coordination, not
 * analysis).
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

import {
  DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD,
  MIN_TL_SELF_WORK_GUARD_THRESHOLD,
} from "../settings/tl-self-work-guard-constants";

/** Tools that are explicitly team-management/coordination and never count. */
export const MANAGEMENT_TOOLS = new Set([
  "start_member", "stop_member", "list_members", "get_member_log",
  "wait_and_get_member_status", "team_send_and_wait",
  "set_goal", "finish_goal", "add_dynamic_member",
  // write_shared_context is step 1 of the first-action protocol. Counting it
  // would let the guard block the only legal way to satisfy the start_member
  // gate (start_member is refused until the shared context is written), so a
  // TL past the threshold would have no path forward except replying to the
  // user — the protocol would contradict the enforcement.
  "write_shared_context",
  // Agent-initiated session lifecycle (ADR-0003) — whitelisted in sessions;
  // coordination, not "doing the work".
  "start_team_session", "stop_team_session",
  "write", "edit",  // Restricted to .md-only during sessions; legitimate TL management work
  // Third-party orchestration aids (rpiv-ask-user-question / rpiv-todo):
  // asking the user structured questions and tracking a task list is
  // coordination, not "doing the work" — they must never consume the
  // pre-dispatch budget, and a sticky block must not stop a TL that is
  // planning (e.g. 4 todo calls before the first dispatch is good behavior).
  "ask_user_question", "todo",
]);

/**
 * 拦截文案里的豁免清单（阶段 2）：告诉被拦的模型「还有哪些动作合法」，否则它
 * 只会看到一条错误就去试下一个工具或直接回复用户。工具名一律写字面量（本模块
 * 保持叶层：只引用常量文件，不 import 工具注册链路）。
 * 不变式（有测试锁定）：这里出现的工具名必须全部属于 MANAGEMENT_TOOLS，且
 * MANAGEMENT_TOOLS 的每一项都必须在这里出现——文案与事实不得分叉。
 */
export const EXEMPT_ACTIONS_LINE =
  `• 以下动作不受此限制（不计数、不会被拦）：write_shared_context、start_member、stop_member、list_members、get_member_log、wait_and_get_member_status、team_send_and_wait、set_goal、finish_goal、add_dynamic_member、start_team_session、stop_team_session、write/edit（仅 .md 文档）、ask_user_question、todo，以及读取 .md 文档（含 .shared-context.md）。\n` +
  `• 上限可在 /team setting →「TL 亲自分析限制」中调整次数或关闭。`;

export interface TlReadGuardConfig {
  /** 总开关。false = 不拦截、不计数（两个限制器共用的同一个开关）。 */
  enabled: boolean;
  /** 每回合允许的非管理工具调用次数。 */
  threshold: number;
}

export interface TlReadGuardOptions {
  /** Non-management tool calls allowed per turn before sticky blocking. Default: 3. */
  threshold?: number;
  /** Whether the guard is active at all. Default: true (= behaviour before the setting existed). */
  enabled?: boolean;
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
   * Inject the effective configuration at the turn boundary (agent_start).
   * Re-configuring with the same `enabled` state does NOT reset this turn's
   * counters (resetTurn() owns the normal per-turn reset); a disabled→enabled
   * transition DOES reset them, because calls made while disabled were never
   * counted and a stale sticky flag would block silently right after re-enable.
   */
  configure(config: TlReadGuardConfig): void;
  /**
   * Evaluate a tool call.
   * @param toolName - name of the tool being called
   * @param filePath - path extracted from input (only for read/write/edit); may be undefined
   * @returns block decision + corrective reason (sticky once threshold exceeded)
   */
  checkToolCall(toolName: string, filePath?: string): TlReadGuardVerdict;
  /** Current non-management tool call count this turn (observability / testing). */
  readonly preDispatchCalls: number;
  /** Effective threshold (after configure()). */
  readonly threshold: number;
  /** Whether the guard is currently active. */
  readonly enabled: boolean;
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
  /** Whether the limiter is active. Default: true. Shares the `enabled` switch with the pre-dispatch guard. */
  enabled?: boolean;
}

/**
 * 设计阶段的 read 提醒节奏，固定 4 次（导出为具名常量供测试与文档引用）。
 * 刻意不与执行阶段的 threshold 共用一个数字：设计阶段没有可派发对象，
 * 「每 N 次提醒一次」与「N 次后持续拦截」是两种不同语义。
 */
export const DESIGN_READ_GUARD_THRESHOLD = 4;

export interface DesignReadGuard {
  /** Reset per-turn counters. Call on agent_start (once per user-message turn). */
  resetTurn(): void;
  /** 回合边界注入开关（次数固定为 DESIGN_READ_GUARD_THRESHOLD，不可配）。 */
  configure(config: { enabled: boolean }): void;
  /**
   * Evaluate a tool call. Only `read` on non-.md files is in scope.
   * @returns soft block verdict (blocked call is followed by a passing one)
   */
  checkToolCall(toolName: string, filePath?: string): TlReadGuardVerdict;
  /** Non-.md read calls this turn (observability / testing). */
  readonly readCount: number;
  /** Whether the limiter is currently active. */
  readonly enabled: boolean;
}

export function createDesignReadGuard(options: DesignReadGuardOptions = {}): DesignReadGuard {
  const threshold = options.threshold ?? DESIGN_READ_GUARD_THRESHOLD;
  let enabled = options.enabled ?? true;

  let readCount = 0;
  let firstBlocked = false;
  let justBlocked = false;

  return {
    resetTurn() {
      readCount = 0;
      firstBlocked = false;
      justBlocked = false;
    },

    configure(config) {
      const wasEnabled = enabled;
      // fail-safe（与执行阶段限制器同款）：只认字面 false。
      enabled = config.enabled !== false;
      // 与执行阶段限制器的「关→开从零预算」对称复位：关闭期间不计数，重新开启
      // 若保留 readCount / justBlocked / firstBlocked，会导致「重新武装后第 N 次
      // 提醒静默出现」（firstBlock 仍为 false，用户看不到通知），而且周期相位
      // 会沿用关闭前的余数。生产路径 resetTurn → configure 行为不变（先重置）。
      if (!wasEnabled && enabled) {
        readCount = 0;
        firstBlocked = false;
        justBlocked = false;
      }
    },

    checkToolCall(toolName, filePath) {
      // 关闭：直接放行，且**不计数**（否则关闭期间的读取会在重新开启时立刻触发提醒）。
      if (!enabled) return { block: false };
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
            `• 读取 .md 文档（README/ADR/需求文档）不计数、不拦截。\n` +
            `• 若不希望保留该提醒，可在 /team setting →「TL 亲自分析限制」中关闭（设计阶段的提醒节奏固定每 4 次，不随次数设置变化）。`,
        };
      }
      return { block: false };
    },

    get readCount() {
      return readCount;
    },

    get enabled() {
      return enabled;
    },
  };
}

export function createTlReadGuard(options: TlReadGuardOptions = {}): TlReadGuard {
  let enabled = options.enabled ?? true;
  let threshold = options.threshold ?? DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD;

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

    configure(config) {
      const wasEnabled = enabled;
      // fail-safe（与 resolver 同款）：只认字面 false；undefined / null / 字符串 /
      // 其他异常形态一律保持开启。方向与设置层一致——误放宽是静默的角色漂移，
      // 误拦是响亮的且可当场修正。
      enabled = config.enabled !== false;
      // 入参防御：非整数 / NaN / 低于下限 → 默认值。调用点（回合边界）已保证
      // 合法值；这里只保证内部状态不变量（不能出现 0 或 NaN 造成的「每调用必拦」）。
      threshold =
        Number.isInteger(config.threshold) &&
        config.threshold >= MIN_TL_SELF_WORK_GUARD_THRESHOLD
          ? config.threshold
          : DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD;
      // 由关变开：关闭期间不计数，所以重新开启必须从零预算开始——否则残留的
      // sticky 会在开启后的第一次调用上静默拦截（firstBlock=false，用户看不到
      // 通知）。只作用于配置状态转换，resetTurn →configure 生产路径不受影响
      // （resetTurn 已先清零）。
      if (!wasEnabled && enabled) {
        callCount = 0;
        sticky = false;
      }
    },

    checkToolCall(toolName, filePath) {
      // 关闭：直接放行，且**不计数**（否则关闭期间的调用会在重新开启时立刻粘滞）。
      if (!enabled) return { block: false };
      // Management tools never count — they are coordination, not "doing the work".
      if (MANAGEMENT_TOOLS.has(toolName)) return { block: false };
      // After a dispatch, everything passes — post-dispatch tool calls are coordination/review.
      if (dispatched) return { block: false };
      // For `read` specifically: .md files / unknown paths never count — reading docs is legitimate.
      // 必须在自增之前（粘滞态仍可读文档的安全阀）。
      if (toolName === "read" && (!filePath || filePath.endsWith(".md"))) return { block: false };

      callCount += 1;

      // Sticky mode: every non-management call is blocked until dispatch.
      if (sticky) {
        return {
          block: true,
          reason:
            `🚫 仍未派发任务却继续调用工具（已累计 ${callCount} 次非管理调用；当前上限 ${threshold} 次/回合）。` +
            `派发前工具调用会被持续拦截，继续调用只会浪费 token：\n` +
            `• 立即停止亲自分析，用 team_send_and_wait 把任务派给合适的 Member；\n` +
            `• 或者直接回复用户说明当前情况，等待用户指示。\n` +
            `${EXEMPT_ACTIONS_LINE}`,
        };
      }

      if (callCount > threshold) {
        sticky = true;
        return {
          block: true,
          firstBlock: true,
          reason:
            `⚠️ 检测到你在尚未派发任何任务的情况下已连续调用 ${callCount} 次非管理工具（如 read/bash/search 等；当前上限 ${threshold} 次/回合）。` +
            `作为 Team Lead，代码分析/排查工作必须通过 team_send_and_wait 分派给 Member 完成，而不是自己动手。\n` +
            `• 立即停止当前分析，改用 team_send_and_wait 把任务派给合适的 Member。\n` +
            `• 在派发任务之前，后续工具调用都会被持续拦截（这是提醒不是围墙——派发后全部恢复）。\n` +
            `${EXEMPT_ACTIONS_LINE}`,
        };
      }
      return { block: false };
    },

    get preDispatchCalls() {
      return callCount;
    },

    get threshold() {
      return threshold;
    },

    get enabled() {
      return enabled;
    },
  };
}
