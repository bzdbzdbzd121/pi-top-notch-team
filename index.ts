import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerListCommand } from "./src/commands/list";
import { registerShowCommand } from "./src/commands/show";
import { registerDeleteCommand } from "./src/commands/delete";
import { registerStatusCommand } from "./src/commands/status";
import { registerCreateCommand } from "./src/commands/create";
import { registerStartCommand } from "./src/commands/start";
import { registerStopCommand } from "./src/commands/stop";
import { getSessionState } from "./src/session/state";
import type { TeamContext } from "./src/session/context";
import { registerTlTools } from "./src/tools/tl-tools";
import { createProcessManager } from "./src/process/manager";
import { createMemberProcess } from "./src/process/member-process";
import { createMessageQueue } from "./src/channel/message-queue";
import { createRouter } from "./src/channel/router";
import type { TeamMessage } from "./src/channel/types";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getRootDir } from "./src/config";

export default function (pi: ExtensionAPI) {
  // ── Shared mutable state ──────────────────────────────────
  const teamCtx: TeamContext = {
    isCreatingTeam: false,
    processManager: null,
    memberHandles: new Map(),
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log"],
    router: null as any,
    messageQueue: null as any,
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

  teamCtx.router = router;
  teamCtx.messageQueue = messageQueue;

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

      // Handle process crash: auto-restart + notify TL
      if (event.type === "process_exit" && event.wasRunning) {
        const memberName = event.memberName;
        const exitCode = event.exitCode;
        console.warn(`[team] Member "${memberName}" exited with code ${exitCode}, auto-restarting...`);

        // Trigger auto-restart via manager
        teamCtx.processManager?.handleExit(memberName, exitCode);

        // Notify TL via message channel
        pi.sendMessage({
          customType: "team-message",
          content: `Member "${memberName}" 进程异常退出（code: ${exitCode}），已自动重启。`,
          display: true,
          details: { crashEvent: event },
        });
      }

      if (event.type === "process_error") {
        const memberName = event.memberName;
        console.warn(`[team] Member "${memberName}" process error`);
        teamCtx.processManager?.handleExit(memberName, null);
        pi.sendMessage({
          customType: "team-message",
          content: `Member "${memberName}" 进程异常，已自动重启。`,
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

  const manager = createProcessManager([], { autoRestart: true });
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

  registerTlTools(pi, manager, createAndRegisterMember, buildMemberConfig, getMemberLog);

  // ── Register all 7 commands ──────────────────────────────
  registerListCommand(pi);
  registerShowCommand(pi);
  registerDeleteCommand(pi);
  registerStatusCommand(pi, () =>
    (teamCtx.processManager?.listStatus().map((s) => ({
      name: s.name,
      status: s.status,
      pid: s.pid,
    })) ?? [])
  );
  registerCreateCommand(pi, teamCtx);
  registerStartCommand(pi, teamCtx);
  registerStopCommand(pi, teamCtx);

  // ── TL system prompt injection ───────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const session = getSessionState();
    let extraPrompt = "";

    if (teamCtx.isCreatingTeam) {
      extraPrompt = `
## 当前任务：创建团队定义

你正在引导用户创建一个新的团队。请通过自然语言对话收集以下信息：

1. **团队名称** — 用作标识符（小写字母、数字、连字符）
2. **团队描述** — 简要说明这个团队的用途
3. **成员角色** — 每个角色需要：
   - name：标识符（同团队名称规则）
   - label：可读的名称（可选）
   - systemPrompt：角色提示词，定义该成员的行为和能力
   - model：使用的模型（可选，不填则使用默认模型）
4. **默认模型**（可选）— 所有成员的默认模型

收集完信息后，向用户展示汇总，确认无误后调用 \`create_team_definition\` 工具保存。

如果用户提供的信息不完整，继续追问直到完整。
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
