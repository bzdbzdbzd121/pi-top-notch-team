# 代码审查报告：默认工作流功能

> 审查日期：2026-06-10
> 审查范围：4 commits（569e8a8, 3c3d1e2, ccad5e7, c220068）
> 审查员：reviewer

---

## 摘要

| 维度 | 结论 |
|------|------|
| 功能完整性 | 完整。类型定义 → Schema 校验 → 提示词注入 → 工具参数 → 对话引导 → 展示，链路完备 |
| 测试覆盖 | 241 tests pass，含 30+ workflow 专项测试。schema 校验有全面覆盖 |
| 严重问题 | 1 个 CRITICAL：`validateOnFailure` 缺 `returnToStage` 交叉校验 |
| 警告 | 3 个 WARNING：session 事件双发、saveTeamDefinition 类型弱化、测试覆盖面缺口 |
| Info | 4 个 INFO：可选优化建议 |
| 架构一致性 | 高。类型 → 校验 → 注入 → 展示 分层清晰，符合项目 DI 和模块化风格 |

---

## 文件级审查

### 1. `src/team/definition.ts` — WorkflowStage / WorkflowLoop / TeamWorkflow 接口

**功能：** 新增 3 个类型接口 + `TeamDefinition.workflow?` 可选字段。

**评价：** 清晰。JSDoc 完备。`onFailure` 使用对象 `{returnToStage, condition}` 而非枚举（纠正了设计文档的歧义）。`WorkflowLoop.stages` 使用 `string[]`（引用主流程 stage names），正确。

**问题：**

| 严重性 | 位置 | 说明 |
|--------|------|------|
| INFO | L36-42 | `onFailure.returnToStage` 文档说"回退到的 stage name"，但类型系统无法保证该 stage 存在。校验需在 schema 层完成。 |

---

### 2. `src/team/schema.ts` — validateWorkflow 函数

**功能：** 新增 `validateWorkflow()` + `validateOnFailure()`。从 `validateTeamDefinition` 调用，传入 `memberNames` 做交叉引用校验。

**评价：** 实现严谨。early return 处理 stages 非数组情况。`mainStageNames` 收集为 loops 交叉引用做准备。"tl" 特殊处理正确。

**问题：**

| 严重性 | 位置 | 说明 |
|--------|------|------|
| **CRITICAL** | `validateOnFailure()` L226-240 | `returnToStage` 只校验了 `typeof === "string"`，**未校验该 stage name 是否存在于主流程 stages 中**。用户可配置 `onFailure: { returnToStage: "ghost", condition: "fail" }` 通过校验，运行时 TL 拿到无效 stage 引用会出错。修复：将 `mainStageNames` 传入 `validateOnFailure`，检查 `mainStageNames.has(returnToStage)`。 |
| WARNING | L157 | `memberNames.length > 0` 条件：当 `memberNames` 为空（理论上不可能，因为 member validation 已要求至少 1 个），会导致所有 member 名称通过校验。实际不影响（teams 至少 1 member）。 |
| INFO | L202-214 | loops stages 引用了 `mainStageNames`，但 `onFailure.returnToStage` 没有同样的交叉校验。两者不一致。 |

---

### 3. `src/commands/team.ts` — 工具参数 + saveTeamDefinition + /team show

**功能：** `create_team_definition` / `update_team_definition` 增加 `workflow` 参数（JSON Schema），`saveTeamDefinition` 透传 workflow 到 YAML，`/team show` 展示 workflow 详情。

**评价：** 代码组织良好。`workflowStageSchema` 和 `workflowSchema` 共享避免了 create/update 不一致。`/team show` 展示格式清晰（含 emoji、输入/输出/约束/失败处理）。

**问题：**

| 严重性 | 位置 | 说明 |
|--------|------|------|
| WARNING | `saveTeamDefinition()` L57-61 | `teamData` 类型为 `Record<string, unknown>`，失去了 workflow 对象的类型安全。workflow 直接赋值时无编译时校验，依赖运行时 schema 校验。与现有代码风格一致，但可考虑为 `TeamDefinition` 接口。 |
| WARNING | `/team show` 的 workflow 展示 L470-497 | 当 `s.onFailure` 存在时直接访问 `s.onFailure.condition` 和 `s.onFailure.returnToStage`。若 `onFailure` 为畸形对象（非标准 `{returnToStage, condition}`），运行时可能 `undefined`。但 schema 校验已拦截畸形对象。 |
| INFO | `workflowStageSchema` 的 `onFailure` | JSON Schema 中 `onFailure` 的 `required: ["returnToStage", "condition"]`，但 TL 模型侧可能不传此字段导致 schema 校验失败。实际正确——onFailure 至少需要这两个字段。 |

---

### 4. `index.ts` — before_agent_start 提示词注入 + create/edit 对话引导

**功能：** 
- `before_agent_start`：当 `session.active && team.workflow` 存在时，注入格式化的工作流提示词到 TL system prompt
- `isCreatingTeam` 提示词追加工作流配置引导
- `editingTeamName` 提示词追加工作流修改引导
- 同时包含 session_shutdown/session_start 事件处理和 TeamModeEditor 边界色

**评价：** 提示词注入逻辑完整。strict/reference 模式差异化提示词。loop 和 onFailure 格式化清晰。`team_send_message` 从 TL 工具列表中移除（与 tl-tools 删除一致）。

**问题：**

