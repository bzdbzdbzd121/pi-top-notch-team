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
