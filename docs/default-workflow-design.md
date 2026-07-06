# 默认工作流功能 — 详细设计方案

> 版本：v1.1  
> 日期：2026-06-10 (v1.1: onFailure 类型纠正为对象 `{returnToStage, condition}`，loops.stages 类型纠正为 `string[]` 引用)  
> 作者：Architect

---

## 目录

1. [数据模型设计](#1-数据模型设计)
2. [Schema 校验规则](#2-schema-校验规则)
3. [create/update 工具参数设计](#3-createupdate-工具参数设计)
4. [TL 提示词注入设计](#4-tl-提示词注入设计)
5. [自然语言对话配置](#5-自然语言对话配置)
6. [受影响文件及改动概要](#6-受影响文件及改动概要)
7. [实现顺序建议](#7-实现顺序建议)

---

## 1. 数据模型设计

### 1.1 WorkflowStage

定义工作流中一个步骤：由哪个成员执行、做什么、输入/输出是什么。

```typescript
/** 工作流中的一个步骤 */
export interface WorkflowStage {
  /** 执行此步骤的成员 name（必须匹配 TeamMember.name） */
  member: string;

  /** 步骤名称（英文标识符，如 "analyze"、"implement"），用于日志和引用 */
  name: string;

  /** 步骤描述 — 告诉 TL 此步骤的目标 */
  description: string;

  /**
   * 步骤输入描述 — 可选。指示此步骤期望接收什么输入。
   * 例如："上一个 stage 输出的代码分析报告"
   */
  input?: string;

  /**
   * 步骤输出描述 — 可选。指示此步骤产生什么输出。
   * 例如："重构后的代码文件和变更摘要"
   */
  output?: string;

  /**
   * 约束条件 — 可选。对执行此步骤的额外限制。
   * 例如："outputType == 'analysis'"
   */
  constraints?: string;

  /**
   * 步骤失败时的处理策略 — 可选。
   * 当 stage 失败时，TL 应将工作流回退到指定 stage 重新执行。
   * returnToStage: 回退到的 stage name（须引用主流程 stages 中的 name）
   * condition: 触发回退的条件（自然语言描述）
   */
  onFailure?: { returnToStage: string; condition: string };
}
```

### 1.2 WorkflowLoop

定义工作流中的循环段：满足什么条件时重复执行一组步骤。

```typescript
/** 工作流中的循环段 */
export interface WorkflowLoop {
  /**
   * 循环条件 — TL 判断是否继续循环的依据。
   * 例如："直到代码审查通过"、"直到测试覆盖率达到 80%"
   * 使用自然语言描述，TL 自行判断条件是否满足。
   */
  condition: string;

  /** 循环体内的步骤名称序列（引用主流程 stages 中的 name） */
  stages: string[];
}
```

### 1.3 TeamWorkflow

定义工作流的顶层结构，依附于 TeamDefinition。

```typescript
/**
 * 默认工作流 — 当 TL 启动 team 并分配任务时，
 * 按此工作流拆解任务、分派给各成员。
 */
export interface TeamWorkflow {
  /**
   * 工作流严格模式。
   * - "strict":   强制按工作流步骤顺序执行，TL 必须完成每个 stage 才能进入下一个
   * - "reference": 工作流作为参考和指南，TL 可根据实际情况调整顺序或跳过步骤
   */
  strictness: "strict" | "reference";

  /** 工作流描述 — 告诉 TL 这个工作流的目的 */
  description?: string;

  /** 工作流步骤序列（主流程） */
  stages: WorkflowStage[];

  /**
   * 循环段 — 可选。定义工作流中的循环执行部分。
   * 循环体内的 stages 在 condition 满足时反复执行。
   */
  loops?: WorkflowLoop[];
}
```

### 1.4 融入 TeamDefinition

将 `TeamWorkflow` 作为可选字段添加到 `TeamDefinition`：

```typescript
export interface TeamDefinition {
  name: string;
  description: string;
  defaults?: TeamDefaults;
  members: TeamMember[];

  /** 可选：默认工作流定义 */
  workflow?: TeamWorkflow;
}
```

#### YAML 序列化示例

**标准三方协作工作流：**

```yaml
name: "dev-team"
description: "标准三人开发团队，含架构师、编码员、审查员"
defaults:
  model: "anthropic/claude-sonnet-4"
members:
  - name: "architect"
    label: "架构师"
    systemPrompt: "你是一个软件架构师..."
  - name: "coder"
    label: "编码员"
    systemPrompt: "你是一个高级程序员..."
  - name: "reviewer"
    label: "审查员"
    systemPrompt: "你是一个代码审查专家..."

workflow:
  strictness: "reference"
  description: "标准开发工作流：分析 → 实现 → 审查"
  stages:
    - member: "architect"
      name: "analyze"
      description: "分析需求，设计方案"
      output: "设计方案文档"
    - member: "coder"
      name: "implement"
      description: "根据方案实现代码"
      input: "architect 的设计方案"
      output: "代码文件"
    - member: "reviewer"
      name: "review"
      description: "审查代码实现"
      input: "coder 的实现代码"
      output: "审查报告和审批"
  loops:
    - condition: "审查不通过需要修改"
      stages:
        - implement
        - review
```

**严格模式 CI/CD 流程：**

```yaml
workflow:
  strictness: "strict"
  stages:
    - member: "tester"
      name: "lint"
      description: "运行静态分析和 lint"
      onFailure:
        returnToStage: "lint"
        condition: "lint 未通过"
    - member: "tester"
      name: "test"
      description: "运行单元测试和集成测试"
      onFailure:
        returnToStage: "test"
        condition: "测试未通过"
    - member: "builder"
      name: "build"
      description: "构建制品"
      onFailure:
        returnToStage: "build"
        condition: "构建失败"
```

---

## 2. Schema 校验规则

### 2.1 workflow 字段整体校验

- `workflow` 类型须为 object 或 undefined
- 若存在则必须包含 `stages`（非空数组）
- `strictness` 可选，默认值 `"reference"`
- `description` 可选，string
- `loops` 可选，非空数组

### 2.2 stage 字段校验

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `member` | string | 是 | 必须匹配某个 `TeamMember.name` |
| `name` | string | 是 | 同一工作流内 stage names 唯一（含 loop 内 stages，loop 间 stages 名称可重复） |
| `description` | string | 是 | 非空 |
| `input` | string | 否 | — |
| `output` | string | 否 | — |
| `constraints` | string | 否 | — |
| `onFailure` | object | 否 | `{ returnToStage: string; condition: string }` — returnToStage 须引用主流程中某 stage 的 name |

### 2.3 strictness 校验

- 仅允许取值 `"strict"` 或 `"reference"`
- 默认值：`"reference"`
- 非法值直接报错

### 2.4 loop 校验

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `condition` | string | 是 | 非空 |
| `stages` | string[] | 是 | 至少一个，每个 string 须匹配主流程中某 stage 的 name |

### 2.5 交叉校验

- 所有 stage 的 `member` 字段必须引用 `TeamDefinition.members[].name`
- 主流程 stages + 所有 loops 内 stages 的 `name` 必须在各自作用域内唯一（loop 内 name 仅在该 loop 内唯一，不同 loop 间可重名；主流程 stages 全局唯一）
- 当 `strictness: "strict"` 时，主流程 stages 至少 1 个（已在 array 校验中覆盖）
- loops 内的 stages 不能引用不存在的 member name

### 2.6 Schema 校验代码结构

扩展 `src/team/schema.ts` 中的 `validateTeamDefinition` 函数：

```typescript
export function validateTeamDefinition(data: unknown): ValidationResult {
  const errors: string[] = [];
  // ... 现有校验 ...

  // 新增 workflow 校验
  if (data.workflow !== undefined) {
    validateWorkflow(data.workflow, data.members, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateWorkflow(
  workflow: unknown,
  members: TeamMember[],
  errors: string[]
): void {
  // 1. 类型校验
  // 2. strictness 校验（默认回退）
  // 3. stages 数组校验
  // 4. 逐个 stage 校验（含 member 引用存在性）
  // 5. loops 数组校验
  // 6. loop 内 stages 校验
}
```

---

## 3. create/update 工具参数设计

### 3.1 create_team_definition 工具

新增可选 `workflow` 参数：

```typescript
pi.registerTool({
  name: "create_team_definition",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      defaultModel: { type: "string" },
      members: { /* ... 现有 ... */ },
      workflow: {
        type: "object",
        description: "可选：定义团队的默认工作流。TL 按照此工作流拆解任务。",
        properties: {
          strictness: {
            type: "string",
            enum: ["strict", "reference"],
            description: "strict = 强制顺序执行, reference = 参考指南（默认）",
          },
          description: {
            type: "string",
            description: "工作流描述",
          },
          stages: {
            type: "array",
            items: {
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
                  properties: {
                    returnToStage: { type: "string", description: "回退到的 stage name（引用主流程 stages 中的 name）" },
                    condition: { type: "string", description: "触发回退的条件（自然语言描述）" },
                  },
                  required: ["returnToStage", "condition"],
                  description: "失败处理策略（可选）",
                },
              },
              required: ["member", "name", "description"],
            },
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
                  description: "循环体内的步骤名称（引用主流程 stages 中的 name）",
                },
              },
              required: ["condition", "stages"],
            },
            description: "可选：工作流中的循环段",
          },
        },
      },
    },
    required: ["name", "description", "members"],
  },
});
```

### 3.2 update_team_definition 工具

同 `create_team_definition` 的参数结构，允许用户修改或清除 workflow。

### 3.3 后端处理

```typescript
// 在 saveTeamDefinition 中：
const teamData = {
  name: params.name,
  description: params.description,
  defaults: params.defaultModel ? { model: params.defaultModel } : undefined,
  members: params.members.map(...),
  workflow: params.workflow,  // 透传
};
```

---

## 4. TL 提示词注入设计

### 4.1 注入位置

在 `index.ts` 的 `before_agent_start` 事件处理中，当 `session.active` 且有 `team.workflow` 时，向 `event.systemPrompt` 追加工作流指引。

### 4.2 Strict 模式提示词注入

```typescript
if (team.workflow?.strictness === "strict") {
  extraPrompt += `
### 工作流（严格模式 ⚡）

此团队定义了**默认工作流**，你必须严格按照以下步骤执行。

**规则：** 按顺序完成每个 stage。上一个 stage 完成前不得开始下一个。

**工作流描述：** ${team.workflow.description ?? "(无描述)"}

**步骤：**
${workflowStagesText}

${loopText}
`;
}
```

TL 行为期待：
- 收到任务后，按 stages 顺序向对应 member 发送任务
- 用 `team_send_and_wait` 等待每个 stage 完成
- 完成一个 stage 后才进入下一个
- 如果 stage 的 `onFailure` 配置了 `returnToStage`，该 stage 失败则回退到指定 stage 重新执行

### 4.3 Reference 模式提示词注入

```typescript
if (team.workflow?.strictness === "reference") {
  extraPrompt += `
### 工作流（参考模式 📋）

此团队定义了**默认工作流**作为工作参考。你**不必严格遵循**步骤顺序，可根据实际情况调整。

**工作流描述：** ${team.workflow.description ?? "(无描述)"}

**建议步骤：**
${workflowStagesText}

${loopText}

**注意：** 这是参考指南，不是强制流程。根据具体任务灵活调整。
`;
}
```

TL 行为期待：
- 收到任务后参考工作流拆解任务
- 可跳过不需要的步骤
- 可调整步骤顺序
- 可根据需要新增步骤

### 4.4 注入逻辑实现

在 `index.ts` 中现有的 `before_agent_start` 处理函数内，在 extraPrompt 组装阶段追加 workflow 内容：

```typescript
// 在 session.active && session.teamDefinition 分支内
const team = session.teamDefinition;

// 工作流注入
if (team.workflow) {
  const wf = team.workflow;

  // 格式化 stages 文本
  const stageText = (s: WorkflowStage, prefix: string) => {
    let txt = `${prefix}【${s.name}】${s.description}`;
    if (s.input) txt += `\n${prefix}  输入：${s.input}`;
    if (s.output) txt += `\n${prefix}  输出：${s.output}`;
    if (s.constraints) txt += `\n${prefix}  约束：${s.constraints}`;
    if (s.onFailure) txt += `\n${prefix}  失败处理：条件「${s.onFailure.condition}」→ 回退至「${s.onFailure.returnToStage}」`;
    return txt;
  };

  let workflowText = wf.description
    ? `\n\n### 工作流：${wf.description}\n`
    : `\n\n### 默认工作流\n`;

  if (wf.strictness === "strict") {
    workflowText += `模式：严格（按顺序执行，不跳过）\n\n`;
  } else {
    workflowText += `模式：参考（灵活调整）\n\n`;
  }

  wf.stages.forEach((s) => {
    workflowText += stageText(s, "") + "\n\n";
  });

  if (wf.loops && wf.loops.length > 0) {
    workflowText += `循环段：\n`;
    wf.loops.forEach((loop, i) => {
      workflowText += `  🔁 循环 ${i + 1}：条件「${loop.condition}」\n`;
      loop.stages.forEach((stageName) => {
        workflowText += `    → ${stageName}\n`;
      });
    });
  }

  extraPrompt += workflowText;
}
```

### 4.5 避免冗余注入

工作流提示词只在 `session.active && session.teamDefinition` 分支内注入，与现有 TL 角色提示词自然合并。若团队无 `workflow` 字段，行为不变。

---

## 5. 自然语言对话配置

### 5.1 /team create 中的工作流配置

在 `create` 子命令的 TL 提示词中，新增工作流配置引导：

#### 补充到现有 `isCreatingTeam` 提示词

在收集完成员信息后，TL 主动询问用户：

> "是否需要为此团队定义**默认工作流**？"
>
> 如果用户回答「是」：
> 1. **说明工作流的作用**：有工作流后，启动团队时 TL 会按照工作流步骤自动拆解任务
> 2. **询问 strictness**：用户希望对步骤执行严格要求还是灵活参考
> 3. **逐步骤收集**：每个步骤需要：执行成员（从已定义的成员中选择）、步骤名称、描述、可选输入输出
> 4. **询问是否需要循环**：例如「代码审查不通过时是否需要循环修改？」
> 5. 最后展示汇总确认

#### 对话流程示例

```
TL: 团队和成员都已配置好。是否需要为此团队定义默认工作流？
    有工作流后，我作为 TL 会按照定义好的步骤拆解任务。

用户: 需要

TL: 工作流支持两种模式：
    - 严格模式（strict）：按步骤顺序执行，不能跳过或调序
    - 参考模式（reference）：作为指南，可根据实际情况灵活调整
    你选择哪种？

用户: 参考模式

TL: 好的，参考模式。我们来定义步骤。
    团队有：架构师(architect)、编码员(coder)、审查员(reviewer)
    
    请描述第一个步骤。

用户: 首先架构师做设计，输出设计方案

TL: 收到。我这样定义：
    - 步骤名：design
    - 执行成员：architect
    - 描述：分析需求，输出设计方案
    - 输出：设计方案
    
    还需要添加其他约束吗（比如失败策略）？

用户: 不需要，继续下一步

TL: 下一步呢？

用户: coder 根据方案实现代码

TL: 好的：
    - 步骤名：implement
    - 执行成员：coder
    - 描述：根据设计方案实现代码
    - 输入：architect 的方案
    ...
```

### 5.2 /team edit 中的工作流修改

在 `edit` 子命令的 TL 提示词中，增加工作流修改指引：

```
可能的修改包括：
- 修改团队名称或描述
- 添加/修改/删除成员
- 添加/修改/删除工作流
- 修改工作流 strictness
- 添加/修改/删除工作流步骤
- 添加/修改/删除循环段
```

#### 对话场景示例

```
用户: 给 dev-team 添加工作流

TL: 明白。你需要什么模式？严格还是参考？

用户: 参考

TL: 请描述工作流步骤。

用户: architect → coder → reviewer 各一步
```

```
用户: 给测试团队的工作流添加一个 lint 步骤，放在 test 之前

TL: 明白，在 test 步骤前插入 lint 步骤：
    - 名称：lint
    - 执行成员：tester
    - 描述：运行静态分析和 lint 检查
    - 失败处理：条件「lint 未通过」→ 回退至 lint
    还有其他修改吗？
```

### 5.3 提示词改造

在 `index.ts` 的 `isCreatingTeam` 和 `editingTeamName` 提示词中追加：

**isCreatingTeam 提示词追加：**

```
### 工作流配置（可选）
成员收集完后，询问用户是否需要定义工作流。
如果有 workflow，TL 会按步骤工作。

对话流程：
1. 问用户是否需要工作流
2. 需要则问 strictness（strict/reference）
3. 逐步骤收集（member/name/description/input/output/constraints/onFailure — onFailure 含 returnToStage + condition）
4. 问是否需要循环段
5. 最后调用 create_team_definition 时一并提交
```

**editingTeamName 提示词追加：**

```
### 工作流修改
用户可能要求：
- 添加/删除/修改工作流
- 修改 strictness
- 增删改步骤
- 增删改循环段
处理后向用户展示汇总，调用 update_team_definition
```

---

## 6. 受影响文件及改动概要

### 6.1 新增文件

| 文件 | 内容 | 预估行数 |
|------|------|----------|
| `src/workflow/types.ts` | WorkflowStage、WorkflowLoop、TeamWorkflow 接口定义 | ~60 |
| `src/workflow/validate.ts` | 工作流专用校验函数（可被 schema.ts 调用） | ~120 |
| `src/workflow/prompt.ts` | 生成工作流提示词文本的辅助函数 | ~80 |

**或**：将 types 合并到 `src/team/definition.ts`，validate 合并到 `src/team/schema.ts`，prompt 合并到 `index.ts`（推荐折中见下方）

### 6.2 现有文件改动

| 文件 | 改动内容 | 预估改动行数 |
|------|----------|-------------|
| `src/team/definition.ts` | 添加 `workflow?: TeamWorkflow` 到 `TeamDefinition` | +1 |
| `src/team/schema.ts` | 新增 `validateWorkflow()` 函数，在 `validateTeamDefinition` 中调用 | +80~100 |
| `src/commands/team.ts` | `saveTeamDefinition()` 中透传 `workflow` 字段 | +2 |
| `index.ts` | `before_agent_start` 中注入工作流提示词（约 +40 行）；`isCreatingTeam` 和 `editingTeamName` 提示词追加工作流配置引导（约 +20 行） | +60~80 |
| 测试文件 | schema 新增测试用例、prompt 注入测试 | +100~150 |

### 6.3 不走动的文件

以下文件无需改动：

- `member.ts` — 工作流只影响 TL 行为
- `src/tools/tl-tools.ts` — TL 工具逻辑不变
- `src/session/*` — 状态管理不变
- `src/channel/*` — 消息通道不变
- `src/process/*` — 进程管理不变
- `src/setup/*` — 启动逻辑不变
- `src/team/store.ts` — YAML 读写天然支持新字段
- `src/ui/*` — UI 组件不变

### 6.4 总改动量评估

- 新增代码：~120 行（若 types 合入 definition.ts 约 60 行）
- 改动现有代码：~150 行
- 新增测试：~100-150 行
- **总计：~350-400 行新增/改动**（不含测试约 250 行）

---

## 7. 实现顺序建议

### 7.1 三个阶段

#### 阶段一：核心数据模型 + Schema 校验（~120 行代码）

**内容：**
1. 在 `src/team/definition.ts` 中添加 `WorkflowStage`、`WorkflowLoop`、`TeamWorkflow` 接口
2. 在 `TeamDefinition` 中添加 `workflow?: TeamWorkflow`
3. 在 `src/team/schema.ts` 中添加 `validateWorkflow()` 函数

**测试策略：**
- 测试接口定义正确导出（TypeScript compile check）
- 测试 `validateWorkflow()` 的各种合法/非法输入
- 测试 `validateTeamDefinition()` 集成 workflow 校验

```typescript
// 测试用例示例
it("validates workflow with correct members", () => {
  const data = {
    name: "test",
    description: "test",
    members: [{ name: "m1", systemPrompt: "be helpful" }],
    workflow: {
      strictness: "reference",
      stages: [{ member: "m1", name: "step1", description: "do something" }],
    },
  };
  expect(validateTeamDefinition(data).valid).toBe(true);
});

it("rejects workflow stage referencing non-existent member", () => {
  // ...
  expect(result.errors[0]).toContain("non-existent");
});
```

#### 阶段二：TL 提示词注入（~80 行代码）

**内容：**
1. 在 `index.ts` 的 `before_agent_start` 中添加工作流提示词注入逻辑
2. 格式化 stages 和 loops 为可读文本
3. strict 模式 vs reference 模式不同提示词

**测试策略：**
- 功能测试：mock `getSessionState` 返回含 workflow 的 session，验证 `before_agent_start` handler 输出的 `systemPrompt` 包含预期的工作流文本
- 边界测试：无 workflow、空 loops、多种 onFailure 组合

```typescript
// 测试思路
it("injects strict workflow prompt when workflow.strictness is strict", () => {
  const result = beforeAgentStartHandler(event, ctx);
  expect(result.systemPrompt).toContain("严格模式");
  expect(result.systemPrompt).toContain("按顺序执行");
});

it("does not inject workflow prompt when no workflow defined", () => {
  // 验证提示词不包含工作流相关内容
});
```

#### 阶段三：create/edit 自然语言配置（~50 行改动）

**内容：**
1. 在 `index.ts` 的 `isCreatingTeam` 提示词中追加工作流配置引导
2. 在 `index.ts` 的 `editingTeamName` 提示词中追加工作流修改引导
3. 在 `src/commands/team.ts` 的 `saveTeamDefinition` 中透传 `workflow` 字段

**测试策略：**
- 功能测试：mock `create_team_definition` 调用，验证传入的 workflow 参数正确透传到 YAML
- E2E 测试：手动测试 /team create 完整流程，验证工作流被正确保存和展示
- 回归测试：已有团队（无 workflow）的 create/edit 不受影响

```typescript
it("persists workflow field when provided", () => {
  // 模拟 create_team_definition 带 workflow 参数
  // 验证 writeTeam 被正确调用
});
```

### 7.2 依赖关系

```
阶段一（数据模型 + Schema）
    └─ 阶段二（提示词注入）—— 依赖阶段一的数据类型
        └─ 阶段三（create/edit 配置）—— 依赖阶段二的提示词框架
```

阶段一可独立测试和发布。阶段二依赖阶段一。阶段三依赖阶段二。

### 7.3 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| YAML 序列化天然支持新字段，但反序列化时不识别将静默丢弃 | store.ts 的 readTeam 已用 validateTeamDefinition 校验；失败会 warn 并返回 null。阶段一的 schema 校验确保识别。 |
| 提示词过长影响 TL 上下文窗口 | 工作流提示词控制在 500 字符以内；包含 loops 时按需截断 |
| strict 模式下 TL 可能跳过步骤 | 提示词明确规则，并在 strict 模式提示词中重复强调 |
| 用户配置工作流后想取消 | 可通过 /team edit 移除 workflow 字段（TL 引导） |

---

## 附录：文件改动对照

```
src/team/definition.ts           +1 行（workflow? 字段）
src/team/schema.ts               +80~100 行（validateWorkflow 函数）
src/commands/team.ts             +2 行（workflow 透传）
index.ts                         +60~80 行（提示词注入 + 对话引导）
--- 新增测试 ---
src/team/schema.test.ts          +40~60 行
src/team/definition.test.ts      +20 行（YAML round-trip）
index.test.ts                    +40~60 行（提示词注入验证）
```
