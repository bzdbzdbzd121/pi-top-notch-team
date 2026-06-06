import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import { createMemberProcess } from "../process/member-process";
import { spawn } from "node:child_process";

type CreateMemberFn = (config: MemberProcessConfig) => MemberProcessHandle;

/**
 * Register the 4 TL process management tools.
 * These tools are only active during a team session.
 */
export function registerTlTools(
  pi: ExtensionAPI,
  manager: ProcessManager,
  createMember: CreateMemberFn = (config) => createMemberProcess(config, spawn)
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
      return {
        content: [
          {
            type: "text" as const,
            text: `Member "${params.name}" 启动请求已提交。使用 list_members 查看状态。`,
          },
        ],
      };
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
      const lines = statuses.map(
        (s) => `  - ${s.name}: ${s.status}${s.pid ? ` (PID: ${s.pid})` : ""}`
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              statuses.length === 0
                ? "没有活跃的团队成员"
                : `团队成员状态：\n${lines.join("\n")}`,
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

      return {
        content: [
          {
            type: "text" as const,
            text: `Member "${params.name}" 的日志查询功能需要在 Phase 4 中通过 RPC 的 get_messages 命令实现。\n当前状态：${status.status} (PID: ${status.pid})`,
          },
        ],
      };
    },
  });
}
