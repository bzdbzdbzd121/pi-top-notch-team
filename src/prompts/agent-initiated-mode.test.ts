import { describe, it, expect } from "vitest";
import { buildAgentInitiatedPrompt } from "./agent-initiated-mode";
import type { TeamDefinition } from "../team/definition";

const baseTeam: TeamDefinition = {
  name: "_dynamic_123",
  description: "动态团队",
  members: [],
};

const teamWithMembers: TeamDefinition = {
  ...baseTeam,
  members: [
    { name: "analyzer", label: "分析员", systemPrompt: "You analyze code" },
    { name: "coder", label: "编码员", systemPrompt: "You write code" },
  ],
};

const TASK = "重构 src/channel 模块，拆分为独立包；验收：npm test 全绿、无循环依赖";

describe("buildAgentInitiatedPrompt (ADR-0003)", () => {
  describe("design phase", () => {
    const prompt = buildAgentInitiatedPrompt(baseTeam, "design", "sess-1", TASK);

    it("embeds the mission statement", () => {
      expect(prompt).toContain(TASK);
    });

    it("states full autonomy (no confirmation gate)", () => {
      expect(prompt).toContain("无需等待用户确认");
    });

    it("does NOT contain the orchestration playbook / grilling / confirmation gate", () => {
      expect(prompt).not.toContain("Playbook");
      expect(prompt).not.toContain("Grilling");
      expect(prompt).not.toContain("方案确认门");
      expect(prompt).not.toContain("阶段 E");
    });

    it("does NOT contain the first-action protocol (dispatch policing removed)", () => {
      expect(prompt).not.toContain("第一动作协议");
    });

    it("allows free reading for reconnaissance", () => {
      expect(prompt).toContain("自由读取");
      expect(prompt).toContain("无读取频率限制");
    });

    it("allows ALL tools in the design phase (write/edit/bash unrestricted)", () => {
      expect(prompt).not.toContain("不得写代码文件");
      expect(prompt).not.toContain("设计阶段不可用");
      expect(prompt).toContain("全部工具可用");
      expect(prompt).toContain("任意扩展名");
    });

    it("keeps delegation-first as a SOFT guideline, not a hard block", () => {
      expect(prompt).toContain("把重活交给成员");
      expect(prompt).toContain("修补/收尾/验证");
      expect(prompt).not.toContain("系统硬阻断");
    });

    it("keeps the .shared-context.md write_shared_context contract", () => {
      expect(prompt).toContain(".shared-context.md");
      expect(prompt).toContain("write_shared_context");
    });

    it("guides the autonomous landing sequence", () => {
      expect(prompt).toContain("add_dynamic_member");
      expect(prompt).toContain("write_shared_context");
      expect(prompt).toContain("start_member");
      expect(prompt).toContain("stop_team_session");
    });

    it("lists registered members when present", () => {
      const p = buildAgentInitiatedPrompt(teamWithMembers, "design", "sess-1", TASK);
      expect(p).toContain("analyzer（分析员）");
      expect(p).toContain("coder（编码员）");
    });
  });

  describe("execution phase", () => {
    const prompt = buildAgentInitiatedPrompt(teamWithMembers, "execution", "sess-1", TASK);

    it("embeds the mission statement", () => {
      expect(prompt).toContain(TASK);
    });

    it("does NOT contain the first-action protocol", () => {
      expect(prompt).not.toContain("第一动作协议");
    });

    it("states read/analysis freedom without dispatch policing", () => {
      expect(prompt).toContain("无派发管制守卫");
    });

    it("replaces the hard code-write boundary with write discipline", () => {
      expect(prompt).not.toContain("不得写代码文件");
      expect(prompt).not.toContain("一律委派给成员");
      expect(prompt).not.toContain("系统硬阻断");
      // 自由编辑 + 写纪律（共享文件系统）
      expect(prompt).toContain("任意扩展名");
      expect(prompt).toContain("编辑前确认");
      expect(prompt).toContain("避免互相覆盖");
      expect(prompt).toContain("重新验证");
      // 委派为主、亲手为辅（兜底能力）
      expect(prompt).toContain("兜底");
    });

    it("defines the closing sequence: verify → finish_goal → report → stop_team_session", () => {
      expect(prompt).toContain("汇总并验证");
      expect(prompt).toContain("向用户汇报最终结果");
      expect(prompt).toContain("finish_goal");
      expect(prompt).toContain("stop_team_session");
      // 顺序：finish_goal 必须在最终汇报之前（弱模型汇报后可能直接结束回合）
      const verifyIdx = prompt.indexOf("汇总并验证");
      const finishIdx = prompt.indexOf("调用 \`finish_goal\`");
      const reportIdx = prompt.indexOf("向用户汇报最终结果");
      const stopIdx = prompt.indexOf("stop_team_session");
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(verifyIdx).toBeLessThan(finishIdx);
      expect(finishIdx).toBeLessThan(reportIdx);
      expect(reportIdx).toBeLessThan(stopIdx);
    });

    it("mandates the goal closing protocol (finish_goal on completion or blocker, no verbal-only claims)", () => {
      expect(prompt).toContain("调用 \`finish_goal\` 关闭目标提醒");
      expect(prompt).toContain("禁止仅口头宣称");
      expect(prompt).toContain("不可解决的阻塞");
    });

    it("documents user intervention channels", () => {
      expect(prompt).toContain("/team stop");
      expect(prompt).toContain("alt+t");
    });
  });
});
