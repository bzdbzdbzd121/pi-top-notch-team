import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionState, isActive, markSharedContextWritten } from "../session/state";
import { getSharedContextPath } from "../session/shared-context";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * write_shared_context — the ONLY sanctioned way to write the team shared
 * context (.shared-context.md).
 *
 * Background: the TL (an LLM) historically wrote the shared context with the
 * generic `write` tool BEFORE calling start_member, and that ordering was not
 * reliably followed — members often started with a dangling/stub shared
 * context. This tool makes the write explicit and trackable:
 *
 *   - It writes to the session's .shared-context.md path (never arbitrary files).
 *   - On success it marks the session's sharedContextWritten flag, which is
 *     the gate start_member checks — a member cannot start until the TL has
 *     called this tool at least once.
 *   - The tool_call guard intercepts direct write/edit calls targeting
 *     .shared-context.md and redirects the TL here, so the flag stays accurate.
 *
 * The tool is NOT registered at extension init — like all other session-only
 * tools it is registered on-demand at session start (onSessionStart) and
 * activated via teamCtx.tlToolNames (setActiveTools). Outside a team session
 * it does not exist in the tool registry at all.
 */

export const SHARED_CONTEXT_TOOL_NAME = "write_shared_context";

/** Tool result shape (same as other TL tools). */
interface ToolResult {
  details: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
}

export function registerSharedContextTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SHARED_CONTEXT_TOOL_NAME,
    label: "Write Shared Context",
    description:
      "Write the team's shared context document to the session's .shared-context.md. " +
      "MUST be called at least once before starting any member — start_member is blocked " +
      "until this tool has been called (members read the shared context at startup). " +
      "Content should cover: project background & goals, member roles, workflow, " +
      "collaboration rules, glossary & key decisions. Call again to update; after an " +
      "update, notify all members to re-read the file.",
    promptGuidelines: [
      "Call write_shared_context BEFORE the first start_member — the system blocks start_member until the shared context has been written.",
      "Include: project background & goals, member roles and responsibilities, workflow, collaboration rules, glossary & key decisions.",
      "After updating the shared context, tell members via team_send_and_wait to re-read .shared-context.md.",
    ],
    promptSnippet: "Write/update the team shared context (.shared-context.md). Required before start_member.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "Full Markdown content of the shared context document. Overwrites the previous content — include the complete document, not just diffs.",
        },
      },
      required: ["content"],
    },
    async execute(
      _toolCallId: string,
      params: { content: string }
    ): Promise<ToolResult> {
      // Guard: only available during active team sessions
      if (!isActive()) {
        return {
          details: {},
          content: [{ type: "text" as const, text: "write_shared_context 只能在活跃的团队会话中使用。请先通过 /team start 或 /team dynamic 启动团队会话。" }],
        };
      }

      const session = getSessionState();
      const team = session.teamDefinition;
      if (!team) {
        return {
          details: {},
          content: [{ type: "text" as const, text: "无法写入共享上下文：当前会话没有团队定义。" }],
        };
      }

      const path = getSharedContextPath(team.name, session.sessionId);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, params.content, "utf-8");
      } catch (err) {
        // Fail-open: report the failure; do NOT mark the flag so start_member stays blocked.
        return {
          details: {},
          content: [{ type: "text" as const, text: `写入共享上下文失败：${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      markSharedContextWritten();
      return {
        details: { path, chars: params.content.length },
        content: [
          {
            type: "text" as const,
            text:
              `共享上下文已写入 ${path}（${params.content.length} 字符）。\n` +
              `✅ 现在可以调用 start_member 启动成员了。\n` +
              `ℹ️ 后续如需更新：再次调用本工具，然后通过 team_send_and_wait 通知所有成员重新阅读 .shared-context.md。`,
          },
        ],
      };
    },
  });
}
