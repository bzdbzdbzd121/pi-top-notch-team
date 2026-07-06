/**
 * Shared workflow parameter schemas used by create and update team definition tools.
 */

export const workflowStageSchema = {
  type: "object",
  properties: {
    member: { type: "string", description: "执行此步骤的成员 name" },
    name: { type: "string", description: "步骤标识符" },
    description: { type: "string", description: "步骤描述" },
    input: { type: "string", description: "步骤输入描述（可选）" },
    output: { type: "string", description: "步骤输出描述（可选）" },
    constraints: { type: "string", description: "约束条件（可选）" },
    onFailure: {
      type: "object",
      description: "失败处理策略（可选）：回退到指定 stage",
      properties: {
        returnToStage: { type: "string", description: "回退到的 stage name" },
        condition: { type: "string", description: "触发回退的条件" },
      },
      required: ["returnToStage", "condition"],
    },
  },
  required: ["member", "name", "description"],
};

export const workflowSchema = {
  type: "object",
  description: "可选：定义团队的默认工作流。TL 按照此工作流拆解任务。",
  properties: {
    strictness: {
      type: "string",
      enum: ["strict", "reference"],
      description: "strict = 强制顺序执行, reference = 参考指南（默认）",
    },
    description: { type: "string", description: "工作流描述" },
    stages: {
      type: "array",
      items: workflowStageSchema,
      description: "工作流步骤序列（至少一个）",
    },
    loops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          condition: { type: "string", description: "循环条件（自然语言描述）" },
          stages: {
            type: "array",
            items: { type: "string" },
            description: "循环体内的步骤名称序列（引用主流程 stage names）",
          },
        },
        required: ["condition", "stages"],
      },
      description: "可选：工作流中的循环段",
    },
  },
};
