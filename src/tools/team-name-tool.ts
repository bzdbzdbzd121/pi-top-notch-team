import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamContext } from "../session/context";
import { getRootDir } from "../config";
import { getSessionState } from "../session/state";
import { applyTeamName } from "../session/rename-team";
import { ensureToolRegistered } from "../commands/shared/ensure-tool";
import { SET_TEAM_NAME_TOOL_NAME } from "./team-name-tool-names";

/** Result details (kept as one shape so every branch type-checks). */
interface SetTeamNameDetails {
  ok: boolean;
  code?: string;
  teamName?: string;
  previousName?: string;
  moved?: boolean;
  dir?: string;
}

/**
 * `set_team_name` — name the current dynamic team during the design phase.
 *
 * A mode tool (same lifecycle family as add_dynamic_member): registered by the
 * dynamic bootstrap and by /team resume, activated only in dynamic sessions.
 * Not part of the 9 session tools (SESSION_TOOL_NAMES stays untouched) — a
 * pre-defined team keeps using /team edit.
 *
 * The tool itself is thin: all transaction logic (window checks, directory
 * move, manifest rollback, stub rewrite) lives in src/session/rename-team.ts.
 */
export function ensureSetTeamNameTool(pi: ExtensionAPI, teamCtx: TeamContext): void {
  ensureToolRegistered(pi, SET_TEAM_NAME_TOOL_NAME, () => {
    pi.registerTool({
      name: SET_TEAM_NAME_TOOL_NAME,
      label: "Set Team Name",
      description:
        "Name the current dynamic team. Available only in dynamic sessions (/team dynamic and agent-initiated start_team_session) " +
        "and only in the design phase, before any member process starts: renaming MOVES the whole session directory " +
        "sessions/<old>/<sessionId> → sessions/<new>/<sessionId> and updates the manifest, the status bar, /team status, " +
        "/team resume and the TEAM_NAME of members started later. After the first start_member the name is frozen (calling " +
        "this tool is rejected with the reason) because the member session dirs, shared-context paths and TEAM_NAME are " +
        "already fixed inside the running processes. Name rules: letters/digits/CJK, '-' and '_', at most 20 display " +
        "columns, and not the same as an existing pre-defined team. Parameters: name (required).",
      promptGuidelines: [
        "Call set_team_name once after the plan is confirmed (or right after start_team_session) and before registering members: a readable name is what the user sees in the status bar, /team status and /team resume.",
        "成员启动后不可改名——再调用会被拒绝并说明原因；请在 start_member 之前完成命名。",
        "命名失败不会破坏会话：名字非法或与预定义团队同名时目录与状态都不变，换一个名字重试即可。",
      ],
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Team name: letters/digits/CJK, '-' and '_' only, must start and end with a letter or digit, " +
              "at most 20 display columns (CJK counts as 2), and not the same as an existing pre-defined team.",
          },
        },
        required: ["name"],
      },
      async execute(_toolCallId: string, params: { name?: string }) {
        const requested = typeof params?.name === "string" ? params.name : "";
        if (!requested.trim()) {
          const details: SetTeamNameDetails = { ok: false, code: "invalid" };
          return {
            details,
            content: [
              {
                type: "text" as const,
                text: "set_team_name 需要 name 参数：请提供团队名（字母/数字/中文，'-' 和 '_'，最多 20 显示列）。",
              },
            ],
          };
        }

        const outcome = applyTeamName(requested, {
          rootDir: getRootDir(),
          isDynamic: teamCtx.isDynamicSession,
          dynamicPhase: teamCtx.dynamicPhase,
          hasRunningMember: () =>
            [...teamCtx.memberHandles.values()].some(
              (handle) => handle.getState().status === "running"
            ),
          onRenamed: teamCtx.onTeamRenamed,
        });

        if (!outcome.ok) {
          const details: SetTeamNameDetails = { ok: false, code: outcome.code };
          return {
            details,
            content: [{ type: "text" as const, text: `❌ ${outcome.message}` }],
          };
        }

        const sessionId = getSessionState().sessionId ?? "";
        const lines: string[] = [];
        if (outcome.moved) {
          lines.push(
            `✅ 团队已命名为「${outcome.name}」（原名「${outcome.previousName}」）。` +
              `会话目录：sessions/${outcome.name}/${sessionId}/（已迁移）。`
          );
          lines.push(
            "生效范围：状态栏、/team status、/team resume 与之后启动成员的 TEAM_NAME 都使用新名。"
          );
        } else {
          lines.push(`✅ 团队名已是「${outcome.name}」，未做任何改动。`);
        }
        if (outcome.adjusted) {
          lines.push(`（输入「${requested}」已归一为「${outcome.name}」。）`);
        }
        if (outcome.moved && outcome.stubRewritten) {
          lines.push("共享上下文仍是系统占位文件，已同步为新团队名。");
        } else if (outcome.moved) {
          lines.push(
            "共享上下文已被 TL 写入，未自动改写其中的团队名；如需更新请再调用 write_shared_context。"
          );
        }

        return {
          details: {
            ok: true,
            teamName: outcome.name,
            previousName: outcome.previousName,
            moved: outcome.moved,
            dir: outcome.dir,
          } satisfies SetTeamNameDetails,
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      },
    });
  });
}
