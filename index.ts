import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTeamCommand } from "./src/commands/team";
import { getSessionState } from "./src/session/state";
import type { TeamContext } from "./src/session/context";
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
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait"],
    router: null as any,
    messageQueue: null as any,
    responseWaiter: null as any,
  };

  // ── Message channel: queue → router ──────────────────────
  const router = createRouter({
    sendToMember: (memberName: string, msg: TeamMessage) => {
      const handle = teamCtx.memberHandles.get(memberName);
      if (!handle) {
        console.warn(`[team] Cannot send to unknown member: ${memberName}`);
        return;
      }
      try {
        handle.sendCommand({
          type: "prompt",
          message: `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`,
        });
      } catch (err) {
        console.warn(`[team] Failed to send to ${memberName}:`, err);
      }
    },
    sendToTl: (msg: TeamMessage) => {
      // Check if ResponseWaiter has a pending wait for this message
      const corrId = msg.correlationId ?? extractCorrelationId(msg.content);
      if (corrId) {
        const resolved = responseWaiter.resolveIfWaiting(
          corrId, msg.from, msg.content, msg.subject
        );
        if (resolved) return; // consumed by waiter, skip sendMessage
      }
      pi.sendMessage({
        customType: "team-message",
        content: `[消息通道 - 来自 ${msg.from}]\n${msg.subject ? `主题：${msg.subject}\n` : ""}${msg.content}`,
        display: true,
        details: { msg },
      });
    },
    memberNames: [],
  });

  const messageQueue = createMessageQueue(async (msg: TeamMessage) => {
    console.warn("[team-queue] routing message:", msg.id, msg.from, "→", msg.to);
    router.route(msg);
  });

  const responseWaiter = createResponseWaiter();

  teamCtx.router = router;
  teamCtx.messageQueue = messageQueue;
  teamCtx.responseWaiter = responseWaiter;

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
      // Primary: team_send_message tool result
      if (event.type === "tool_execution_end" && event.toolName === "team_send_message") {
        const teamMsg = event.result?.details?.teamMessage;
        if (teamMsg) {
          messageQueue.enqueue({
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            from: teamMsg.from,
            to: teamMsg.to,
            subject: teamMsg.subject,
            content: teamMsg.content,
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
          messageQueue.enqueue({
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            from: config.name,
            to: parsed.to,
            subject: parsed.subject,
            content: parsed.content,
            timestamp: Date.now(),
          });
        }
      }

      // Handle process exit
      if (event.type === "process_exit" && event.wasRunning) {
        const memberName = event.memberName;
        const exitCode = event.exitCode;
        console.warn(`[team] Member "${memberName}" exited with code ${exitCode}`);

        // Exit code 143 = SIGTERM (128 + 15), which is a normal stop via stop_member
        // Exit code 0 or null = clean exit
        const isNormalExit = exitCode === null || exitCode === 0 || exitCode === 143;

        if (!isNormalExit) {
          // Notify TL only on unexpected crashes
          pi.sendMessage({
            customType: "team-message",
            content: `Member "${memberName}" 进程异常退出（code: ${exitCode}），需检查崩溃原因。`,
            display: true,
            details: { crashEvent: event },
          });
        } else {
          console.warn(`[team] Member "${memberName}" stopped normally (code: ${exitCode})`);
        }
      }

      if (event.type === "process_error") {
        const memberName = event.memberName;
        console.warn(`[team] Member "${memberName}" process error`);
        pi.sendMessage({
          customType: "team-message",
          content: `Member "${memberName}" 进程异常，需检查崩溃原因。`,
          display: true,
        });
      }
    });

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
    const sharedContextPath = join(getRootDir(), "sessions", team.name, "shared-context.md");

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
      console.warn(`[team] Member "${name}" crashed ${restarts} times`);
    },
  });
  teamCtx.processManager = manager;

  // getMemberLog: query member session via RPC get_messages
  async function getMemberLog(memberName: string, maxLines: number): Promise<string> {
    const handle = teamCtx.memberHandles.get(memberName);
    if (!handle) {
      throw new Error(`Member "${memberName}" not found`);
    }

    const response = await handle.sendCommandAndWait(
      { type: "get_messages" },
      (event: any) => event.type === "response" && event.command === "get_messages"
    );

    const messages = response?.data?.messages ?? [];
    const recent = messages.slice(-maxLines);
    return recent
      .map(
        (m: any) =>
          `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`
      )
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

  // ── TL system prompt injection ───────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const session = getSessionState();
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

### 可用工具
你拥有 5 个团队管理工具：

1. **先写 Shared Context** — 用编辑器的 write 或 edit 工具创建 shared-context.md
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
5. 将 Shared Context 随首次任务消息一起发送给各 Member
6. 通过消息通道与 Member 交流，监控进展
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
