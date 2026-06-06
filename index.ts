import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerListCommand } from "./src/commands/list";
import { registerShowCommand } from "./src/commands/show";
import { registerDeleteCommand } from "./src/commands/delete";
import { registerStatusCommand } from "./src/commands/status";
import { startSession as startSessionState, endSession as endSessionState, getSessionState } from "./src/session/state";
import { readTeam, listTeams } from "./src/team/store";
import { getRootDir } from "./src/config";
import { registerTlTools } from "./src/tools/tl-tools";
import { createProcessManager } from "./src/process/manager";
import { createMemberProcess } from "./src/process/member-process";
import { createMessageQueue } from "./src/channel/message-queue";
import { createRouter } from "./src/channel/router";
import type { TeamMessage } from "./src/channel/types";
import { spawn } from "node:child_process";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  // Track whether the TL has the "create team" mission active
  let isCreatingTeam = false;

  // ── Register all 7 commands ──────────────────────────────
  registerListCommand(pi);
  registerShowCommand(pi);
  registerDeleteCommand(pi);
  registerStatusCommand(pi, () => processManager?.listStatus().map((s) => ({
    name: s.name,
    status: s.status,
    pid: s.pid,
  })) ?? []);

  // ── /team create: natural language team creation ─────────
  // Uses before_agent_start to inject instructions for the TL
  // and a custom tool (create_team_definition) to materialize the YAML.
  (() => {
    // Register the tool that the TL will call after collecting info
    pi.registerTool({
      name: "create_team_definition",
      label: "Create Team Definition",
      description:
        "Call this tool after the user has confirmed the team details. " +
        "Saves the team YAML to disk and runs validation. " +
        "Parameters: name (team name), description, members (array of {name, label?, systemPrompt, model?})",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Team name (identifier)" },
          description: { type: "string", description: "Team description" },
          defaultModel: {
            type: "string",
            description: "Optional default model for all members",
          },
          members: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                label: { type: "string" },
                systemPrompt: { type: "string" },
                model: { type: "string" },
              },
              required: ["name", "systemPrompt"],
            },
            description: "Team members",
          },
        },
        required: ["name", "description", "members"],
      } as any,
      async execute(
        _toolCallId: string,
        params: {
          name: string;
          description: string;
          defaultModel?: string;
          members: Array<{
            name: string;
            label?: string;
            systemPrompt: string;
            model?: string;
          }>;
        },
      ) {
        const { validateTeamDefinition } = await import("./src/team/schema");
        const { writeTeam } = await import("./src/team/store");
        const { getRootDir } = await import("./src/config");

        const teamData = {
          name: params.name,
          description: params.description,
          defaults: params.defaultModel ? { model: params.defaultModel } : undefined,
          members: params.members.map((m) => ({
            name: m.name,
            label: m.label,
            systemPrompt: m.systemPrompt,
            model: m.model,
          })),
        };

        const validation = validateTeamDefinition(teamData);
        if (!validation.valid) {
          return {
            content: [
              {
                type: "text" as const,
                text: `团队定义校验失败：\n${validation.errors.join("\n")}\n请修正后重试。`,
              },
            ],
            details: {},
          };
        }

        writeTeam(teamData as any, getRootDir());
        isCreatingTeam = false;

        return {
          content: [
            {
              type: "text" as const,
              text: `团队 "${params.name}" 已创建成功！${params.members.length} 个成员已配置。用 /team list 查看，用 /team start ${params.name} 启动。`,
            },
          ],
          details: {},
        };
      },
    });

    // Deactivate create_team_definition tool until /team create is used
    const allTools = pi.getAllTools().map((t) => t.name);
    pi.setActiveTools(allTools.filter((t) => t !== "create_team_definition"));

    // Register the /team create command
    pi.registerCommand("team-create", {
      description: "通过自然语言对话创建团队",
      handler: async (_args: string, ctx) => {
        // Inject create-team instructions for the TL's next response
        isCreatingTeam = true;
        ctx.ui.notify(
          "团队创建模式已启动。请告诉我你想创建的团队信息，TL 会引导你完成。",
          "info"
        );
      },
    });
  })();

  // ── TL tools: registered once, but only activated during team session ──
  let processManager: ReturnType<typeof createProcessManager> | null = null;
  // Map of member name → process handle for message channel sendCommand access
  const memberHandles: Map<string, ReturnType<typeof createMemberProcess>> = new Map();

  // Message channel: queue → router
  const router = createRouter({
    sendToMember: (memberName: string, msg: TeamMessage) => {
      const handle = memberHandles.get(memberName);
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
    memberNames: [], // populated when team starts
  });

  const messageQueue = createMessageQueue(async (msg: TeamMessage) => {
    console.warn("[team-queue] routing message:", msg.id, msg.from, "→", msg.to);
    router.route(msg);
  });

  /**
   * Create a member process handle, wire event listeners, and register
   * with both the processManager (lifecycle) and memberHandles (messaging).
   */
  function createAndRegisterMember(config: import("./src/process/member-process").MemberProcessConfig): ReturnType<typeof createMemberProcess> {
    const handle = createMemberProcess(config, spawn);
    memberHandles.set(config.name, handle);
    processManager?.addHandle(handle);

    // Wire message channel: intercept team_send_message tool calls
    handle.onEvent((event: any) => {
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
    });

    return handle;
  }

  /**
   * Build a MemberProcessConfig from team definition + member name.
   */
  function buildMemberConfig(memberName: string): import("./src/process/member-process").MemberProcessConfig | null {
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

  // Register TL tools once at startup (inactive by default)
  const manager = createProcessManager([], { autoRestart: true });
  processManager = manager;

  // getMemberLog: query member session via RPC get_messages
  async function getMemberLog(memberName: string, maxLines: number): Promise<string> {
    const handle = memberHandles.get(memberName);
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

  // ── /team start: activate team session ──────────────────
  pi.registerCommand("team-start", {
    description: "启动团队会话",
    handler: async (args: string, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("用法：/team start <团队名称>", "warning");
        return;
      }

      const team = readTeam(name, getRootDir());
      if (!team) {
        ctx.ui.notify(`团队 "${name}" 不存在`, "warning");
        return;
      }

      startSessionState(team);

      // Update message channel router with team members
      router.updateMembers(team.members.map((m) => m.name));

      // Activate TL tools by adding them to the active tool set
      const allTools = pi.getAllTools();
      const tlToolNames = ["start_member", "stop_member", "list_members", "get_member_log"];
      const currentActive = pi.getActiveTools();
      const newActive = [...new Set([...currentActive, ...tlToolNames])];
      pi.setActiveTools(newActive);

      ctx.ui.notify(
        `团队 "${name}" 已就绪。${team.members.length} 个成员待启动。\n` +
          `TL 已获得进程管理工具（start_member, stop_member, list_members, get_member_log）。\n` +
          `请告诉 TL 你的任务需求，TL 会引导你完成。`,
        "info"
      );
    },
  });

  // ── /team stop: end team session ────────────────────────
  pi.registerCommand("team-stop", {
    description: "终止当前团队会话",
    handler: async (_args: string, ctx) => {
      const session = getSessionState();

      if (!session.active) {
        ctx.ui.notify("当前无活跃团队会话", "info");
        return;
      }

      const teamName = session.teamDefinition?.name ?? "unknown";

      // Stop all member processes
      if (processManager) {
        await processManager.stopAll();
      }
      memberHandles.clear();
      router.updateMembers([]);

      // Deactivate TL tools
      const allTools = pi.getAllTools();
      const tlToolNames = ["start_member", "stop_member", "list_members", "get_member_log"];
      const currentActive = pi.getActiveTools();
      const newActive = currentActive.filter((t: string) => !tlToolNames.includes(t));
      pi.setActiveTools(newActive);

      endSessionState();
      ctx.ui.notify(`团队 "${teamName}" 会话已结束`, "info");
    },
  });

  // ── TL system prompt injection ───────────────────────────
  // When a team session is active, inject TL instructions.
  // When /team create is active, inject create-team instructions.
  pi.on("before_agent_start", async (event, _ctx) => {
    const { getSessionState } = await import("./src/session/state");
    const session = getSessionState();

    let extraPrompt = "";

    if (isCreatingTeam) {
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
        .map(
          (m) =>
            `  - ${m.name}（${m.label ?? m.name}）— ${m.systemPrompt.slice(0, 80)}`
        )
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
      return {
        systemPrompt: event.systemPrompt + extraPrompt,
      };
    }

    return;
  });
}
