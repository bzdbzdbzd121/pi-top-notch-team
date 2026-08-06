import { describe, it, expect } from "vitest";
import { buildDynamicModePrompt } from "./dynamic-mode";
import type { TeamDefinition } from "../team/definition";

const emptyTeam: TeamDefinition = {
  name: "_dynamic_test",
  description: "测试动态团队",
  members: [],
};

const teamWithMembers: TeamDefinition = {
  ...emptyTeam,
  members: [
    { name: "coder", label: "编码员", systemPrompt: "你是一个高级程序员，负责实现代码。" },
    { name: "reviewer", label: "审查员", systemPrompt: "你是一个代码审查专家，负责审查实现。" },
  ],
};

describe("buildDynamicModePrompt — design phase", () => {
  const prompt = buildDynamicModePrompt(emptyTeam, "design", "sess-1");

  it("标注为设计阶段", () => {
    expect(prompt).toContain("设计阶段");
  });

  it("包含六阶段设计流程", () => {
    expect(prompt).toContain("阶段 A：需求对齐");
    expect(prompt).toContain("阶段 B：任务拆分");
    expect(prompt).toContain("阶段 C：工作流编排与质量加固");
    expect(prompt).toContain("阶段 D：团队设计");
    expect(prompt).toContain("阶段 E：方案确认门");
    expect(prompt).toContain("阶段 F：落地执行");
  });

  it("包含确认门硬性规则（用户确认前禁止注册/启动成员）", () => {
    expect(prompt).toContain("禁止调用 `add_dynamic_member` 和 `start_member`");
  });

  it("注入 orchestration playbook 内容", () => {
    // playbook 的关键标志内容
    expect(prompt).toContain("TL 编排方法论 Playbook");
    expect(prompt).toContain("并行冗余 + 交叉验证");
    expect(prompt).toContain("对抗辩论");
    expect(prompt).toContain("开发-审核循环");
    expect(prompt).toContain("默认假设：agent 会犯错");
    expect(prompt).toContain("分批循环处理");
  });

  it("包含设计阶段铁律（工具硬阻断说明 + read 软限制）", () => {
    expect(prompt).toContain("铁律");
    expect(prompt).toContain("bash");
    // read 是允许的（软限制），不再是硬阻断
    expect(prompt).not.toContain("不能读取任何文件");
    expect(prompt).toContain("✅ read");
    expect(prompt).toContain("再次调用 read 即可放行");
  });

  it("空团队时提示使用 add_dynamic_member", () => {
    expect(prompt).toContain("add_dynamic_member");
    expect(prompt).toContain("尚无成员");
  });

  it("展示已注册成员", () => {
    const p = buildDynamicModePrompt(teamWithMembers, "design");
    expect(p).toContain("coder（编码员）");
    expect(p).toContain("reviewer（审查员）");
  });
});

describe("buildDynamicModePrompt — execution phase", () => {
  const prompt = buildDynamicModePrompt(teamWithMembers, "execution");

  it("标注为执行阶段", () => {
    expect(prompt).toContain("执行阶段");
  });

  it("包含铁律：不做 Member 能做的事", () => {
    expect(prompt).toContain("铁律");
    expect(prompt).toContain("绝不能自己做");
  });

  it("包含第一动作协议，且位于铁律段落之前", () => {
    expect(prompt).toContain("第一动作协议");
    expect(prompt).toContain("start_member` 或 `team_send_and_wait");
    const idxProtocol = prompt.indexOf("第一动作协议");
    const idxIronRule = prompt.indexOf("铁律：你绝不能自己做");
    expect(idxProtocol).toBeGreaterThan(-1);
    expect(idxIronRule).toBeGreaterThan(-1);
    expect(idxProtocol).toBeLessThan(idxIronRule);
  });

  it("不注入 playbook（playbook 仅设计阶段使用）", () => {
    expect(prompt).not.toContain("TL 编排方法论 Playbook");
  });
});
