import { describe, it, expect } from "vitest";
import { buildDynamicModePrompt } from "./dynamic-mode";
import { buildAgentInitiatedPrompt } from "./agent-initiated-mode";
import { TASK_DISPATCH_GUIDELINES, TASK_DISPATCH_PROTOCOL_PROMPT } from "./task-dispatch-protocol";

const team = { name: "test", description: "test team", members: [] };

describe("task dispatch protocol", () => {
  it("defines per-task boundaries, including follow-up work, without verbose boilerplate", () => {
    const text = TASK_DISPATCH_GUIDELINES.join("\n");
    for (const field of ["目标", "非目标", "修改范围", "验收标准"]) {
      expect(text).toContain(field);
    }
    expect(text).toContain("每个 tasks[].content");
    expect(text).toContain("补派、返工");
    expect(text).toContain("简单任务");
    expect(text).toContain("针对本次任务");
    expect(text).toContain("只读、不修改");
    expect(text).toContain("报告路径");
    expect(text).toContain("先派只读侦察");
    expect(text).toContain("扩围");
    expect(text).toContain("验收后停止");
    expect(text).toContain(".shared-context.md");
    // pi appends guidelines flat, so each bullet must identify its tool.
    expect(TASK_DISPATCH_GUIDELINES.every(line => line.includes("team_send_and_wait"))).toBe(true);
    for (const line of TASK_DISPATCH_GUIDELINES) {
      expect(TASK_DISPATCH_PROTOCOL_PROMPT).toContain(line);
    }
  });

  it.each(["design", "execution"] as const)("injects the shared protocol once in dynamic %s", phase => {
    const prompt = buildDynamicModePrompt(team, phase);
    expect(prompt.split(TASK_DISPATCH_PROTOCOL_PROMPT)).toHaveLength(2);
  });

  it.each(["design", "execution"] as const)("injects the shared protocol once in agent-initiated %s", phase => {
    const prompt = buildAgentInitiatedPrompt(team, phase, "session", "fix bug");
    expect(prompt.split(TASK_DISPATCH_PROTOCOL_PROMPT)).toHaveLength(2);
  });
});
