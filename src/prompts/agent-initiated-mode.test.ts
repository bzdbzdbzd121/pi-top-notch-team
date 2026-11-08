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

    it("does NOT contain the persistent state declaration (agent started the session itself)", () => {
      // 自主会话由 agent 自己发起，它已经知情——再告诉它「你刚进入」是噪音。
      expect(prompt).not.toContain("状态：你正在团队会话中");
      expect(prompt).not.toContain("当前唯一有效的状态");
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

    it("design sequence starts with naming (suggested; frozen once members start)", () => {
      const seq = prompt.slice(
        prompt.indexOf("### 推进顺序"),
        prompt.indexOf("### 当前团队")
      );
      expect(seq).toContain("set_team_name");
      expect(seq).toContain("命名团队（建议）");
      expect(seq).toContain("成员启动后不能再改名");
      expect(seq).toContain("不是开工条件");
      // Naming comes first: it must precede task splitting and member registration.
      const nameIdx = seq.indexOf("命名团队");
      const splitIdx = seq.indexOf("任务拆分");
      const addIdx = seq.indexOf("注册成员");
      expect(nameIdx).toBeGreaterThan(-1);
      expect(nameIdx).toBeLessThan(splitIdx);
      expect(nameIdx).toBeLessThan(addIdx);
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

    it("does NOT contain the persistent state declaration", () => {
      expect(prompt).not.toContain("状态：你正在团队会话中");
      expect(prompt).not.toContain("当前唯一有效的状态");
    });

    it("states read/analysis freedom without dispatch policing", () => {
      expect(prompt).toContain("无派发管制守卫");
    });

    it("does NOT carry a naming requirement (the name freezes before this phase)", () => {
      expect(prompt).not.toContain("必须先命名");
      expect(prompt).not.toContain("不命名");
      expect(prompt).not.toContain("set_team_name");
      expect(prompt).not.toMatch(/命名[^。\n]*(拦截|禁止)/);
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

// ── 阶段 3 回归锁：旁路来源不得声称运行时检测 ────────────────────────
describe("agent-initiated prompt — 不含 TL 亲自分析限制的运行时措辞", () => {
  it("design / execution 两阶段都不出现「运行时检测」与「持续拦截」", () => {
    // agent 自主会话整体旁路两个限制器（ADR-0003）；若将来有人把
    // buildFirstActionProtocolPrompt 误注入这里，模型会读到一条当场可证伪的
    // 「会拦截」陈述——这条用例就是那道护栏。
    for (const phase of ["design", "execution"] as const) {
      const prompt = buildAgentInitiatedPrompt(teamWithMembers, phase, "sess-1", TASK);
      expect(prompt).not.toContain("运行时检测");
      expect(prompt).not.toContain("持续拦截");
      expect(prompt).not.toMatch(/超过\s*\d+\s*次/);
    }
  });
});
