# 默认工作流功能 — 任务拆解方案

> 基于：`.shared-context.md`（需求）+ `docs/default-workflow-design.md`（设计方案）  
> 注意：设计方案中 `onFailure` 和 `loops.stages` 需按用户确认纠正

---

## 阶段一：核心数据模型 + Schema 校验（1 个任务）

**改动文件：** `src/team/definition.ts` + `src/team/schema.ts`

**改动内容：**

### definition.ts
- 新增 `WorkflowStage` 接口
  - `member: string` — 成员 name
  - `name: string` — 阶段标识符
  - `description: string`
  - `input?: string`
  - `output?: string`
  - `constraints?: string`
  - **`onFailure?: { returnToStage: string; condition: string }`** ← 纠正：对象而非枚举
- 新增 `WorkflowLoop` 接口
  - `condition: string` — while 条件（自然语言）
  - **`stages: string[]`** ← 纠正：引用主流程 stage names，非内嵌对象
- 新增 `TeamWorkflow` 接口
  - `strictness: "strict" | "reference"`
  - `description?: string`
  - `stages: WorkflowStage[]`
  - `loops?: WorkflowLoop[]`
- `TeamDefinition` 增加 `workflow?: TeamWorkflow`

### schema.ts
- 新增 `validateWorkflow(workflow, members, errors)` 函数
- 校验规则：
  - workflow 整体类型校验（object / undefined）
  - `strictness` 取值 `"strict"` | `"reference"`，默认 `"reference"`
  - `stages` 非空数组
  - 逐 stage 校验：member 必须匹配 TeamMember.name，name 在主流程+loop 内唯一，description 非空
  - **`onFailure` 校验为对象**，含 `returnToStage`（string, 引用有效 stage name）和 `condition`（string, 非空）
  - `loops` 校验：condition 非空，**`stages` 为 string[] 且每个 string 须匹配主流程中某 stage 的 name**
  - member 交叉引用校验

**子任务清单：**
1. 定义 `WorkflowStage` / `WorkflowLoop` / `TeamWorkflow` 接口到 definition.ts
2. `TeamDefinition` 增加 `workflow?` 字段
3. 实现 `validateWorkflow()` 函数到 schema.ts
4. 在 `validateTeamDefinition()` 中集成 workflow 校验调用
5. 导出新类型到模块入口

**依赖：** 无（可独立开发测试）

---

## 阶段二：TL 提示词注入（1 个任务）

**改动文件：** `index.ts`

**改动内容：**
- 在 `before_agent_start` 事件处理中，`session.active && session.teamDefinition` 分支内
- 当 `team.workflow` 存在时，组装工作流提示词追加到 `extraPrompt`
- 格式化逻辑：
  - Strict 模式 → "严格模式" 提示词 + 强制顺序执行规则
  - Reference 模式 → "参考模式" 提示词 + 灵活调整说明
  - 展示 stages（member/name/description/input/output/constraints/onFailure）
  - 展示 loops（condition + 引用 stages）
- 无 workflow 时行为不变（不注入）

**子任务清单：**
1. 实现 `formatWorkflowPrompt()` 辅助函数（format stages + loops 为可读文本）
2. 在 `before_agent_start` handler 中调用并追加到 `extraPrompt`
3. strict 与 reference 模式差异化提示词文本

**依赖：** 阶段一（类型定义）

---

## 阶段三：create/edit 自然语言配置 + 工具参数（1 个任务）

**改动文件：** `index.ts` + `src/commands/team.ts`

**改动内容：**

### index.ts — 对话提示词
- **`isCreatingTeam` 提示词追加**：成员收集完后，TL 询问是否需要工作流 → 问 strictness → 逐步骤收集（member/name/description/input/output/constraints/onFailure）→ 问是否需要循环段 → 汇总确认后调用 `create_team_definition`
- **`editingTeamName` 提示词追加**：支持工作流增删改（添加/删除/修改工作流、修改 strictness、增删改步骤、增删改循环段）

### commands/team.ts — 工具参数
- `create_team_definition` 和 `update_team_definition` 工具注册中增加 `workflow` 参数（JSON schema）
- `saveTeamDefinition()` 透传 `workflow` 字段
- `/team show` 展示 workflow 详情（格式化显示 stages + loops）

