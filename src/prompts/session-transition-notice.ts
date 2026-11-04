/**
 * Single source of truth for the **persistent team-state declaration** — the
 * text injected at the very top of the team prompt block on every turn.
 *
 * Why it exists: the team prompt block was already re-injected every turn, but
 * no sentence in it claimed authority. It sits at the tail of a multi-thousand
 * character system prompt, so in a long conversation the model's own recent
 * pattern ("I read the code and analysed it myself") kept winning. The exit
 * banner (`index.ts`, AGENTS.md decision #24) was fixed by the same move —
 * same channel, same tail position, only the wording became authoritative —
 * and that wording was verified end to end. This module applies that proven
 * variable to the entry side; the injection position is deliberately unchanged
 * so any measured effect stays attributable to the wording.
 *
 * Scope is deliberately narrow today: declaration only. The bounded entry
 * notice (a `message` returned from `before_agent_start`, so "the switch just
 * happened" becomes a referable event) is a later stage and needs its own
 * lifecycle (arm on /team start, clear on teardown and on new sessions).
 * The file keeps its `session-transition-notice` name for that planned second
 * layer; do not add it without the lifecycle.
 *
 * Wording rule (learned from review): the history claim must stay scoped to
 * (a) records from **before** this session and (b) behaviour that **conflicts**
 * with the current state. Within one team session there are legitimate reads
 * (design phase), `.md` writes, and resumed history — claiming every record
 * predates the entry is simply false, and a prompt that states a falsehood
 * gets discounted wholesale. It is an authorization claim, not a truth claim.
 */
export type TeamStateDeclarationVariant = "predefined" | "design" | "execution";

function executionStateDeclaration(teamName: string): string {
  return `### 🧭 状态：你正在团队会话中（Team Lead）

你**当前**处在团队会话「${teamName}」中。本段由扩展在每个回合按当前会话状态重新生成，它是**当前唯一有效的状态说明**。
历史里**进入本会话之前**留下的做法（你自己 read/bash 分析代码、直接改文件、直接下结论）属于普通模式，不构成本回合的授权；历史里**与本提示冲突**的做法，以本提示为准。
收到任务型诉求时先按第一动作协议派发；如果某个回复里你又开始亲自分析代码，立即停下并改为派发。
`;
}

function designStateDeclaration(): string {
  return `### 🧭 状态：你正在团队会话中（动态团队 — 设计阶段）

你**当前**处在动态团队模式的设计阶段。本段由扩展在每个回合按当前会话状态重新生成，它是**当前唯一有效的状态说明**。
历史里**进入本会话之前**留下的做法（你自己分析代码、直接改文件、直接给结论）属于普通模式，不构成本阶段的授权；历史里**与本提示冲突**的做法，以本提示为准。
设计阶段要做的是：与用户对齐需求 → 拆解任务与工作流 → 给出计划书 → 等用户明确确认。
用户明确确认之前，不要注册成员、不要启动成员、不要派发任务。
`;
}

/**
 * `predefined` and `execution` share one builder on purpose: a pre-defined team
 * and the dynamic execution phase have the same tool set and the same dispatch
 * protocol, so two texts would only drift apart. `design` is separate because
 * the dynamic design phase has a hard confirmation gate — a dispatch
 * instruction there pushes the model to violate its own gate (or hit "no member
 * started yet", since a design-phase team may have zero members).
 *
 * A `Record` (not a ternary) makes a future variant a compile error here.
 * The `??` fallback keeps an unexpected runtime value from throwing inside
 * prompt assembly — a throw would drop the whole team prompt for that turn,
 * which is exactly the failure mode the entry-side work must not introduce.
 */
const DECLARATION_BUILDERS: Record<TeamStateDeclarationVariant, (teamName: string) => string> = {
  predefined: executionStateDeclaration,
  execution: executionStateDeclaration,
  design: designStateDeclaration,
};

/**
 * Build the persistent state declaration.
 *
 * @param variant - `predefined` / `execution` produce identical text; `design` differs.
 * @param teamName - Rendered into the execution-state text only. The design text
 *   omits it on purpose: dynamic teams carry a synthetic `_dynamic_<ts>` name
 *   that carries no meaning for the model.
 */
export function buildTeamStateDeclaration(
  variant: TeamStateDeclarationVariant,
  teamName: string,
): string {
  const build = DECLARATION_BUILDERS[variant] ?? executionStateDeclaration;
  return build(teamName);
}

