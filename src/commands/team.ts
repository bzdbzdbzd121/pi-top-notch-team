import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { TeamContext } from "../session/context";
import { listTeams } from "../team/store";
import { getRootDir } from "../config";
import { isActive } from "../session/state";
import type { StatusProvider } from "./status";
import { workflowSchema } from "./shared/workflow-schema";
import { handleCreate } from "./handlers/create-handler";
import { handleDynamic } from "./handlers/dynamic-handler";
import { handleEdit } from "./handlers/edit-handler";
import { handleStart } from "./handlers/start-handler";
import { handleStop } from "./handlers/stop-handler";
import { handleDone } from "./handlers/done-handler";
import { handleList } from "./handlers/list-handler";
import { handleShow } from "./handlers/show-handler";
import { handleDelete } from "./handlers/delete-handler";
import { handleStatus } from "./handlers/status-handler";
import { handleSetting } from "./handlers/setting-handler";
import { handleHelp } from "./handlers/help-handler";

/**
 * Register a single /team command that dispatches to subcommand handlers.
 *
 * Usage:
 *   /team create          — 通过自然语言创建团队
 *   /team dynamic         — 动态团队模式（TL 自动设计团队）
 *   /team edit <name>     — 修改团队定义（自然语言对话）
 *   /team done            — 完成并退出创建或编辑模式
 *   /team start <name>    — 启动团队会话
 *   /team stop            — 终止团队会话
 *   /team list            — 列出所有已创建的团队
 *   /team show <name>     — 显示团队定义详情
 *   /team delete <name>   — 删除团队定义
 *   /team status          — 查看当前团队会话状态
 *   /team setting         — 交互式设置菜单（成员默认模型等）
 *   /team help            — 显示此帮助信息
 */
export function registerTeamCommand(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  getMemberStatuses?: StatusProvider
): void {
  pi.registerCommand("team", {
    description: "管理团队（create / start / stop / list / show / delete / status）",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // During active team session: show stop, status, help
      if (isActive()) {
        const SESSION_SUBCOMMANDS = [
          { value: "stop", label: "stop — 终止团队会话" },
          { value: "status", label: "status — 查看当前团队状态" },
          { value: "setting", label: "setting — 团队设置（成员默认模型）" },
          { value: "help", label: "help — 显示帮助信息" },
        ];
        const parts = prefix.split(/\s+/);
        const subcommand = parts[0]?.toLowerCase() ?? "";
        // Empty prefix: show all available session subcommands
        if (!subcommand) {
          return SESSION_SUBCOMMANDS;
        }
        // Filter subcommands by prefix
        const filtered = SESSION_SUBCOMMANDS.filter((s) => s.value.startsWith(subcommand));
        return filtered.length > 0 ? filtered : null;
      }

      // Outside session: show all subcommands
      const ALL_SUBCOMMANDS = ["create", "dynamic", "edit", "done", "cancel", "start", "stop", "list", "show", "delete", "status", "setting", "help"];
      const TEAM_NAME_SUBCOMMANDS = ["start", "show", "delete", "edit"];

      const parts = prefix.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() ?? "";

      // --- No subcommand yet: offer all subcommand names ---
      if (parts.length === 1 && !subcommand) {
        return ALL_SUBCOMMANDS.map((s) => ({ value: s, label: s }));
      }

      // --- Handles both "start" and "start " ---
      if (TEAM_NAME_SUBCOMMANDS.includes(subcommand)) {
        if (parts.length >= 2) {
          const teamPrefix = parts.slice(1).join(" ");
          const teams = listTeams(getRootDir());
          const items = teams.map((t) => ({
            value: `${subcommand} ${t}`,
            label: t,
          }));
          const filtered = items.filter((i) => i.label.startsWith(teamPrefix));
          return filtered.length > 0 ? filtered : null;
        }
        const teams = listTeams(getRootDir());
        const items = teams.map((t) => ({
          value: `${subcommand} ${t}`,
          label: t,
        }));
        return items.length > 0 ? items : null;
      }

      // --- Partial or fully typed subcommand ---
      if (parts.length === 1 && subcommand) {
        const filtered = ALL_SUBCOMMANDS.filter((s) => s.startsWith(subcommand));
        if (filtered.length === 1 && filtered[0] === subcommand) {
          if (TEAM_NAME_SUBCOMMANDS.includes(subcommand)) {
            const teams = listTeams(getRootDir());
            const items = teams.map((t) => ({
              value: `${subcommand} ${t}`,
              label: t,
            }));
            return items.length > 0 ? items : null;
          }
          return null;
        }
        return filtered.length > 0
          ? filtered.map((s) => ({ value: s, label: s }))
          : null;
      }

      return null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() ?? "";
      const subargs = parts.slice(1).join(" ");

      // During active team session: allow stop, status, setting, help (read-only / session-safe operations)
      const SESSION_ALLOWED = ["stop", "status", "setting", "help"];
      if (isActive() && !SESSION_ALLOWED.includes(subcommand)) {
        ctx.ui.notify("团队会话期间仅支持：/team stop、/team status、/team setting、/team help。请先结束会话。", "warning");
        return;
      }

      switch (subcommand) {
        case "dynamic":
          await handleDynamic(pi, teamCtx, ctx);
          return;
        case "create":
          await handleCreate(pi, teamCtx, ctx, workflowSchema);
          return;
        case "done":
        case "cancel":
          await handleDone(pi, teamCtx, ctx);
          return;
        case "edit":
          await handleEdit(pi, teamCtx, ctx, subargs, workflowSchema);
          return;
        case "start":
          await handleStart(pi, teamCtx, ctx, subargs);
          return;
        case "stop":
          await handleStop(pi, teamCtx, ctx);
          return;
        case "list":
          await handleList(ctx);
          return;
        case "show":
          await handleShow(ctx, subargs);
          return;
        case "delete":
          await handleDelete(ctx, subargs);
          return;
        case "status":
          await handleStatus(ctx, getMemberStatuses);
          return;
        case "setting":
          await handleSetting(ctx);
          return;
        case "help":
        default:
          await handleHelp(ctx, subcommand);
          return;
      }
    },
  });
}
