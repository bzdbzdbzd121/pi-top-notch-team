import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { TeamMessage } from "../channel/types";
import type { MemberOperationalState } from "../session/context";
import { createMemberProcess } from "../process/member-process";
import { spawn } from "node:child_process";

// ── Type aliases ───────────────────────────────────────────

type CreateMemberFn = (config: MemberProcessConfig) => MemberProcessHandle;
type BuildConfigFn = (memberName: string) => MemberProcessConfig | null;
type GetMemberLogFn = (memberName: string, maxLines: number, maxContentLength?: number) => Promise<string>;
// ── TlToolsDeps ────────────────────────────────────────────

export interface TlToolsDeps {
  pi: ExtensionAPI;
  manager: ProcessManager;
  responseWaiter: ResponseWaiter;
  memberOpsStates: Map<string, MemberOperationalState>;
  lastPendingCorrId: Map<string, string>;
  messageQueue: MessageQueue;
  createMember?: CreateMemberFn;
  buildMemberConfig?: BuildConfigFn;
  getMemberLog?: GetMemberLogFn;
}

// ── Tool result types ──────────────────────────────────────

/** JSON Schema for tool parameters (passed to LLM). */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: readonly string[];
}

export interface ToolResult {
  details: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
}

// ── Register all TL tools ──────────────────────────────────