// ────────────────────────────────────────────────────────────────
// Layer 2 — the bounded session entry notice
//
// The declaration above answers "what am I now" and is true on every turn.
// It cannot answer "the switch just happened": a long conversation contains no
// record the model can point at. This notice is that record — one extra message
// returned from `before_agent_start`, which pi maps to the user role right
// after the user's message and persists as a custom session entry.
//
// Design constraints (see the plan's stage 1):
// - Bounded: at most SESSION_ENTRY_NOTICE_MAX_TURNS injections per entry, so
//   the history does not accumulate near-duplicate assertions. 2 (not 1)
//   because the first message after `/team start` in a long conversation is
//   often "ok, go ahead" — a strict one-shot would be spent there and the real
//   task would arrive without it. Set to 0 to disable, 1 for strict one-shot;
//   no other code changes are needed.
// - Stops early once the team is operational (shared context written AND a
//   member started) — the dispatch already happened, the notice is noise.
// - Never starts a turn of its own: it rides the next user-initiated turn.
// - Two variants only: the dynamic design phase has a hard confirmation gate,
//   so a dispatch instruction there would push the model to violate its own
//   gate (or hit "no member started yet").
// ────────────────────────────────────────────────────────────────

/**
 * customType of the entry notice. Deliberately its own kind: `team-message`
 * carries member-routing semantics (and is part of the exit-side trace check
 * for that reason), so reusing it would make the two indistinguishable.
 */
export const SESSION_ENTRY_NOTICE_CUSTOM_TYPE = "team-session-notice";

/** Max turns the entry notice may be injected. 0 disables, 1 = strict one-shot. */
export const SESSION_ENTRY_NOTICE_MAX_TURNS = 2;

/**
 * Literal first-line prefix of the notice — the ONLY string another component
 * may use to refer to it.
 *
 * Two reasons it is a constant rather than a hand-typed quote:
 * - The exit banner has to name the notice so the two do not tie in the history.
 *   A paraphrase ("已进入团队会话") is not findable in the transcript; the prefix
 *   is exactly what the model sees at the top of the notice.
 * - The banner must not leak the internal customType identifier
 *   ("team-session-notice") into model-facing text; importing this constant
 *   makes that impossible by construction.
 */
export const SESSION_ENTRY_NOTICE_ANCHOR = "【系统通知｜团队会话状态】";

export type SessionEntryNoticeVariant = "dispatch" | "design";

export interface SessionEntryNoticeInput {
  teamName: string;
  sessionId: string | null;
  variant: SessionEntryNoticeVariant;
}

/** Return shape consumed directly as `before_agent_start`'s `message`. */
export interface SessionEntryNotice {
  customType: string;
  content: string;
  /**
   * User-invisible (user decision): the notice still enters the model context
   * and is still persisted, it just is not rendered in the chat history.
   *
   * Verified against both supported pi releases before switching it off (the
   * trace check depends on persistence, so this could not be assumed). Anchors
   * are SYMBOLS, not line numbers — dist line numbers drift between patch
   * releases; the same shapes exist in 0.83.0 and 1.5.0:
   * - enters the context: `convertToLlm`'s `case "custom"` in `core/messages.js`
   *   maps a custom message to the user role without consulting `display`; the
   *   prompt path in `core/agent-session.js` pushes the handler's message into
   *   the run's message list (`messages.push({ role: "custom", ... })` right
   *   after the `emitBeforeAgentStart` call) — it copies `display` through and
   *   never filters on it.
   * - still persisted: the `message_end` branch in `core/agent-session.js`
   *   (`if (event.message.role === "custom")`) always calls
   *   `appendCustomMessageEntry(customType, content, display, details)`; the
   *   flag is stored on the entry and never used as a filter. So
   *   `historyHasTeamTraces` still sees the entry and the exit banner keeps
   *   firing after "entered → discussed → /team stop".
   * - not rendered: the TUI's `addMessageToChat` `case "custom"` in
   *   `modes/interactive/interactive-mode.js` is gated by `if (message.display)`,
   *   and the history-replay path goes through `sessionEntryToContextMessages` →
   *   `createCustomMessage` → the same gate (1.5.0 additionally prefilters the
   *   replay event on `entry.display`).
   *
   * Runtime proof: src/index-session-entry.agent-session.test.ts asserts both
   * the user role in the outbound request and the persisted entry.
   */
  display: false;
  details: {
    kind: "session-entry";
    teamName: string;
    sessionId: string | null;
    variant: SessionEntryNoticeVariant;
  };
}

