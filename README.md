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

## 快速开始

```bash
# 从 GitHub 安装
pi install github:bzdbzdbzd121/pi-top-notch-team

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

### 团队定义

保存在 `~/.pi/top-notch-team/teams/<name>.yaml`：

```yaml
name: "refactoring"
description: "负责大型代码重构任务"
defaults:
  model: "anthropic/claude-sonnet-4"
members:
  - name: "analyzer"
    label: "代码分析员"
    systemPrompt: "你是一个代码分析专家..."
  - name: "mover"
    label: "代码迁移员"
    systemPrompt: "你负责执行代码迁移操作..."
  - name: "verifier"
    label: "验证员"
    systemPrompt: "你负责验证迁移后的代码..."
```

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
pi install github:bzdbzdbzd121/pi-top-notch-team
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

## 开发

```bash
cd pi-top-notch-team
npm install
npm test           # 运行全部测试
npm run test:watch # Watch 模式
```

925 个测试。完整源码地图与 DI 模式文档见 [AGENTS.md](AGENTS.md)。

## 设计决策

关键决策记录在 [ADR](docs/adr/) 中：

- **Member 作为独立的 pi --mode rpc 进程** — 独立上下文、会话持久化、可恢复。[ADR-0001](docs/adr/0001-members-as-independent-pi-rpc-processes.md)
- **TL 作为中心消息路由器** — 基于 RPC 事件流，无需外部消息总线。[ADR-0002](docs/adr/0002-tl-as-central-message-router.md)
- **环境变量注入角色** — Member 启动时通过环境变量获取角色/配置，而非读取 YAML 文件。
- **Agent 自主发起团队会话** — `start_team_session` 让 agent 可以自主委派复杂任务。[ADR-0003](docs/adr/0003-agent-initiated-team-sessions.md)
- **团队会话恢复** — 成员会话落盘 + 清单 + `/team resume`。[ADR-0004](docs/adr/0004-team-session-resume.md)

## License

[MIT](LICENSE)
