/**
 * 阶段 4（方案 §3.4.1 #6）：成员重启指引是**单一事实来源**——预定义团队提示词与
 * 动态模式执行阶段提示词各注入同一常量，避免两处硬编码副本漂移成相反指引。
 */
import { describe, it, expect } from "vitest";
import { MEMBER_RESTART_GUIDANCE } from "./member-restart-guidance";
import { buildDynamicModePrompt } from "./dynamic-mode";
import type { TeamDefinition } from "../team/definition";

const team: TeamDefinition = {
  name: "_dynamic_guidance",
  description: "测试动态团队",
  members: [{ name: "coder", label: "编码员", systemPrompt: "实现代码" }],
};

function dynamicPrompt(phase: "design" | "execution"): string {
  return buildDynamicModePrompt(team, phase, "sid", {
    selfWorkGuard: { enabled: true, threshold: 3 },
  });
}

describe("MEMBER_RESTART_GUIDANCE", () => {
  it("含三类可判定的重启理由（崩溃 / 长时间无响应 / 跑偏）", () => {
    expect(MEMBER_RESTART_GUIDANCE).toContain("进程崩溃");
    expect(MEMBER_RESTART_GUIDANCE).toContain("长时间无响应");
    expect(MEMBER_RESTART_GUIDANCE).toContain("跑偏");
    // 三类理由逐条编号，不是一段模糊描述
    expect(MEMBER_RESTART_GUIDANCE).toContain("1. 进程崩溃");
    expect(MEMBER_RESTART_GUIDANCE).toContain("2. 进程长时间无响应");
    expect(MEMBER_RESTART_GUIDANCE).toContain("3. 成员明显跑偏");
  });

  it("写明默认续接与 fresh 的代价和边界", () => {
    expect(MEMBER_RESTART_GUIDANCE).toContain("默认**续接**");
    expect(MEMBER_RESTART_GUIDANCE).toContain("对话与任务历史都保留");
    expect(MEMBER_RESTART_GUIDANCE).toContain("start_member({ name, fresh: true })");
    expect(MEMBER_RESTART_GUIDANCE).toContain("旧会话归档");
    expect(MEMBER_RESTART_GUIDANCE).toContain("/team clean");
    // fresh 的边界：不回滚文件、不动共享上下文
    expect(MEMBER_RESTART_GUIDANCE).toContain("**不回滚**");
    expect(MEMBER_RESTART_GUIDANCE).toContain("共享上下文照常生效");
  });

  it("不再保留旧口径（仅当进程异常时才重启）", () => {
    expect(MEMBER_RESTART_GUIDANCE).not.toContain("仅当成员进程异常时");
  });

  it("动态模式执行阶段逐字节注入同一常量（设计阶段不注入）", () => {
    const execution = dynamicPrompt("execution");
    expect(execution).toContain(MEMBER_RESTART_GUIDANCE);

    const design = dynamicPrompt("design");
    expect(design).not.toContain(MEMBER_RESTART_GUIDANCE);
  });

  it("两处工具清单行包含 fresh? 与「默认续接」（逐字一致）", () => {
    const execution = dynamicPrompt("execution");
    const line = execution
      .split("\n")
      .find((entry) => entry.includes("start_member(name, fresh?)"));
    expect(line).toBeDefined();
    expect(line).toContain("默认续接");
  });

  it("agent 自主会话提示词不注入该常量（D9：那两处提示词已很长，不重复）", async () => {
    const { buildAgentInitiatedPrompt } = await import("./agent-initiated-mode");
    for (const phase of ["design", "execution"] as const) {
      const prompt = buildAgentInitiatedPrompt(team, phase, "sid", "使命");
      expect(prompt).not.toContain(MEMBER_RESTART_GUIDANCE);
      expect(prompt).not.toContain("只有三类情况才重启成员");
    }
  });
});