**子任务清单：**
1. `create_team_definition` params 增加 workflow（含 stages/loops/strictness/description）
2. `update_team_definition` params 同结构
3. `saveTeamDefinition()` 透传 workflow 到 YAML
4. `/team show` 展示 workflow 内容
5. `isCreatingTeam` 提示词追加工作流引导
6. `editingTeamName` 提示词追加工作流修改引导

**依赖：** 阶段一（类型定义），推荐阶段二完成后（提示词风格一致）

---

## 阶段四：测试（1 个综合任务）

**改动文件：** 新增/修改测试文件

**改动内容：**
- `definition.test.ts` — YAML round-trip 测试（workflow 序列化/反序列化）
- `schema.test.ts` — validateWorkflow 测试（合法/非法/边界用例）
- `index.test.ts` — 提示词注入测试（mock before_agent_start handler）

**测试用例覆盖：**

### schema.test.ts
```typescript
// 合法用例
✓ 标准三方工作流（correct member refs）
✓ strict 模式
✓ onFailure 对象格式（returnToStage: "analyze", condition: "design not approved"）
✓ loops 引用主流程 stage names（string[]）
✓ 无 workflow（兼容现有 team）
✓ 多种 onFailure 组合

// 非法用例
✓ stage.member 引用不存在的成员
✓ stage.name 重复
✓ onFailure 为字符串（应报错，非对象）
✓ loops.stages 为对象数组（应报错，非 string[]）
✓ loops.stages 引用不存在的 stage name
✓ strictness 非法值
✓ stages 空数组
```

### index.test.ts
```typescript
✓ strict 模式注入 "严格模式" 提示词
✓ reference 模式注入 "参考模式" 提示词
✓ 无 workflow 时不注入
✓ 含 loops 时正确格式化循环段
✓ onFailure 对象格式化 {"returnToStage":"analyze","condition":"..."}
```

### definition.test.ts
```typescript
✓ 完整 workflow YAML write → read round-trip
✓ 无 workflow 的旧 team 文件 read 兼容
```

**子任务清单：**
1. schema.test.ts — validateWorkflow 所有用例
2. index.test.ts — before_agent_start 提示词注入
3. definition.test.ts — YAML round-trip

**依赖：** 阶段一（schema 测试）、阶段二（prompt 测试）。与阶段三无直接依赖，可并行

---

## 各任务优先级和依赖关系

```
阶段一：核心数据模型 + Schema 校验
  └── 无依赖，最高优先级，P0

阶段二：TL 提示词注入
  └── 依赖阶段一（类型定义），P1

阶段三：create/edit 自然语言配置 + 工具参数
  └── 依赖阶段一（类型定义），P1（可与阶段二并行）

阶段四：测试
  └── 依赖阶段一（schema 测试）和阶段二（prompt 测试），P2（可与阶段三并行）
```

### 执行顺序建议

```
Week 1: 阶段一（核心模型 + Schema）→ 阶段二（提示词注入）
Week 2: 阶段三（工具参数 + 对话引导）+ 阶段四（测试）
```

阶段三与阶段二可并行开发（因为依赖相同的阶段一）。阶段四在阶段一/二完成后任意时间介入。

---

## 设计方案纠正清单

| 项目 | 设计文档原内容 | 纠正为 |
|------|---------------|--------|
| onFailure 类型 | `"stop" \| "skip" \| "retry"` | `{ returnToStage: string; condition: string }` |
| loops.stages 类型 | `WorkflowStage[]` | `string[]`（引用主流程 stage name） |
| stage onFailure 校验 | enum 校验 | object 校验（returnToStage + condition） |
| loop stages 校验 | WorkflowStage 嵌套校验 | string 引用校验（须匹配主流程 stage name） |

实现时以 **纠正后** 的设计为准。

---

## 文件改动汇总

| 文件 | 改行量 | 类型 | 阶段 |
|------|--------|------|------|
| `src/team/definition.ts` | +25~30 | 新增类型 + 字段 | 一 |
| `src/team/schema.ts` | +100~130 | 新增 validateWorkflow() | 一 |
| `index.ts` | +100~130 | 提示词注入 + 对话引导 | 二三 |
| `src/commands/team.ts` | +40~50 | 工具 params + show 展示 + 透传 | 三 |
| 测试文件 | +150~200 | schema/prompt/round-trip | 四 |
| **总计** | **~400~540 行** | | |