export function registerTlTools(deps: TlToolsDeps): void {
  const {
    pi,
    manager,
    responseWaiter,
    memberOpsStates,
    lastPendingCorrId,
    messageQueue,
    createMember = (config) => createMemberProcess(config, spawn),
    buildMemberConfig,
    getMemberLog,
  } = deps;

  // ── start_member ────────────────────────────────────────
  pi.registerTool({
    name: "start_member",
    label: "Start Member",
    description:
      "Launch a Member's pi RPC process. The Member will be available for task assignment via the message channel. " +
      "Parameters: name (member identifier from the team definition).",
    promptGuidelines: [
      "Use start_member to launch a Member RPC process after writing the Shared Context document.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Member name (as defined in the team)",
        },
      },
      required: ["name"],
    } as ToolInputSchema,
    async execute(_toolCallId: string, params: { name: string }): Promise<ToolResult> {
      const config = buildMemberConfig?.(params.name);
      if (!config) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `无法启动成员 "${params.name}"：未找到该成员定义或无活跃团队会话。`,
            },
          ],
        };
      }

      try {
        const handle = createMember(config);
        await handle.start();
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `成员 "${params.name}" 已启动 (PID: ${handle.getState().pid})。使用 list_members 查看状态，通过消息通道分配任务。`,
            },
          ],
        };
      } catch (err) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `成员 "${params.name}" 启动失败：${err instanceof Error ? err.message : String(err)}`,
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
    promptGuidelines: [
      "Use stop_member to terminate a Member process when its task is complete or when ending the team session.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Member name",
        },
      },
      required: ["name"],
    } as ToolInputSchema,
    async execute(_toolCallId: string, params: { name: string }): Promise<ToolResult> {
      await manager.stop(params.name);
      return {
        details: {},
        content: [
          {
            type: "text" as const,
            text: `成员 "${params.name}" 已停止。`,
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
    promptGuidelines: [
      "Use list_members to check the status of all team members (running/stopped/error) during a team session.",
    ],
    parameters: {
      type: "object",
      properties: {},
    } as ToolInputSchema,
    async execute(): Promise<ToolResult> {
      const statuses = manager.listStatus();
      if (statuses.length === 0) {
        return {
          details: {},
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
        details: {},
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
      "Parameters: name (member identifier), lines (number of recent lines, default 3).",
    promptGuidelines: [
      "Use get_member_status FIRST for a quick status check (idle/working/crashed/stopped).",
      "Only use get_member_log when you need the detailed conversation content — it is heavier than get_member_status.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Member name",
        },
        lines: {
          type: "number",
          description: "Number of recent lines to fetch (default: 3)",
        },
        maxContentLength: {
          type: "number",
          description: "每条消息内容最大字符数（UTF-16 code units，默认 200），超出截断保留 effectiveMaxLen-3 字符 + '...'",
        },
      },
      required: ["name"],
    } as ToolInputSchema,
    async execute(
      _toolCallId: string,
      params: { name: string; lines?: number; maxContentLength?: number }
    ): Promise<ToolResult> {
      const maxLines = params.lines ?? 3;
      const status = manager.getStatus(params.name);
      if (!status || status.status !== "running") {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `成员 "${params.name}" 未在运行中，无法获取日志。`,
            },
          ],
        };
      }

      if (!getMemberLog) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `成员 "${params.name}" 日志查询功能不可用：未配置日志获取函数。`,
            },
          ],
        };
      }

      try {
        const logText = await getMemberLog(params.name, maxLines, params.maxContentLength);
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `成员 "${params.name}" 最近对话：\n\n${logText}`,
            },
          ],
        };
      } catch (err) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `读取成员 "${params.name}" 日志失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });

  // ── team_send_and_wait ─────────────────────────────────
  pi.registerTool({
    name: "team_send_and_wait",
    label: "Send Message and Wait",
    description:
      "Send a message to a team member and WAIT for their response. "
      + "Use instead of team_send_message when you need the member result. "
      + "Params: to (target), content (body, optional for re-wait), "
      + "Automatically stops waiting if all members become idle. "
      + "timeout (optional ms, default 1800000 = 30 min), "
      + "correlationId (optional, reuse from timeout for re-wait).",
    promptGuidelines: [
      "Use team_send_and_wait when you need a member result before continuing.",
      "On timeout: check get_member_status; if still working, call team_send_and_wait again with the same correlationId (from timeout details) to re-wait without sending a new message.",
      "team_send_and_wait returns early with allIdle status when all members become idle.",
    ],
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target member name" },
        content: {
          type: "string",
          description: "Message body (required on first call; omit for re-wait after timeout)",
        },
        timeout: { type: "number", description: "Max wait in ms (default 1800000 = 30 min, max 1800000)" },
        correlationId: { type: "string", description: "Reuse this correlation ID to re-wait after a timeout (no new message sent)" },
      },
      required: ["to", "content"],
    } as ToolInputSchema,
    async execute(
      _toolCallId: string,
      params: { to: string; content?: string; timeout?: number; correlationId?: string }
    ): Promise<ToolResult> {
      return sendAndWaitExecute(params, {
        responseWaiter,
        memberOpsStates,
        lastPendingCorrId,
        messageQueue,
      });
    },
  });

  // ── get_member_status ───────────────────────────────────
  pi.registerTool({
    name: "get_member_status",
    label: "Get Member Operational Status",
    description:
      "Quick lightweight check of all members' operational status (idle/working/crashed/stopped). " +
      "No parameters. Use this instead of get_member_log when you just need to know if a member is available.",
    promptGuidelines: [
      "Use get_member_status FIRST to quickly check if members are idle, working, or crashed.",
      "Only use get_member_log when you need detailed conversation content.",
    ],
    parameters: { type: "object", properties: {} } as ToolInputSchema,
    async execute(): Promise<ToolResult> {
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
}

// ── Shared helper: wait with all-idle early detection ──────

interface SendAndWaitCtx {
  responseWaiter: ResponseWaiter;
  memberOpsStates: Map<string, MemberOperationalState>;
  lastPendingCorrId: Map<string, string>;
  messageQueue: MessageQueue;
}

async function waitWithAllIdleCheck(
  corrId: string,
  timeoutMs: number,
  memberName: string,
  ctx: SendAndWaitCtx
): Promise<ToolResult> {
  const { responseWaiter, memberOpsStates, lastPendingCorrId } = ctx;

  const waitPromise = responseWaiter.waitForResponse(corrId, timeoutMs);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const allIdlePromise = new Promise<any>((resolve) => {
    pollTimer = setInterval(() => {
      const entries = Array.from(memberOpsStates.entries());
      if (entries.length > 0 && entries.every(([, s]) => s === "idle")) {
        clearInterval(pollTimer!);
        resolve({ status: "all_idle" });
      }
    }, 3000);
  });

  waitPromise.finally(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  const result = await Promise.race([waitPromise, allIdlePromise]);

  if (result.status === "response") {
    lastPendingCorrId.delete(memberName);
    return {
      details: {},
      content: [{ type: "text" as const, text: "[" + memberName + " reply] " + result.content }],
    };
  }
  if (result.status === "cancelled") {
    lastPendingCorrId.delete(memberName);
    return {
      details: {},
      content: [{ type: "text" as const, text: "Wait for " + memberName + " was cancelled." }],
    };
  }
  if (result.status === "all_idle") {
    // Cancel the waiter so it doesn't orphan; keep lastPendingCorrId alive
    // so auto-injection works when the member's reply eventually arrives.
    // reply → resolveIfWaiting (no waiter) → buffers → sendToTl → pi.sendMessage()
    responseWaiter.cancelByCorrId(corrId);
    return {
      details: { allIdle: true },
      content: [{ type: "text" as const, text: "所有团队成员均处于空闲状态，" + memberName + " 可能已完成任务。请检查工作成果。" }],
    };
  }
  // timeout — keep lastPendingCorrId entry for potential re-wait
  return {
    details: { timeout: true, correlationId: corrId },
    content: [{ type: "text" as const, text: "Timeout waiting for " + memberName + ". Use get_member_status to check. If still working, call team_send_and_wait again with the same correlationId to re-wait." }],
  };
}

async function sendAndWaitExecute(
  params: { to: string; content?: string; timeout?: number; correlationId?: string },
  ctx: SendAndWaitCtx
): Promise<ToolResult> {
  const { responseWaiter, lastPendingCorrId, messageQueue } = ctx;
  const effectiveTimeout = params.timeout ?? 1_800_000;

  // Re-wait: reuse existing correlation ID, no new message sent
  if (params.correlationId) {
    return waitWithAllIdleCheck(params.correlationId, effectiveTimeout, params.to, ctx);
  }

  // First-time wait: generate corr ID, send message, register waiter
  const corrId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  lastPendingCorrId.set(params.to, corrId);

  const messagePayload = {
    id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    from: "tl" as const,
    to: params.to,
    content: (params.content ?? "") + "\n\n<corr:" + corrId + ">",
    timestamp: Date.now(),
    correlationId: corrId,
  };

  messageQueue.enqueue(messagePayload as TeamMessage);

  return waitWithAllIdleCheck(corrId, effectiveTimeout, params.to, ctx);
}
