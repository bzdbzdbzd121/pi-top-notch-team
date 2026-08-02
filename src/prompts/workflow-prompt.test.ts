import { describe, it, expect } from "vitest";
import { buildWorkflowPrompt, WORKFLOW_ACTIVATION_BANNER } from "./workflow-prompt";
import type { TeamWorkflow } from "../team/definition";

const baseWorkflow: TeamWorkflow = {
  strictness: "strict",
  description: "双分析员独立分析 → 裁决 → 实现",
  stages: [
    {
      member: "analyzer-1",
      name: "analyze-1",
      description: "独立分析代码仓",
      output: "分析报告-1",
      constraints: "输出到临时目录",
    },
    {
      member: "analyzer-2",
      name: "analyze-2",
      description: "从不同视角独立分析",
      input: "同一代码仓",
      onFailure: { returnToStage: "analyze-1", condition: "报告不完整" },
    },
  ],
  loops: [{ condition: "还有未完成任务", stages: ["analyze-1", "analyze-2"] }],
};

describe("buildWorkflowPrompt", () => {
  it("returns empty string when workflow is undefined", () => {
    expect(buildWorkflowPrompt(undefined)).toBe("");
  });

  it("labels the section as 团队工作流 (matches user's 「团队流程」 phrasing)", () => {
    const text = buildWorkflowPrompt(baseWorkflow);
    expect(text).toContain("团队工作流");
    expect(text).not.toContain("默认工作流");
  });

  it("marks strict mode as mandatory", () => {
    const text = buildWorkflowPrompt(baseWorkflow);
    expect(text).toContain("严格模式");
    expect(text).toContain("不得跳过、调序、合并 stage");
    expect(text).toContain("严格模式附加规则");
  });

  it("reference mode defaults to following the workflow and requires justification for deviation", () => {
    const text = buildWorkflowPrompt({ ...baseWorkflow, strictness: "reference" });
    expect(text).toContain("参考模式");
    expect(text).toContain("默认按以下步骤顺序执行");
    expect(text).toContain("向用户说明理由");
    expect(text).not.toContain("尽可能遵循");
    expect(text).not.toContain("严格模式附加规则");
  });

  it("surfaces the stage executor prominently instead of a trailing parenthetical", () => {
    const text = buildWorkflowPrompt(baseWorkflow);
    expect(text).toContain("【analyze-1】→ 执行者：`analyzer-1`");
    expect(text).toContain("【analyze-2】→ 执行者：`analyzer-2`");
  });

  it("includes stage input/output/constraints/onFailure details", () => {
    const text = buildWorkflowPrompt(baseWorkflow);
    expect(text).toContain("输入：同一代码仓");
    expect(text).toContain("输出：分析报告-1");
    expect(text).toContain("约束：输出到临时目录");
    expect(text).toContain("失败处理：如「报告不完整」→ 回退至「analyze-1」");
  });

  it("renders loop sections", () => {
    const text = buildWorkflowPrompt(baseWorkflow);
    expect(text).toContain("循环段");
    expect(text).toContain("条件「还有未完成任务」→ 重复步骤：analyze-1、analyze-2");
  });

  it("contains an operational execution protocol (activation, dispatch, sequencing, no self-execution)", () => {
    const text = buildWorkflowPrompt(baseWorkflow);
    // activation trigger mapping user's phrasing to workflow activation
    expect(text).toContain("激活条件");
    expect(text).toContain("团队流程");
    // dispatch mechanics
    expect(text).toContain("team_send_and_wait");
    // TL must not execute stages itself
    expect(text).toContain("绝不亲自执行 stage");
    // sequential semantics
    expect(text).toContain("才派发下一个 stage");
    // parallel batch guidance
    expect(text).toContain("tasks 批量派发");
    // failure + loops
    expect(text).toContain("onFailure 回退");
    // progress reporting
    expect(text).toContain("stage N/M");
  });

  it("handles a workflow without optional fields", () => {
    const minimal: TeamWorkflow = {
      strictness: "reference",
      stages: [{ member: "a", name: "s1", description: "do something" }],
    };
    const text = buildWorkflowPrompt(minimal);
    expect(text).toContain("【s1】→ 执行者：`a`");
    expect(text).not.toContain("循环段");
    expect(text).not.toContain("**流程描述：**");
  });
});

describe("WORKFLOW_ACTIVATION_BANNER", () => {
  it("points to the workflow section and forbids self-analysis", () => {
    expect(WORKFLOW_ACTIVATION_BANNER).toContain("团队工作流");
    expect(WORKFLOW_ACTIVATION_BANNER).toContain("不得自己开工分析");
  });
});
