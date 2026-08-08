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

    it("keeps the code-write boundary (structural safety)", () => {
      expect(prompt).toContain("不得写代码文件");
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

    it("keeps the code-write boundary with filesystem rationale", () => {
      expect(prompt).toContain("共享同一文件系统");
    });

    it("defines the closing sequence: report → finish_goal → stop_team_session", () => {
      expect(prompt).toContain("向用户汇报");
      expect(prompt).toContain("finish_goal");
      expect(prompt).toContain("stop_team_session");
    });

    it("documents user intervention channels", () => {
      expect(prompt).toContain("/team stop");
      expect(prompt).toContain("alt+t");
    });
  });
});
