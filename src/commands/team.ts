import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { TeamContext } from "../session/context";
import { startSession } from "../session/state";
import { getSessionState, endSession } from "../session/state";
import { readTeam, listTeams, deleteTeam } from "../team/store";
import { getRootDir } from "../config";
import type { StatusProvider } from "./status";

/**
 * Register a single /team command that dispatches to subcommands.
 *
 * Usage:
 *   /team create          — 通过自然语言创建团队
 *   /team start <name>    — 启动团队会话
 *   /team stop            — 终止团队会话
 *   /team list            — 列出所有已创建的团队
 *   /team show <name>     — 显示团队定义详情
 *   /team delete <name>   — 删除团队定义
 *   /team status          — 查看当前团队会话状态
 */
export function registerTeamCommand(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  getMemberStatuses?: StatusProvider
): void {
  // Register the create_team_definition tool (used by TL during /team create)
  pi.registerTool({
    name: "create_team_definition",
    label: "Create Team Definition",
    description:
      "Call this tool after the user has confirmed the team details. " +
      "Saves the team YAML to disk and runs validation.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Team name (identifier)" },
        description: { type: "string", description: "Team description" },
        defaultModel: { type: "string", description: "Optional default model for all members" },
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
      const { validateTeamDefinition } = await import("../team/schema");
      const { writeTeam } = await import("../team/store");
      const { getRootDir } = await import("../config");

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
          details: {},
          content: [{
            type: "text" as const,
            text: `团队定义校验失败：\n${validation.errors.join("\n")}\n请修正后重试。`,
          }],
        };
      }

      writeTeam(teamData as any, getRootDir());
      teamCtx.isCreatingTeam = false;

      return {
        details: {},
        content: [{
          type: "text" as const,
          text: `团队 "${params.name}" 已创建成功！${params.members.length} 个成员已配置。用 /team list 查看，用 /team start ${params.name} 启动。`,
        }],
      };
    },
  });

  pi.registerCommand("team", {
    description: "管理团队（create / start / stop / list / show / delete / status）",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // prefix is everything after "/team " — e.g. "start 重" or "start "
      const parts = prefix.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() ?? "";

      // Only for subcommands that take a team name
      if (!["start", "show", "delete"].includes(subcommand)) return null;

      // Need at least a subcommand + something (trailing space gives empty string)
      if (parts.length < 2) return null;

      const teamPrefix = parts.slice(1).join(" ");
      const teams = listTeams(getRootDir());
      const items = teams.map((t) => ({
        value: `${subcommand} ${t}`,
        label: t,
      }));
      const filtered = items.filter((i) => i.label.startsWith(teamPrefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() ?? "";
      const subargs = parts.slice(1).join(" ");

      switch (subcommand) {
        // ── /team create ──────────────────────────────────
        case "create": {
          teamCtx.isCreatingTeam = true;
          ctx.ui.notify(
            "团队创建模式已启动。请告诉我你想创建的团队信息，TL 会引导你完成。",
            "info"
          );
          return;
        }

        // ── /team start <name> ────────────────────────────
        case "start": {
          const name = subargs.trim();
          if (!name) {
            ctx.ui.notify("用法：/team start <团队名称>", "warning");
            return;
          }

          const team = readTeam(name, getRootDir());
          if (!team) {
            ctx.ui.notify(`团队 "${name}" 不存在`, "warning");
            return;
          }

          startSession(team);
          teamCtx.router.updateMembers(team.members.map((m) => m.name));

          const tlToolNames = teamCtx.tlToolNames;
          const currentActive = pi.getActiveTools();
          const newActive = [...new Set([...currentActive, ...tlToolNames])];
          pi.setActiveTools(newActive);

          ctx.ui.notify(
            `团队 "${name}" 已就绪。${team.members.length} 个成员待启动。\n` +
              `TL 已获得进程管理工具（${tlToolNames.join(", ")}）。\n` +
              `请告诉 TL 你的任务需求，TL 会引导你完成。`,
            "info"
          );
          return;
        }

        // ── /team stop ────────────────────────────────────
        case "stop": {
          const session = getSessionState();
          if (!session.active) {
            ctx.ui.notify("当前无活跃团队会话", "info");
            return;
          }

          const teamName = session.teamDefinition?.name ?? "unknown";

          if (teamCtx.processManager) {
            await teamCtx.processManager.stopAll();
          }
          teamCtx.memberHandles.clear();
          teamCtx.router.updateMembers([]);

          const tlToolNames = teamCtx.tlToolNames;
          const currentActive = pi.getActiveTools();
          const newActive = currentActive.filter((t: string) => !tlToolNames.includes(t));
          pi.setActiveTools(newActive);

          endSession();
          ctx.ui.notify(`团队 "${teamName}" 会话已结束`, "info");
          return;
        }

        // ── /team list ────────────────────────────────────
        case "list": {
          const teams = listTeams(getRootDir());
          if (teams.length === 0) {
            ctx.ui.notify("还没有创建任何团队", "info");
          } else {
            ctx.ui.notify(`已创建的团队：${teams.join(", ")}`, "info");
          }
          return;
        }

        // ── /team show <name> ─────────────────────────────
        case "show": {
          const showName = subargs.trim();
          if (!showName) {
            ctx.ui.notify("用法：/team show <团队名称>", "warning");
            return;
          }

          const team = readTeam(showName, getRootDir());
          if (!team) {
            ctx.ui.notify(`团队 "${showName}" 不存在`, "warning");
            return;
          }

          let output = `团队：${team.name}\n`;
          output += `描述：${team.description}\n`;
          if (team.defaults?.model) {
            output += `默认模型：${team.defaults.model}\n`;
          }
          output += `成员（${team.members.length}）：\n`;
          for (const m of team.members) {
            output += `  - ${m.label ?? m.name}`;
            if (m.model) output += ` [${m.model}]`;
            output += `\n    提示词：${m.systemPrompt.slice(0, 60)}...\n`;
          }

          ctx.ui.notify(output, "info");
          return;
        }

        // ── /team delete <name> ───────────────────────────
        case "delete": {
          const deleteName = subargs.trim();
          if (!deleteName) {
            ctx.ui.notify("用法：/team delete <团队名称>", "warning");
            return;
          }

          const team = readTeam(deleteName, getRootDir());
          if (!team) {
            ctx.ui.notify(`团队 "${deleteName}" 不存在`, "warning");
            return;
          }

          const confirmed = await ctx.ui.confirm(
            "确认删除",
            `确定要删除团队 "${deleteName}" 吗？`
          );

          if (!confirmed) {
            ctx.ui.notify("已取消删除", "info");
            return;
          }

          deleteTeam(deleteName, getRootDir());
          ctx.ui.notify(`团队 "${deleteName}" 已删除`, "info");
          return;
        }

        // ── /team status ──────────────────────────────────
        case "status": {
          const session = getSessionState();
          if (!session.active || !session.teamDefinition) {
            ctx.ui.notify("当前无活跃团队会话", "info");
            return;
          }

          const team = session.teamDefinition;
          const elapsed = Math.floor((Date.now() - (session.startedAt ?? Date.now())) / 1000);
          const minutes = Math.floor(elapsed / 60);
          const seconds = elapsed % 60;

          let output = `活跃团队：${team.name}\n`;
          output += `描述：${team.description}\n`;
          output += `已运行：${minutes}分${seconds}秒\n`;
          output += `成员（${team.members.length}）：\n`;

          const statuses = getMemberStatuses?.() ?? [];
          const statusMap = new Map(statuses.map((s) => [s.name, s]));

          for (const m of team.members) {
            const actual = statusMap.get(m.name);
            if (actual) {
              const statusIcon =
                actual.status === "running" ? "🟢" :
                actual.status === "error" ? "🔴" : "⚪";
              output += `  ${statusIcon} ${m.label ?? m.name}: ${actual.status}`;
              if (actual.pid) output += ` (PID: ${actual.pid})`;
            } else {
              output += `  ⚪ ${m.label ?? m.name}: 未启动`;
            }
            output += `\n`;
          }

          ctx.ui.notify(output, "info");
          return;
        }

        // ── /team help ────────────────────────────────────
        case "help":
        default: {
          const usage = [
            `用法：/team <子命令> [参数]`,
            `  /team create           创建团队（自然语言对话）`,
            `  /team start <名称>      启动团队会话`,
            `  /team stop             终止团队会话`,
            `  /team list             列出所有已创建的团队`,
            `  /team show <名称>       显示团队定义详情`,
            `  /team delete <名称>     删除团队定义`,
            `  /team status           查看当前团队会话状态`,
            `  /team help             显示此帮助信息`,
          ].join("\n");

          ctx.ui.notify(usage, subcommand === "help" ? "info" : "warning");
        }
      }
    },
  });
}