const DISPATCH_NOTICE_BODY = `用户刚刚进入团队会话「{teamName}」，从现在起你是该团队的 Team Lead，不再是普通编码助手。
本提示优先于对话历史：**进入本会话之前**留下的做法（你自己分析代码、直接改文件、直接下结论）属于普通模式，不构成本回合的授权；**与本提示冲突**的做法以本提示为准。

这一回合的动作顺序：
1. 共享上下文还没写 → 先调用 write_shared_context；
2. 成员还没启动 → 用 start_member 启动本次要参与的成员；
3. 用 team_send_and_wait 把任务派给成员（互相独立的任务可以一次派多个）。
派发前最多为确认事实查证 1-2 个文件；完整的分析、排查、代码理解一律派发。

如果用户这一轮只是问候、确认或继续讨论需求，简要回应并推进对齐即可，不要为闲聊强行派发。`;

const DESIGN_NOTICE_BODY = `用户刚刚进入动态团队会话，当前是设计阶段，从现在起你是该会话的 Team Lead。
本提示优先于对话历史：**进入本会话之前**留下的做法（你自己分析代码、直接改文件、直接给结论）属于普通模式，不构成本阶段的授权；**与本提示冲突**的做法以本提示为准。

设计阶段的顺序：
1. 与用户对齐目标、范围、验收标准、约束与非目标（一次问一个问题，并给出推荐答案）；
2. 拆解任务与依赖，给出计划书（目标、任务拆分、工作流、分工、风险）；
3. 用户明确确认后再落地：add_dynamic_member 注册成员 → write_shared_context → start_member → team_send_and_wait 派发。

设计阶段不要派发任务、不要启动成员（此时团队可能一个成员都没有）。为确认事实可以读 1-2 个文件。`;

/**
 * Footer stating how long the notice may repeat. Derived from
 * SESSION_ENTRY_NOTICE_MAX_TURNS so the number in the text can never drift from
 * the counter that enforces it (a hardcoded "two turns" would silently lie
 * after the constant is tuned to 1 or 0).
 */
function entryWindowPhrase(): string {
  const turns = SESSION_ENTRY_NOTICE_MAX_TURNS;
  const window =
    turns <= 1
      ? "（本条只在进入后的这一回合出现，之后不再出现"
      : `（本条在进入后的前 ${turns} 个回合内可能出现，团队开始运转后不再出现`;
  return `${window}；若历史里有更早的同类提示，以最新一条为准。）`;
}

/**
 * Build the entry notice. The first line always declares the message's own
 * source — it is the cheapest guard against the model answering the notice
 * instead of the user's message.
 */
export function buildSessionEntryNotice(input: SessionEntryNoticeInput): SessionEntryNotice {
  const body =
    input.variant === "design"
      ? DESIGN_NOTICE_BODY
      : DISPATCH_NOTICE_BODY.replace("{teamName}", input.teamName);
  const content = `${SESSION_ENTRY_NOTICE_ANCHOR}本条不是用户输入，也不是新任务——不要回复本条，直接处理用户的上一条消息。

${body}

${entryWindowPhrase()}`;

  return {
    customType: SESSION_ENTRY_NOTICE_CUSTOM_TYPE,
    content,
    display: false,
    details: {
      kind: "session-entry",
      teamName: input.teamName,
      sessionId: input.sessionId,
      variant: input.variant,
    },
  };
}

/**
 * Decide what to do with the entry notice this turn. Pure function so the whole
 * table can be enumerated in tests.
 *
 * Precedence: inactive session → exhausted counter → resume banner → operational.
 * - `none`: do not inject and leave the counter alone.
 * - `stop`: the team is operational, clear the counter (no injection).
 * - `inject`: inject and decrement.
 *
 * The inactive check is what makes "entered" and "ended" mutually exclusive
 * within one turn: the exit banner requires an inactive session.
 */
export function decideEntryNotice(state: {
  sessionActive: boolean;
  remaining: number;
  hasResumeBanner: boolean;
  sharedContextWritten: boolean;
  startedMemberCount: number;
}): "inject" | "stop" | "none" {
  if (!state.sessionActive) return "none";
  if (state.remaining <= 0) return "none";
  // /team resume has a more specific one-shot banner — never stack.
  if (state.hasResumeBanner) return "none";
  // Operational = shared context written AND at least one member started.
  if (state.sharedContextWritten && state.startedMemberCount > 0) return "stop";
  return "inject";
}
