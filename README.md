# pi-top-notch-team

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/bzdbzdbzd121/pi-top-notch-team/actions/workflows/ci.yml/badge.svg)](https://github.com/bzdbzdbzd121/pi-top-notch-team/actions/workflows/ci.yml)

[pi](https://pi.dev) 的多智能体团队协作扩展。让你定义由多个专业角色组成的 Agent 团队，协作完成复杂的长时间任务。

团队会话启动后，你当前的 pi 会话会变成 **Team Lead（TL）**，负责编排各个 **Member** Agent——每个 Member 都是独立的 `pi --mode rpc` 子进程，拥有自己的上下文和记忆，通过 TL 路由的实时消息通道相互通信。

## 功能特性

- **🤖 多智能体协作** — TL 澄清需求、拆解任务、拉起 Member 并监控进度
- **🧠 独立上下文** — 每个 Member 运行自己的 pi 会话，记忆持久化
- **📨 实时消息通道** — Agent 之间通过内置消息总线通信（无需外部基础设施）
- **📋 共享上下文** — TL 维护一份 Markdown 文档，记录项目目标、术语、进展与协作规则
- **🔄 崩溃自动重启** — Member 崩溃后自动重启并恢复会话
- **👥 自定义团队** — 通过 `/team create` 用自然语言定义团队

## 设计理念

**1. 成员的上下文是有价值的**

每个团队成员都是一个独立的 `pi --mode rpc` 会话。只要团队流程还没结束，成员的上下文就不会被清空——它对任务的理解、做过的判断、踩过的坑都保留在自己的会话里。这种连续性让成员在多轮任务协作中保持行为的统一性，而不是每次派发都从零开始"重新认识世界"。配合自动压缩（上下文超阈值先压缩再派发）与会话恢复（`/team resume`），成员的记忆可以贯穿整个长任务周期。

**2. 团队和工作流程应该是可复用的**

团队定义（成员角色、提示词、模型配置）和配套的工作流程（workflow）都会落盘保存到 `~/.pi/top-notch-team/teams/<名称>.yaml`——一次定义，多次复用。同一个团队可以在不同项目、不同会话中反复启动，行为可预期，并且能随使用不断迭代打磨。

## 快速开始

```bash
# 从 GitHub 安装
pi install git:github.com/bzdbzdbzd121/pi-top-notch-team

# 或从本地克隆安装
pi install ./pi-top-notch-team

# 或不安装直接试用
pi -e ./index.ts

# 创建团队
/team create
# → TL 会通过对话引导你完成团队定义

# 使用预定义团队启动会话
/team start <team-name>

# 或使用动态模式（TL 现场设计团队）
/team dynamic
# → TL 会围绕目标对你追问（grilling）、拆解任务、
#   设计带质量加固的工作流（交叉验证、对抗辩论、评审循环），
#   给出完整计划书，经你确认后才启动任何成员

# 结束后停止
/team stop
```

## 使用指南

### 创建团队（/team create）

```
/team create
```

进入创建模式后，直接用自然语言描述你想要的团队，例如「我需要一个三人团队：一个代码分析员、一个负责改代码的开发员、一个验证改动的测试员」。TL 会通过对话收集每个成员的名称、显示名、角色提示词（systemPrompt）和可选的模型配置，确认后保存为团队定义文件 `~/.pi/top-notch-team/teams/<名称>.yaml`。

- 创建过程中可随时补充/修改成员描述，满意后 TL 会调用工具写入磁盘
- `/team list` 查看所有已定义团队，`/team show <名称>` 查看某个团队的完整定义
- `/team done`（或 `/team cancel`）退出创建模式

团队定义示例：

```yaml
name: "refactoring"
description: "负责大型代码重构任务"
defaults:
  model: "anthropic/claude-sonnet-4"   # 可选：团队默认模型
members:
  - name: "analyzer"                    # 成员标识符（英文）
    label: "代码分析员"                  # 显示名（中文）
    systemPrompt: "你是一个代码分析专家..."
    # model: "..."                     # 可选：覆盖团队默认模型
```

### 编辑团队（/team edit）

```
/team edit <名称>
```

进入编辑模式后，用自然语言描述修改即可，例如「把 verifier 的提示词改成…」「再加一个文档员」「把默认模型换成 xxx」。支持的操作：

- **修改成员**：改 label、systemPrompt、model
- **新增成员**：直接描述新成员的角色
- **删除成员**：说明要移除哪个成员
- **修改团队级配置**：描述、默认模型、workflow

未提及的成员保持原样（合并且非覆盖）。编辑模式下编辑器上方会显示 `✏️ EDIT MODE` 标记，完成后 `/team done` 退出。

### 启动团队会话（/team start）

```
/team start <名称>
```

用预定义团队启动会话。启动后：

1. 编辑器上方出现**团队状态栏**，实时显示各成员状态与上下文占用
2. TL 获得团队认知与全部会话工具（`start_member`、`team_send_and_wait` 等，会话结束自动停用）
3. 你直接说任务就行——TL 会先写共享上下文（目标、术语、分工、协作规则），再启动成员、拆解并派发任务、监控进度、汇总结果

会话期间你可以随时：用 `/team status` 看状态、用 `alt+t` 打开成员检视浮窗（见下文）、直接发新消息补充需求。结束会话用 `/team stop`——会话目录会保留，之后可用 `/team resume` 恢复。

### 动态团队会话（/team dynamic）

```
/team dynamic
```

适合一次性的复杂任务：不需要预先定义团队，TL 在会话中现场设计。分两个阶段：

**设计阶段**（进入后自动开始）：
1. **需求对齐**——TL 逐个追问：目标、范围、验收标准、约束、非目标
2. **任务拆分**——按交付物分解，画出依赖图（并行/串行/汇合点）
3. **工作流设计**——针对高风险环节加质量加固（交叉验证、对抗辩论、开发-审核循环等）
4. **计划确认门**——TL 给出完整计划书（目标、任务 DAG、工作流、团队名册、风险），**你明确确认后**才会进入执行

**执行阶段**（确认后自动进入）：TL 注册成员、写共享上下文、启动成员并按工作流派发。之后的使用与 `/team start` 完全相同。

### 监控与成员检视浮窗

**状态栏**：会话期间常驻编辑器上方，显示每个成员的运行状态（idle/working/compacting/crashed）与上下文占用百分比。

**成员检视浮窗**：按 `alt+t` 打开全屏浮窗，直观看到每个成员的实时对话：

| 按键 | 作用 |
|------|------|
| `←` / `→` | 切换成员标签页 |
| `↑` / `↓` | 滚动对话 |
| `e` | 展开/收起工具调用详情（全局开关，对所有成员生效） |
| `t` | 显示/隐藏 thinking 内容（全局开关） |
| `Enter` | 向当前成员发送输入框消息（空闲立即执行，忙则排队） |
| `Ctrl+Enter` | 以 steer 方式发送（插队，立即打断当前工作） |
| `Ctrl+A` | 中断当前成员 |
| `Ctrl+B` | 中断**全部**执行中的成员 |
| `Ctrl+O` | 手动压缩当前成员上下文 |
| `Esc` | 关闭浮窗 |

输入框中直接给成员发消息时，成员侧会看到 `[用户直接指令（非 TL）]` 前缀，能区分消息来源；以 `/` 开头的内容会原样作为 pi 命令发送。你的直接干预不会镜像到 TL 会话——TL 只通过成员回复间接感知。

### 会话恢复（/team resume）

`/team stop` 或意外中断（断电、关终端）后，会话不会丢失：成员的会话上下文持久化在磁盘上。

```
/team resume                    # 列出当前目录可恢复的会话，选择恢复
/team resume --all              # 列出所有目录的会话（附目录标注）
/team resume <名称或sessionId前缀>  # 直接恢复指定会话
```

恢复时会以 `--continue` 重启各成员进程，上下文完整接续。注意：**中断瞬间正在进行中的任务不会自动重放**，TL 会先确认各成员状态，再重建任务编排。

### 中断行为（Esc）

会话期间按 `Esc` 只会取消 TL 的当前回合，**成员进程继续在后台运行**（不丢工作）。此时状态栏会出现提醒：`N 个成员仍在运行 — 使用 /team stop 结束会话`。你可以：发新消息让 TL 继续派发、`/team stop` 结束整个会话，或者放着不管。

### 全局设置（/team setting）

```
/team setting
```

交互式设置菜单（会话内外均可使用），持久化到 `~/.pi/top-notch-team/settings.yaml`：

- **成员默认模型**——`跟随 TL 当前模型` 或 `固定为某个已登录模型`；优先级：成员 YAML > 团队 YAML 默认 > 全局固定 > 全局跟随。只影响之后启动的成员
- **自动压缩**——成员空闲且即将收到新任务时，若上下文占用超过阈值（百分比和/或绝对 token 数），先自动压缩再派发。可配置开关、阈值、压缩超时（默认 10 分钟）与批预算（默认 15 分钟）



## 命令一览

| 命令 | 说明 |
|------|------|
| `/team create` | 通过自然语言对话创建团队 |
| `/team dynamic` | 动态团队模式——TL 根据需求现场设计团队 |
| `/team edit <name>` | 通过自然语言对话修改已有团队 |
| `/team start <name>` | 使用预定义 YAML 团队启动会话 |
| `/team resume [标识\|--all]` | 恢复中断或已停止的团队会话 |
| `/team stop` | 结束当前团队会话 |
| `/team list` | 列出所有团队定义 |
| `/team show <name>` | 查看团队定义详情 |
| `/team done` / `/team cancel` | 结束并退出当前创建/编辑模式 |
| `/team delete <name>` | 删除团队定义（带确认） |
| `/team status` | 查看会话与成员状态 |
| `/team setting` | 全局设置（成员默认模型、自动压缩） |
| `/team help` | 显示使用帮助 |

`/team start`、`/team show`、`/team delete`、`/team edit` 支持团队名 Tab 补全。

## 工作原理

```
你的 pi 会话（TL 扩展）
  ├── /team 命令（11+ 个子命令）
  ├── 10 个 TL 工具（9 个仅会话期间可用：start_member、stop_member、list_members、
  │   get_member_log、wait_and_get_member_status、team_send_and_wait、
  │   write_shared_context、set_goal、finish_goal；动态模式另有 add_dynamic_member）
  ├── 消息通道（event-handler → queue → router → response-waiter）
  └── Member 进程管理器
        ├── Member A（pi --mode rpc）
        ├── Member B（pi --mode rpc）
        └── Member C（pi --mode rpc）
```

### 流程

1. **定义团队** — 用 `/team create` 描述你想要的团队，TL 收集细节后把 YAML 定义保存到 `~/.pi/top-notch-team/teams/`；或用 `/team dynamic` 跳过预定义，让 TL 在运行时现场设计团队。

2. **启动会话** — `/team start <name>` 或 `/team dynamic` 会注册并激活会话工具（`start_member`、`stop_member`、`list_members`、`get_member_log`、`wait_and_get_member_status`、`team_send_and_wait`、`write_shared_context`、`set_goal`、`finish_goal`，动态模式另有 `add_dynamic_member`），并向 TL 的系统提示词注入团队认知。会话之外，这些工具不存在于工具注册表中。

3. **TL 与你协作** — TL 澄清需求、撰写共享上下文文档，并通过 `start_member` 拉起 Member。

4. **Member 并行工作** — 每个 Member 以 `pi --mode rpc` 运行，保持自己的会话；Member 之间、Member 与 TL 之间通过 `team_send_message` 通信。

5. **监控与收尾** — TL 通过 `list_members` 和 `get_member_log` 跟踪进度；完成后运行 `/team stop`。

## 架构

完整架构规范见 [DESIGN.md](DESIGN.md)，决策记录见 [docs/adr/](docs/adr/)。

**TL** — 用户的 pi 会话，扩展加载时注册 `/team` 命令；团队工具在会话启动时按需注册，会话结束时停用。

**Member** — 独立的 `pi --mode rpc` 子进程，各自保持上下文。

**消息通道** — TL 通过 RPC 事件流在 Agent 之间路由消息，无需外部基础设施。

**角色注入** — Member 启动时通过环境变量（`TEAM_ROLE`、`TEAM_NAME` 等）注入角色与配置。

### TL 工具

| 工具 | 说明 |
|------|------|
| `write_shared_context(content)` | 写入团队共享上下文 `.shared-context.md`。**必须在首次 `start_member` 之前调用**（硬门控）。 |
| `start_member(name)` | 启动 Member 的 pi RPC 进程 |
| `stop_member(name)` | 优雅终止 Member 进程 |
| `list_members()` | 查看所有成员状态 |
| `get_member_log(name, lines?, maxContentLength?)` | 通过 RPC 获取 Member 近期会话。`maxContentLength` 截断每条消息（默认 200 字符）。 |
| `wait_and_get_member_status()` | 等待所有 Member 空闲后查看运行状态：idle/working/crashed/stopped。有 Member 在工作则阻塞。无参数。 |
| `add_dynamic_member(name, label, systemPrompt, model?)` | 在 /team dynamic 模式下注册成员（name=标识符，label=中文显示名） |
| `team_send_and_wait({tasks: [{to, content}], nextSteps})` | 向一个或多个成员发送消息并等待全部响应。tasks 数组支持向不同成员并发派发以并行执行；部分成员失败时返回部分结果。nextSteps 在 wait 结束后随结果返回。 |
| `set_goal(text, criteria)` | 设定带可验证完成标准的会话目标；TL 在目标达成前停下时系统会自动重新触发它。 |
| `finish_goal()` | 标记当前目标完成，停止提醒系统。 |

这些工具仅在团队会话活跃期间注册并可用。

## 安装

### 从 GitHub 安装

```bash
pi install git:github.com/bzdbzdbzd121/pi-top-notch-team
```

### 从本地路径安装

```bash
git clone https://github.com/bzdbzdbzd121/pi-top-notch-team.git
pi install ./pi-top-notch-team
```

### 不安装直接试用

```bash
pi -e ./index.ts
```

## 更新

### 从 GitHub 安装的

```bash
# 只更新本扩展
pi update git:github.com/bzdbzdbzd121/pi-top-notch-team

# 或更新全部扩展包
pi update --extensions
```

### 从本地路径安装的

```bash
cd pi-top-notch-team
git pull
pi install ./pi-top-notch-team   # 重新安装以生效
```

## 开发

```bash
cd pi-top-notch-team
npm install
npm test           # 运行全部测试
npm run test:watch # Watch 模式
```

完整源码地图与 DI 模式文档见 [AGENTS.md](AGENTS.md)。

## License

[MIT](LICENSE)