| 严重性 | 位置 | 说明 |
|--------|------|------|
| WARNING | `session_shutdown` + `session_start` 都调用 `endSession()` + `onSessionEnd()` | 在特定场景（如 session 快速重启）可能双发。`endSession()` 看源码是幂等的（重置状态），`onSessionEnd()` 有 `if (teamStatusWidget)` 守卫。风险低，但可加 `alreadyEnded` flag 保护。 |
| INFO | workflow 提示词注入 L328-367 | `fmtStage` 函数在描述 onFailure 时直接访问 `s.onFailure.condition` 和 `s.onFailure.returnToStage`。若类型不匹配（理论上 schema 已校验），运行时崩溃。加可选链 `s.onFailure?.condition` 保底更安全。 |
| INFO | TL 提示词 L424 | "成员列表引用的工具编号去掉了 team_send_message" 是正确的——该工具已从 tl-tools 移除。 |

---

### 5. 测试文件

#### `src/team/schema.test.ts` — 22 workflow 测试

**评价：** 覆盖全面。合法/非法/边界用例均覆盖。`validDef()` 辅助函数减少样板代码。

**缺口：**

| 严重性 | 说明 |
|--------|------|
| WARNING | 缺 `onFailure.returnToStage` 引用不存在 stage name 的测试。当前 `validateOnFailure` 不校验此场景，所以即使测试也抓不到。修复校验后需补测。 |
| INFO | 缺 `workflow.strictness` 默认值测试（定义中说默认 `"reference"`，但代码中不设 strictness 时校验不报错也未设默认值）。实际 schema 校验只检查显式值是否合法，不补充默认值。设计上说有默认值但未实现。 |

#### `src/index.test.ts` — 7 workflow 注入测试

**评价：** 覆盖 strict/reference/no-workflow/loops/onFailure/all-optional。mock 方式正确。

**缺口：**

| 严重性 | 说明 |
|--------|------|
| INFO | 缺 `session_shutdown` 在活跃 session 时关闭状态清理的测试。 |
| INFO | 缺 `session_start` 在 stale session 时重置的测试。 |

#### `src/commands/team.test.ts` — 3 workflow 持久化测试

**评价：** 覆盖创建 + onFailure + 校验拒绝。YAML 文件读回验证正确。

**缺口：**

| 严重性 | 说明 |
|--------|------|
| WARNING | `/team show` 的 workflow 测试只检查了 `expect.stringContaining("分析员")`（成员 label），未检查 workflow 具体字段（严格模式、步骤名、描述等）。测试名称"displays workflow when present"与断言不匹配。 |
| INFO | 缺 `update_team_definition` 的 workflow 测试。只测了 create。 |

#### `src/team/definition.test.ts` — 1 workflow round-trip 测试

**评价：** 覆盖完整 YAML round-trip。验证 stages、onFailure 对象、loops 全部序列化/反序列化正确。

---

## 严重问题汇总

### CRITICAL (1)

1. **`validateOnFailure` 缺 `returnToStage` 交叉校验**
   - 文件：`src/team/schema.ts` L226-240
   - 问题：`returnToStage` 只校验类型为 string，未验证该 stage name 在主流程 stages 中存在
   - 影响：用户可配置指向不存在的 stage，TL 获取到无效引用
   - 修复：将 `mainStageNames` 传入 `validateOnFailure`，增加 `if (!mainStageNames.has(of.returnToStage))` 校验

### WARNING (3)

2. **`/team show` workflow 测试断言不足**
   - 文件：`src/commands/team.test.ts` L147-166
   - 问题：测试名"displays workflow when present"但只 assert 了成员 label，未验证 workflow 模式/步骤/描述
   - 建议：补充 `expect.stringContaining("参考模式")`、`expect.stringContaining("analyze")` 等

3. **`saveTeamDefinition` 类型弱化**
   - 文件：`src/commands/team.ts` L57-61
   - 问题：`teamData` 使用 `Record<string, unknown>`，workflow 对象无编译时校验
   - 建议：提取为 `TeamDefinition` 类型或至少 `Partial<TeamDefinition>`

4. **session_shutdown/session_start 双发 endSession**
   - 文件：`index.ts` L147-166
   - 问题：两个事件 handler 都调用 `endSession()` + `onSessionEnd()`，快速重启场景可能双发
   - 建议：加 `alreadyEnded` 守卫变量

### INFO (6)

5. `validateOnFailure` returnToStage 校验与 loops stages 引用校验不一致
   - loops 有 `mainStageNames.has()` 检查，onFailure 缺失
6. 工作流 `strictness` 默认值未在 schema 层实现（设计文档说默认 `"reference"`）
7. `fmtStage` 中 onFailure 属性访问无可选链保护
8. schema.test.ts 缺 `workflow` 设置为 valid 空 stages 的边界测试
9. commands.test.ts 缺 `update_team_definition` 的 workflow 测试
10. index.test.ts 缺 session_shutdown/session_start 的清理测试

---

## 结论

整体实现质量高。类型设计清晰、校验覆盖全面、提示词注入机制合理、测试体系完整（241 全绿）。唯一 **CRITICAL** 问题在 `validateOnFailure` 缺失交叉引用校验，修复成本很低（传 `mainStageNames` 加一行 `has()` 检查）。WARNING 集中在测试缺口和类型安全边际，建议跟进完善。

### 验收清单

| 项目 | 状态 |
|------|------|
| 每个文件有审查结论 | ✓ |
| 问题按严重性分级 | ✓ |
| 有具体行号和代码引用 | ✓ |
| CRITICAL 项明显标记 | ✓ |
