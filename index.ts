import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTeamCommand } from "./src/commands/team";
import { getSessionState } from "./src/session/state";
import type { TeamContext, MemberOperationalState } from "./src/session/context";
import { registerTlTools } from "./src/tools/tl-tools";
import { createProcessManager } from "./src/process/manager";
import { createMemberProcess } from "./src/process/member-process";
import { createMessageQueue } from "./src/channel/message-queue";
import { createRouter } from "./src/channel/router";
import { createResponseWaiter, extractCorrelationId } from "./src/channel/response-waiter";
import type { TeamMessage } from "./src/channel/types";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getRootDir } from "./src/config";
import { createTeamStatusWidget } from "./src/ui/team-status-widget";

export default function (pi: ExtensionAPI) {
  // If running as a member process (TEAM_ROLE is set), skip TL-only tools
  // to avoid tool name conflicts with member.ts.
  if (process.env.TEAM_ROLE) {
    return;
  }

  // ── Shared mutable state ──────────────────────────────────
  const teamCtx: TeamContext = {
    isCreatingTeam: false,
    editingTeamName: null,
    processManager: null,
    memberHandles: new Map(),
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait", "get_member_status"],
    blockedToolNames: ["write", "edit"],
    router: null,
    messageQueue: null,
    responseWaiter: null,
    memberOperationalStates: null,
  };

  // ── Message channel: queue → router ──────────────────────
  const router = createRouter({
    sendToMember: (memberName: string, msg: TeamMessage) => {
      const handle = teamCtx.memberHandles.get(memberName);
      if (!handle) {
        pi.sendMessage({
          customType: "team-route",
          content: `无法路由消息到未知成员 "${memberName}"（该成员可能未启动）`,
          display: true,
        });
        return;
      }
      // Mark member as working when we send a prompt (before sendCommand)
      memberOpsStates.set(memberName, "working");

      try {
        handle.sendCommand({
          type: "prompt",
          message: `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`,
        });
      } catch (err) {
        pi.sendMessage({
          customType: "team-route",
          content: `发送消息给 "${memberName}" 失败：${err instanceof Error ? err.message : String(err)}`,
          display: true,
        });
      }
    },
    sendToTl: (msg: TeamMessage) => {
      // Check if ResponseWaiter has a pending wait for this message
      const corrId = msg.correlationId ?? extractCorrelationId(msg.content);
      if (corrId) {
        const resolved = responseWaiter.resolveIfWaiting(
          corrId, msg.from, msg.content, msg.subject
        );
        if (resolved) {
          lastPendingCorrId.delete(msg.from);
          return; // consumed by waiter, skip sendMessage
        }
      }
      pi.sendMessage({
        customType: "team-message",
        content: `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`,
        display: true,
        details: { msg },
      });
    },
    memberNames: [],
    onUnknownTarget: (from, to) => {
      pi.sendMessage({
        customType: "team-route",
        content: `消息目标 "${to}" 不存在（来自 ${from}）。有效目标：tl、all、团队成员名称。`,
        display: true,
      });
    },
  });

  const messageQueue = createMessageQueue(async (msg: TeamMessage) => {
    // Show routing notification for messages from TL (so TL knows it was dispatched)
    if (msg.from === "tl") {
      pi.sendMessage({
        customType: "team-route",
        content: `[消息已路由给 ${msg.to}]`,
        display: true,
      });
    }
    router.route(msg);
  }, {
    onHandlerError: (msg, err) => {
      pi.sendMessage({
        customType: "team-route",
        content: `处理消息（${msg.id}）时出错：${err.message}`,
        display: true,
      });
    },
  });

  const responseWaiter = createResponseWaiter();

  // ── Member operational state tracking ─────────────────────
  const memberOpsStates = new Map<string, MemberOperationalState>();

  // Track the most recent correlation ID sent to each member via team_send_and_wait.
  // Used to auto-inject correlation ID when a member replies without the <corr:...> tag.
  const lastPendingCorrId = new Map<string, string>();
  // Track recently processed tool_execution_end message fingerprints for de-duplication
  const recentlyProcessedMessages = new Set<string>();

  teamCtx.router = router;
  teamCtx.messageQueue = messageQueue;
  teamCtx.responseWaiter = responseWaiter;
  teamCtx.memberOperationalStates = memberOpsStates;

  // ── Create and register member handles ─────────────────────
  function createAndRegisterMember(
    config: import("./src/process/member-process").MemberProcessConfig
  ): ReturnType<typeof createMemberProcess> {
    const handle = createMemberProcess(config, spawn);
    teamCtx.memberHandles.set(config.name, handle);
    teamCtx.processManager?.addHandle(handle);

    // Backup parse: scan text blocks for <team-message> tags
    function parseTeamMessageTag(text: string): { to: string; subject?: string; content: string } | null {
      const m = text.match(/<team-message\s+to="([^"]+)"(?:\s+subject="([^"]*)")?>([\s\S]*?)<\/team-message>/);
      if (!m) return null;
      return { to: m[1], subject: m[2] || undefined, content: m[3].trim() };
    }

    // Wire message channel: intercept team_send_message tool calls
    handle.onEvent((event: any) => {
      // ── Member operational state tracking ─────────────────
      if (event.type === "agent_start") {
        memberOpsStates.set(config.name, "working");
      }
      if (event.type === "agent_end") {
        memberOpsStates.set(config.name, "idle");
      }

      // Primary: team_send_message tool result
      if (event.type === "tool_execution_end" && event.toolName === "team_send_message") {
        const teamMsg = event.result?.details?.teamMessage;
        if (teamMsg) {
          // Record fingerprint for de-duplication: sender + content prefix (both paths can compute the same key)
          const dedupKey = `${teamMsg.from}:${teamMsg.content?.slice(0, 80) ?? ""}`;
          recentlyProcessedMessages.add(dedupKey);
          setTimeout(() => recentlyProcessedMessages.delete(dedupKey), 60_000);

          // Auto-populate correlation ID (only for TL-directed messages)
          let content = teamMsg.content;
          if (teamMsg.to === "tl" && !content.match(/<corr:[a-zA-Z0-9_-]+>/)) {
            const stored = lastPendingCorrId.get(teamMsg.from);
            if (stored) {
              content = content + `\n\n<corr:${stored}>`;
            }
          }
          messageQueue.enqueue({
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            from: teamMsg.from,
            to: teamMsg.to,
            subject: teamMsg.subject,
            content,
            timestamp: teamMsg.timestamp ?? Date.now(),
          });
        }
      }

      // Backup: check assistant text for <team-message> tags
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = typeof event.message.content === "string"
          ? event.message.content
          : event.message.content?.map((c: any) => c.text ?? "").join(" ") ?? "";
        const parsed = parseTeamMessageTag(text);
        if (parsed) {
          // De-duplication: compute same key as primary path (sender + content prefix)
          const dedupKey = `${config.name}:${parsed.content?.slice(0, 80) ?? ""}`;
          if (recentlyProcessedMessages.has(dedupKey)) {
            return;
          }

          // Auto-populate correlation ID for backup path too
          let backupContent = parsed.content;
          if (parsed.to === "tl" && !backupContent.match(/<corr:[a-zA-Z0-9_-]+>/)) {
            const stored = lastPendingCorrId.get(config.name);
            if (stored) {
              backupContent = backupContent + "\n\n<corr:" + stored + ">";
            }
          }
          messageQueue.enqueue({
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            from: config.name,
            to: parsed.to,
            subject: parsed.subject,
            content: backupContent,
            timestamp: Date.now(),
          });
        }
      }

      // Handle process exit
      if (event.type === "process_exit") {
        const memberName = event.memberName;
        const exitCode = event.exitCode;

        // Exit code 143 = SIGTERM (128 + 15), which is a normal stop via stop_member
        // Exit code 0 or null = clean exit
        const isNormalExit = exitCode === null || exitCode === 0 || exitCode === 143;

        // Update operational state
        memberOpsStates.set(memberName, isNormalExit ? "stopped" : "crashed");

        // Only proceed with further handling if the process was actually running
        // (wasRunning=true indicates an unexpected exit that needs routing/notification)
        if (!event.wasRunning) return;

        if (!isNormalExit) {
          // Cancel pending team_send_and_wait waits for this member
          // to avoid TL waiting 120s for a crashed member to reply
          const pendingCorrId = lastPendingCorrId.get(memberName);
          if (pendingCorrId) {
            responseWaiter.resolveIfWaiting(
              pendingCorrId, memberName,
              "[成员进程已崩溃，消息无法送达]"
            );
            lastPendingCorrId.delete(memberName);
          }

          // Notify TL only on unexpected crashes
          pi.sendMessage({
            customType: "team-message",
            content: `Member "${memberName}" 进程异常退出（code: ${exitCode}），需检查崩溃原因。`,
            display: true,
            details: { crashEvent: event },
          });
        } else {
          pi.sendMessage({
            customType: "team-message",
            content: `Member "${memberName}" 进程已正常停止（code: ${exitCode}）。`,
            display: true,
          });
        }
      }

      if (event.type === "process_error") {
        const memberName = event.memberName;
        // Update operational state
        memberOpsStates.set(memberName, "crashed");
        const pendingCorrId = lastPendingCorrId.get(memberName);
        if (pendingCorrId) {
          responseWaiter.resolveIfWaiting(
            pendingCorrId, memberName,
            "[成员进程错误，消息无法送达]"
          );
          lastPendingCorrId.delete(memberName);
        }
        pi.sendMessage({
          customType: "team-message",
          content: `Member "${memberName}" 进程异常，需检查崩溃原因。`,
          display: true,
        });
      }
    });

    // Initialize member operational state
    memberOpsStates.set(config.name, "idle");

    return handle;
  }

  function buildMemberConfig(
    memberName: string
  ): import("./src/process/member-process").MemberProcessConfig | null {
    const session = getSessionState();
    const team = session.teamDefinition;
    if (!team) return null;

    const memberDef = team.members.find((m) => m.name === memberName);
    if (!memberDef) return null;

    const sessionDir = join(getRootDir(), "sessions", team.name, memberName);
    const sharedContextPath = join(getRootDir(), "sessions", team.name, ".shared-context.md");

    return {
      name: memberName,
      role: memberName,
      roleLabel: memberDef.label ?? memberName,
      teamName: team.name,
      teamMembers: team.members.map((m) => m.name),
      memberDescription: memberDef.systemPrompt,
      sessionDir,
      sharedContextPath,
      memberExtensionPath: new URL("./member.ts", import.meta.url).pathname,
      cwd: process.cwd(),
    };
  }

  const manager = createProcessManager([], {
    autoRestart: false,
    onCrashLoopDetected: (name, restarts) => {
      pi.sendMessage({
          customType: "team-message",
          content: `Member "${name}" 已连续崩溃 ${restarts} 次，已停止自动重启。`,
          display: true,
        });
    },
  });
  teamCtx.processManager = manager;

  // getMemberLog: query member session via RPC get_messages
  async function getMemberLog(memberName: string, maxLines: number, maxContentLength?: number): Promise<string> {
    const handle = teamCtx.memberHandles.get(memberName);
    if (!handle) {
      throw new Error(`Member "${memberName}" not found`);
    }

    const response = await handle.sendCommandAndWait(
      { type: "get_messages" },
      (event: any) => event.type === "response" && event.command === "get_messages"
    );

    const effectiveMaxLen = maxContentLength ?? 50;

    const messages = response?.data?.messages ?? [];
    const recent = messages.slice(-maxLines);
    return recent
      .map((m: any) => {
        let content = typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);

        if (content.length > effectiveMaxLen) {
          content = content.slice(0, effectiveMaxLen) + "...";
        }

        return `[${m.role}] ${content}`;
      })
      .join("\n");
  }

  registerTlTools(pi, manager, createAndRegisterMember, buildMemberConfig, getMemberLog, (msg) => {
    messageQueue.enqueue({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: "tl",
      to: msg.to,
      subject: msg.subject,
      content: msg.content,
      timestamp: Date.now(),
    });
  });

  // ── team_send_and_wait tool ─────────────────────────────
  pi.registerTool({
    name: "team_send_and_wait",
    label: "Send Message and Wait",
    description:
      "Send a message to a team member and WAIT for their response. "
      + "Use instead of team_send_message when you need the member result. "
      + "Params: to (target), content (body), timeout (optional ms, default 120000).",
    promptGuidelines: [
      "Use team_send_and_wait when you need a member result before continuing.",
      "On timeout check via get_member_log and re-wait if still working.",
    ],
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target member name" },
        content: { type: "string", description: "Message body" },
        timeout: { type: "number", description: "Max wait in ms (default 120000, max 300000)" },
      },
      required: ["to", "content"],
    } as any,
    async execute(_toolCallId: string, params: { to: string; content: string; timeout?: number }) {
      const corrId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      lastPendingCorrId.set(params.to, corrId);
      try {
        messageQueue.enqueue({
          id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          from: "tl",
          to: params.to,
          content: params.content + "\n\n<corr:" + corrId + ">",
          timestamp: Date.now(),
          correlationId: corrId,
        });
        const result = await responseWaiter.waitForResponse(corrId, params.timeout ?? 120_000);
        if (result.status === "response") {
          return {
            details: {},
            content: [{ type: "text" as const, text: "[" + params.to + " reply] " + result.content }],
          };
        }
        if (result.status === "cancelled") {
          return {
            details: {},
            content: [{ type: "text" as const, text: "Wait for " + params.to + " was cancelled." }],
          };
        }
        // timeout
        return {
          details: { timeout: true } as any,
          content: [{ type: "text" as const, text: "Timeout waiting for " + params.to + ". Use get_member_log to check, then re-wait if needed." }],
        };
      } finally {
        // Clean up the pending corr ID tracker in all paths (including exceptions)
        lastPendingCorrId.delete(params.to);
      }
    },
  });

  // ── get_member_status ─────────────────────────────────────
  pi.registerTool({
    name: "get_member_status",
    label: "Get Member Operational Status",
    description: "获取所有团队成员的运行状态（idle/working/crashed/stopped）。无参数。",
    promptGuidelines: [
      "Use get_member_status to check the operational status of all members before assigning tasks.",
    ],
    parameters: { type: "object", properties: {} } as any,
    async execute() {
      const entries = Array.from(memberOpsStates.entries());
      if (entries.length === 0) {
        return {
          details: {},
          content: [{ type: "text" as const, text: "还没有启动任何团队成员。请先使用 start_member 启动成员。" }],
        };
      }
      const lines = entries.map(([name, state]) => {
        const icon = state === "working" ? "🔧"
                   : state === "idle" ? "✅"
                   : state === "crashed" ? "💥"
                   : "⏹️";
        return `  ${icon} ${name}: ${state}`;
      });
      return {
        details: {},
        content: [{ type: "text" as const, text: `团队成员操作状态：\n${lines.join("\n")}` }],
      };
    },
  });

  // ── Custom autocomplete: team names for /team start|show|delete|edit ──
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, line, col, options) {
        const beforeCursor = (lines[line] ?? "").slice(0, col);
        const m = beforeCursor.match(/^\/team\s+(start|show|delete|edit)(\s+)(.*)$/);
        if (m) {
          const subCmd = m[1];     // e.g. "show"
          const spacing = m[2];    // e.g. " "
          const partial = m[3];    // typed team name (or empty)
          const { listTeams } = await import("./src/team/store");
          const { getRootDir } = await import("./src/config");
          const teams = listTeams(getRootDir());
          // Replace everything from subcommand onward: "show " -> "show teamname"
          const prefix = subCmd + spacing + partial;
          const items = teams
            .filter((t: string) => t.startsWith(partial))
            .map((t: string) => ({ value: `${subCmd} ${t}`, label: t }));
          return { prefix, items };
        }
        return current.getSuggestions(lines, line, col, options);
      },
      applyCompletion(lines, line, col, item, prefix) {
        return current.applyCompletion(lines, line, col, item, prefix);
      },
      shouldTriggerFileCompletion(lines, line, col) {
        const beforeCursor = (lines[line] ?? "").slice(0, col);
        if (/^\/team/.test(beforeCursor)) return false;
        return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
      },
    }));
  });

  // ── Register the /team command ────────────────────────────
  registerTeamCommand(pi, teamCtx, () =>
    (teamCtx.processManager?.listStatus().map((s) => ({
      name: s.name,
      status: s.status,
      pid: s.pid,
    })) ?? [])
  );

  // ── Team status widget (team mode visual indicator) ─────
  let teamStatusWidget: ReturnType<typeof createTeamStatusWidget> | null = null;

  // ── TL system prompt injection ───────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    const session = getSessionState();

    // Install team status widget when session becomes active
    if (session.active && session.teamDefinition && !teamStatusWidget) {
      teamStatusWidget = createTeamStatusWidget({
        teamName: session.teamDefinition.name,
        members: session.teamDefinition.members,
        teamCtx,
        memberOpsStates,
      });
      teamStatusWidget.install(ctx.ui, ctx.ui.theme);
    }

    // Clean up widget when session ends
    if (!session.active && teamStatusWidget) {
      teamStatusWidget.uninstall();
      teamStatusWidget = null;
    }

    let extraPrompt = "";

    if (teamCtx.isCreatingTeam) {
      extraPrompt = `
## 当前任务：创建团队定义

你正在引导用户创建一个新的团队。请通过自然语言对话收集信息。

### 自动推断规则
当用户描述角色时（如"一个worker负责编码"），自动推断：
- **label** = 用户描述中的中文角色名（如"编码员"）
- **name** = label 的英文/拼音标识符（如 \`worker\`），小写字母数字连字符
- **systemPrompt** = 根据用户描述的角色职责展开编写
- **model** = 按需指定，不填则用默认模型

**不要**追问 name 和 label——直接从用户的描述中推断。
除非你无法确定合适的标识符，才向用户确认。

### 收集清单
1. **团队名称和描述** — 由用户自由描述
2. **成员角色** — 用户说出每个角色的职责，你自动生成配置
3. **默认模型** — 按需指定（可选）

收集完后向用户展示汇总并确认，然后调用 \`create_team_definition\` 工具保存。
如果用户想取消操作，告诉用户输入 \`/team cancel\`。
`;
    } else if (teamCtx.editingTeamName) {
      const editName = teamCtx.editingTeamName;
      extraPrompt = `
## 当前任务：修改团队定义

你正在协助用户修改团队 **${editName}**。请通过自然语言对话了解用户想做的修改。

可能的修改包括：
- 修改团队名称或描述
- 添加新成员（name/label/systemPrompt/model）
- 修改现有成员（名称、提示词、模型）
- 删除成员
- 修改默认模型

**不要**追问 name 和 label——从用户的描述中推断。

了解清楚所有修改后，向用户展示修改汇总并确认，然后调用 \`update_team_definition\` 工具保存最终定义。
如果用户想取消操作，告诉用户输入 \`/team cancel\`。
`;
    } else if (session.active && session.teamDefinition) {
      const team = session.teamDefinition;
      const memberLines = team.members
        .map((m) => `  - ${m.name}（${m.label ?? m.name}）— ${m.systemPrompt.slice(0, 80)}`)
        .join("\n");

      extraPrompt = `
## 当前任务：Team Lead

你现在是一个 **Team Lead**，负责领导团队完成任务。

### 团队：${team.name}
${team.description}

### 团队成员
${memberLines}

### 核心原则：委派优先
- **能交给 Member 做的事，绝不自己做。** 你是 Team Lead 不是执行者。
- 需要分析代码？委派给分析员。需要修改文件？委派给开发员。需要验证？委派给测试员。
- 你的职责是：拆解任务、制定计划、分配工作、协调进度、处理异常。
- 只有以下情况才自己动手：涉及团队管理的决策、成员不可用时的紧急处理、向用户汇报结果。
- **成员完成任务后不要主动停止其进程。** Member 进程保持运行以便继续接收新任务。仅当成员进程异常时（崩溃、无响应），才使用 stop_member 终止后重新启动。

### 与用户讨论需求的方式

在拆解任务之前，**逐个方面**与用户深入讨论，每次只讨论一个话题，达成共识后再继续下一个。

**期间遵循以下原则：**

- **一次只问一个问题** — 等用户回复后再问下一个。不要一次性抛出多个问题让用户选择。
- **能用代码验证的，不要去问用户** — 如果问题可以通过阅读代码库来回答，先查阅代码再给出结论。
- **挑战模糊语言** — 当用户用词不精确时，提出更精确的术语。例如用户说"优化性能"——追问"你指的是减少响应时间还是降低资源占用？"
- **用场景检验边界** — 提出具体的边界场景来检验需求。例如"如果 A 成员依赖 B 成员的结果，但 B 还没完成怎么办？"
- **对照实际代码** — 当用户描述现有行为时，检查代码是否一致。发现矛盾时指出来让用户确认。
- **术语和决策立即固化** — 讨论中确定的关键术语、决策、约定，立即写入 .shared-context.md 的对应章节，不攒到后面。

.shared-context.md 应作为术语表和关键决策记录，不包含实现细节。当某个决策满足以下三个条件时，考虑创建 ADR 文档（在 docs/adr 目录下）：逆决策成本高、外人看会觉得意外、是经过真正权衡后选择的。

讨论达成共识后，拆解任务并委派给各 Member。

### 可用工具
你拥有 5 个团队管理工具：

1. **先写 Shared Context** — 用编辑器的 write 或 edit 工具创建 .shared-context.md
2. **start_member(name)** — 启动一个 Member 进程
3. **team_send_and_wait(to, content, timeout?)** — 给 Member 发任务并等待回复（阻塞）。需要成员的处理结果时使用
4. **team_send_message(to, subject?, content?)** — 只发消息不等待回复。仅通知或无需结果时使用
5. **list_members** — 查看各 Member 的运行状态
6. **get_member_log(name, lines?)** — 查看 Member 最近的对话记录
7. **stop_member(name)** — 终止 Member 进程

> 提示：team_send_and_wait 发送的消息包含 <corr:...> 标签。其他成员回复时需在内容中包含此标签，这样即使任务经过多次转交（A->B->TL），最终的回复也能正确匹配等待器。消息通道中的 Team Lead 名称是 tl。

### 流程
1. 先与用户充分讨论需求，直到和用户对齐细节
2. 拆解任务，制定计划
3. 编写 Shared Context（共享上下文），记录：团队成员、项目背景和目标、协作规则、术语表
4. 用 start_member 启动各 Member
5. 将 Shared Context 随首次任务消息一起发送给各 Member。**在消息中明确告知 Member 任务完成后必须回复 TL。**
6. 通过消息通道与 Member 交流，监控进展（可使用 team_send_and_wait 等待成员回复）
7. 根据需要更新 Shared Context，通知所有 Member 重新阅读
8. 任务完成后向用户汇报结果
9. 让用户决定是否 /team stop
`;
    }

    if (extraPrompt) {
      return { systemPrompt: event.systemPrompt + extraPrompt };
    }
  });
}
