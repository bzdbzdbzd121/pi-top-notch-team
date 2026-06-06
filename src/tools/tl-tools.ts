import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import { createMemberProcess } from "../process/member-process";
import { spawn } from "node:child_process";

type CreateMemberFn = (config: MemberProcessConfig) => MemberProcessHandle;
type BuildConfigFn = (memberName: string) => MemberProcessConfig | null;
type GetMemberLogFn = (memberName: string, maxLines: number) => Promise<string>;

/**
 * Register the 4 TL process management tools.
 * These tools are only active during a team session.
 */
export function registerTlTools(
  pi: ExtensionAPI,
  manager: ProcessManager,
  createMember: CreateMemberFn = (config) => createMemberProcess(config, spawn),
  buildMemberConfig?: BuildConfigFn,
  getMemberLog?: GetMemberLogFn
): void {
  // ── start_member ────────────────────────────────────────
  pi.registerTool({
    name: "start_member",
    label: "Start Member",
    description:
      "Launch a Member's pi RPC process. The Member will be available for task assignment via the message channel. " +
      "Parameters: name (member identifier from the team definition).",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Member name (as defined in the team)",
        },
      },
      required: ["name"],
    } as any,
    async execute(_toolCallId: string, params: { name: string }) {
      // Build config from team definition and create the process
      const config = buildMemberConfig?.(params.name);
      if (!config) {
        return {
          content: [
            {
              type: "text" as const,
              text: `无法启动 Member "${params.name}"：未找到该成员定义或无活跃团队会话。`,
            },
          ],
        };
      }

      try {
        const handle = createMember(config);
        await handle.start();
        return {
          content: [
            {
              type: "text" as const,
              text: `Member "${params.name}" 已启动 (PID: ${handle.getState().pid})。使用 list_members 查看状态，通过消息通道分配任务。`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Member "${params.name}" 启动失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });

  // ── stop_member ─────────────────────────────────────────
  pi.registerTool({
    name: "stop_member",
    label: "Stop Member",
    description:
      "Gracefully terminate a Member's pi RPC process. " +
      "Parameters: name (member identifier).",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Member name",
        },
      },
      required: ["name"],
    } as any,
    async execute(_toolCallId: string, params: { name: string }) {
      await manager.stop(params.name);
      return {
        content: [
          {
            type: "text" as const,
            text: `Member "${params.name}" 已停止。`,
          },
        ],
      };
    },
  });

  // ── list_members ────────────────────────────────────────
  pi.registerTool({
    name: "list_members",
    label: "List Members",
    description: "Show the current status of all team members.",
    parameters: {
      type: "object",
      properties: {},
    } as any,
    async execute() {
      const statuses = manager.listStatus();
      if (statuses.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "还没有启动任何团队成员。请先使用 start_member 启动成员。",
            },
          ],
        };
      }
      const lines = statuses.map(
        (s) => `  - ${s.name}: ${s.status}${s.pid ? ` (PID: ${s.pid})` : ""}`
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `团队成员状态：\n${lines.join("\n")}`,
          },
        ],
      };
    },
  });

  // ── get_member_log ──────────────────────────────────────
  pi.registerTool({
    name: "get_member_log",
    label: "Get Member Log",
    description:
      "Retrieve a Member's recent conversation log to check their progress. " +
      "Parameters: name (member identifier), lines (number of recent lines, default 10).",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Member name",
        },
        lines: {
          type: "number",
          description: "Number of recent lines to fetch (default: 10)",
        },
      },
      required: ["name"],
    } as any,
    async execute(_toolCallId: string, params: { name: string; lines?: number }) {
      const maxLines = params.lines ?? 10;
      const status = manager.getStatus(params.name);
      if (!status || status.status !== "running") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Member "${params.name}" 未在运行中，无法获取日志。`,
            },
          ],
        };
      }

      if (!getMemberLog) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Member "${params.name}" 日志查询功能不可用：未配置日志获取函数。`,
            },
          ],
        };
      }

      try {
        const logText = await getMemberLog(params.name, maxLines);
        return {
          content: [
            {
              type: "text" as const,
              text: `Member "${params.name}" 最近对话：\n\n${logText}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `读取 Member "${params.name}" 日志失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });
}
