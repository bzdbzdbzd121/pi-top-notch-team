# Refactoring Plan — pi-top-notch-team

> 总计 32 个步骤，已完成 18 步，剩余 14 步

## 已完成工作 (Steps 1-18)

### Phase 0: 基础重构 ✅
- Step 1: `src/setup/member-lifecycle.ts` — 提取 createAndRegisterMember / buildMemberConfig / getMemberLog
- Step 2: `src/setup/message-channel.ts` — 提取 router / queue / responseWaiter 创建
- Step 3: `src/tools/tl-tools.ts` — 统一 TL 工具注册，TlToolsDeps 接口，消除 `as any`
- Step 4: `src/channel/event-handler.ts` — 提取事件处理 / parseTeamMessageTag / sendToMember

### Phase 1: Bug 修复 ✅
- Step 5: responseBuffer 添加 5 分钟 TTL 自动清理
- Step 6: recentlyProcessedMessages Set → Map（时间戳 + 500 条上限）
- Step 7: sendCommandAndWait matchFn try/catch 包裹
- Step 8: stop() exit 监听器先于 kill() 注册
- Step 9: 两套状态跟踪统一到 ProcessManager.operationalStates
- Step 10: deleteTeam 分离 session 目录删除

### Phase 2: 可测试化 ✅
- Step 11: `src/session/state-machine.ts` — 纯函数状态机 (+19 tests)
- Step 12: index.test.ts 重写 — 移除影子测试，集成测试
- Step 13: tl-tools.test.ts 补充 (+10 tests)，串行测试精确控制

### Phase 3: 验证/错误处理 (部分) ✅
- Step 14: notifyHandlers catch 添加 console.warn
- Step 15: member.ts to 参数验证
- Step 16: getBackoffDelay 改为纯函数
- Step 17: _exitCode 参数使用（致命信号立即冻结）
- Step 18: session 目录自动创建 + shared context 验证 + 截断默认值 200

---

## 剩余工作 (Steps 19-32)

### Phase 3: 验证/错误处理 (剩余)

#### Step 19 — `sendCommand` 写保护
- **目标**: `src/process/member-process.ts` — 向 stdin 写入 JSON 前校验序列化大小
- **内容**:
  - JSON.stringify 后检查字节长度，超过阈值（如 1MB）时拒绝写入并报错
  - 利用 drain 事件：写入返回 false 时等待 drain 后再继续
  - 添加 writeQueue 缓冲区
- **测试**: member-process.test.ts 增加序列化大小校验测试

#### Step 20 — `drain()` 忙轮询改为事件驱动
- **目标**: `src/setup/message-channel.ts` (或相关调用处)
- **内容**:
  - 当前 `drain()` 可能使用 setTimeout 轮询检查 buffer 是否清空
  - 改为监听 process.stdin 的 drain 事件
  - 取消轮询定时器
- **测试**: message-channel.test.ts 更新

### Phase 4: 类型安全

#### Step 21 — 消除 `as any` 和 `Function` 类型
- **目标**: 全项目搜索 `as any` 和 `Function` 类型
- **内容**:
  - 逐个检查每条 `as any`，替换为正确的类型断言或重新设计接口
  - `Function` 替换为具体函数签名
  - 新增必要的类型定义
- **验证**: `tsc --noEmit` 零类型错误

#### Step 22 — `getSessionState` 深拷贝
- **目标**: `src/session/state.ts` — getSessionState 使用 structuredClone
- **内容**: 返回状态前做深拷贝，防止调用方意外修改内部状态
- **验证**: 单元测试验证修改不影响原始状态

#### Step 23 — `updateMembers` 数组保护
- **目标**: `src/session/state.ts` — updateMembers 用 Object.freeze 冻结数组
- **内容**: 对外暴露的成员数组不可变
- **验证**: 单元测试验证冻结生效

#### Step 24 — `members[].label` 类型验证
- **目标**: `src/team/schema.ts` — label 字段类型和长度校验
- **内容**: 确保 label 是字符串、非空、长度不超过阈值
- **验证**: schema.test.ts 补充校验测试

#### Step 25 — `teamMembers` 逗号解析改为 JSON.parse
- **目标**: `src/setup/member-lifecycle.ts` — TEAM_MEMBERS 解析逻辑
- **内容**: 从逗号分隔字符串改为 JSON.parse（支持含逗号的名称）
- **验证**: member-lifecycle.test.ts 更新

#### Step 26 — Mock theme 对象完善
- **目标**: `src/test/fixtures/mock-extension-api.ts`
- **内容**: mock theme 对象补全必要字段
- **验证**: 类型检查通过

#### Step 27 — 验证 `registerTlTools` 参数封装
- **目标**: `src/tools/tl-tools.ts` — 确保所有依赖通过 TlToolsDeps 显式传递
- **内容**: 检查是否有遗漏的直接 import 依赖，统一封装
- **验证**: tl-tools.test.ts 更新

### Phase 5: 打磨与文档

#### Step 28 — 截断策略统一
- **目标**: `src/channel/event-handler.ts` + member.ts 中的截断逻辑
- **内容**: 确保截断长度（如 get_member_log 的 `maxContentLength`）有合理默认值和边界处理
- **验证**: event-handler.test.ts 更新

#### Step 29 — 语言统一（中文→英文/双语）
- **目标**: 确保全项目用户可见信息语言一致（英文或双语）
- **内容**: 检查 index.ts、member.ts、commands/team.ts 等中的提示信息
- **验证**: 人工 review

#### Step 30 — 边界问题修复
- **目标**: 检查并修复各模块边界条件
- **内容**:
  - 空数组/空字符串处理
  - 超长输入截断
  - 并发访问保护
  - 退出码处理
- **验证**: 各模块测试文件补充

#### Step 31 — AGENTS.md 更新
- **目标**: `AGENTS.md` — 同步更新项目文档
- **内容**: 反映最新的架构变更、新增模块、文件结构
- **验证**: 人工 review

#### Step 32 — 最终审查和提交
- **目标**: 全项目最终审查
- **内容**: code review 所有变更，确认无遗漏，准备提交
- **验证**: 全量测试 + typecheck + review

---

## 执行策略

### 团队协作模式
- **Worker（编码员）** — 以 TDD 方式执行每一步
- **Reviewer（审查员）** — 验证每步实现的质量
- 每步先由 Worker 实现，再由 Reviewer 审查
- Worker 和 Reviewer 循环交替，直到所有步骤完成

### 验收标准
- 所有 209+ 测试通过
- `tsc --noEmit` 零类型错误
- 无 `as any` 或 `Function` 类型残留
- Review 无阻塞性问题
