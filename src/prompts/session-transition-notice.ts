/**
 * Single source of truth for session-transition prompt text (entering / leaving
 * a team session).
 *
 * Stage 0 (this file's current scope): the **persistent state declaration**.
 * It is injected at the very top of the team prompt block on every new turn.
 *
 * Why it exists: the team prompt block already re-injected on every turn, but
 * nothing in it ever claimed authority — it sits at the tail of a multi-thousand
 * character system prompt with no sentence that outranks the conversation
 * history. So in a long conversation the model keeps following its own recent
 * pattern ("I read the code and analysed it myself"), which predates the
 * session switch. The exit-side banner was fixed exactly this way — same
 * channel, same tail position, only the wording became authoritative — and it
 * was verified end to end (AGENTS.md decision #24). This declaration applies
 * the same proven variable to the entry side; position is deliberately left
 * unchanged so any measured effect stays attributable to the wording.
 *
 * Later stage (not implemented here): the bounded entry notice returned as a
 * `message` from `before_agent_start`, so "the switch just happened" also
 * becomes a referable event in history. Do not add it here without its
 * lifecycle (arm on /team start, clear on teardown and on new sessions).
 *
 * Keep `predefined` and `execution` byte-identical: a pre-defined team and the
 * dynamic execution phase behave the same way (same tool set, same dispatch
 * protocol), so two texts would only drift. `design` is separate because the
 * dynamic design phase has a hard confirmation gate — a dispatch instruction
 * there would push the model to violate its own gate (or hit "no member started
 * yet", since a design-phase team may have zero members).
 */
export type TeamStateDeclarationVariant = "predefined" | "design" | "execution";

function executionStateDeclaration(teamName: string): string {
  return `### 🧭 状态：你正在团队会话中（Team Lead）

你**当前**处在团队会话「${teamName}」中。本段由扩展按当前会话状态实时生成，每个回合都与真实状态一致。
这是**当前唯一有效的状态**：对话历史里你亲自 read/bash 分析代码、直接改文件的记录，都发生在进入团队会话**之前**，那些做法属于普通模式；与本提示冲突时**一律以本提示为准**。如果某个回复里你又开始亲自分析代码，立即停下并改为派发。
`;
}

function designStateDeclaration(): string {
  return `### 🧭 状态：你正在团队会话中（动态团队 — 设计阶段）

你**当前**处在动态团队模式的设计阶段，本段由扩展按当前会话状态实时生成。
这是**当前唯一有效的状态**：历史里你亲自分析代码的记录发生在进入团队会话**之前**，与本提示冲突时以本提示为准。
设计阶段要做的是：与用户对齐需求 → 拆解任务与工作流 → 给出计划书 → 等用户明确确认。
用户明确确认之前，不要注册成员、不要启动成员、不要派发任务。
`;
}

/**
 * Build the persistent state declaration.
 *
 * @param variant - `predefined` / `execution` share one text; `design` differs.
 * @param teamName - Rendered into the execution-state text. The design text
 *   omits it on purpose: dynamic teams carry a synthetic `_dynamic_<ts>` name
 *   that means nothing to the model.
 */
export function buildTeamStateDeclaration(
  variant: TeamStateDeclarationVariant,
  teamName: string,
): string {
  return variant === "design" ? designStateDeclaration() : executionStateDeclaration(teamName);
}
