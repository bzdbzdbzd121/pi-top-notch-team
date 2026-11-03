import { describe, it, expect } from "vitest";
import { buildTeamStateDeclaration } from "./session-transition-notice";

/**
 * Stage 0 of the session-transition work: the persistent state declaration.
 *
 * Assertions lock the three speech acts the declaration must perform:
 *   1. name the current state (you ARE in a team session, with the team name);
 *   2. claim authority over the conversation history;
 *   3. give the phase-correct next step (dispatch chain vs confirmation gate).
 * Plus the anti-drift rule: `predefined` and `execution` are byte-identical.
 */
describe("buildTeamStateDeclaration — 执行态（预定义团队 / 动态执行阶段）", () => {
  const text = buildTeamStateDeclaration("predefined", "研发队");

  it("点明当前处于团队会话，并带上传入的团队名", () => {
    expect(text).toContain("状态：你正在团队会话中");
    expect(text).toContain("研发队");
  });

  it("声明权威：当前唯一有效的状态 + 冲突时以本提示为准", () => {
    expect(text).toContain("当前唯一有效的状态");
    expect(text).toContain("以本提示为准");
    // 权威声明限定于「冲突」情形，不是「所有历史一律无效」
    expect(text).toContain("与本提示冲突");
  });

  it("历史断言限定于「进入本会话之前」，不否定会话内的合法记录", () => {
    // 同一团队会话内有合法 read（设计阶段）、.md 写入、resume 历史——
    // 断言「所有自分析记录都发生在进入之前」是假的，会让模型整段折扣提示。
    expect(text).toContain("进入本会话之前");
    expect(text).toContain("属于普通模式");
    expect(text).toContain("不构成本回合的授权");
    expect(text).not.toContain("都发生在进入团队会话**之前**");
  });

  it("给出纠正动作：发现自己又亲自分析时立即改为派发", () => {
    expect(text).toContain("立即停下并改为派发");
  });

  it("不串味：不含设计阶段/确认门内容", () => {
    expect(text).not.toContain("设计阶段");
    expect(text).not.toContain("明确确认");
  });

  it("不复述动作链（动作链归第一动作协议单一来源）", () => {
    expect(text).not.toContain("write_shared_context");
    expect(text).not.toContain("start_member");
    expect(text).not.toContain("team_send_and_wait");
  });
});

describe("buildTeamStateDeclaration — 设计态", () => {
  const text = buildTeamStateDeclaration("design", "_dynamic_1750000000000");

  it("标注动态团队的设计阶段", () => {
    expect(text).toContain("状态：你正在团队会话中");
    expect(text).toContain("设计阶段");
  });

  it("声明权威：当前唯一有效的状态 + 冲突以本提示为准", () => {
    expect(text).toContain("当前唯一有效的状态");
    expect(text).toContain("以本提示为准");
  });

  it("含确认门：用户明确确认前不注册成员、不启动成员、不派发任务", () => {
    expect(text).toContain("明确确认");
    expect(text).toContain("不要注册成员");
    expect(text).toContain("不要启动成员");
    expect(text).toContain("不要派发任务");
  });

  it("不渲染合成团队名（_dynamic_<ts> 对模型无意义）", () => {
    expect(text).not.toContain("_dynamic_");
  });

  it("不串味：不含执行态的纠正/授权措辞", () => {
    expect(text).not.toContain("立即停下并改为派发");
    expect(text).not.toContain("不构成本回合的授权");
  });

  it("不复述工具名（设计阶段根本没有可派发的成员）", () => {
    expect(text).not.toContain("start_member");
    expect(text).not.toContain("team_send_and_wait");
  });
});

describe("buildTeamStateDeclaration — 变体关系", () => {
  it("predefined 与 execution 逐字节一致（同一执行态，防漂移）", () => {
    expect(buildTeamStateDeclaration("predefined", "研发队")).toBe(
      buildTeamStateDeclaration("execution", "研发队"),
    );
  });

  it("设计态与执行态是两份不同文案", () => {
    expect(buildTeamStateDeclaration("design", "研发队")).not.toBe(
      buildTeamStateDeclaration("execution", "研发队"),
    );
  });

  it("团队名按传入值渲染，不硬编码", () => {
    expect(buildTeamStateDeclaration("predefined", "alpha")).toContain("alpha");
    expect(buildTeamStateDeclaration("predefined", "alpha")).not.toContain("beta");
  });
});
