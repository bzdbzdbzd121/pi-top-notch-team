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
  /** Called after a member is successfully started (for dynamic mode phase transitions). */
  onDynamicPhaseTransition?: () => void;
}

// ── Tool result types ──────────────────────────────────────

/** JSON Schema property descriptor (recursive). */
export interface ToolParameterProperty {
  type: string;
  description?: string;
  items?: ToolParameterProperty;
  properties?: Record<string, ToolParameterProperty>;
  required?: readonly string[];
  enum?: readonly string[];
  oneOf?: readonly Record<string, unknown>[];
  // Allow additional JSON Schema fields
  [key: string]: unknown;
}

/** JSON Schema for tool parameters (passed to LLM). */
export interface ToolInputSchema {
  type: "object";
  description?: string;
  properties: Record<string, ToolParameterProperty>;
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
    },
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
        // Notify the host about phase transition (e.g. dynamic mode design → execution)
        deps.onDynamicPhaseTransition?.();
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
    },
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
    },
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
      "Use wait_and_get_member_status FIRST for a quick status check (idle/working/crashed/stopped).",
      "Only use get_member_log when you need the detailed conversation content — it is heavier than wait_and_get_member_status.",
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
    },
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
      + "Use instead of team_send_message when you need the member result.\n"
      + "Waits indefinitely until the member replies or all members become idle.\n"
      + "Params: to (target), content (message body), nextSteps (下一步计划，wait 结束后返回给 TL 以强调工作流程).",
    promptGuidelines: [
      "Use team_send_and_wait when you need a member result before continuing.",
      "team_send_and_wait returns early with allIdle status when all members become idle.",
      "If all_idle is returned, check work results. If member is still working, call team_send_and_wait again.",
      "Always fill in nextSteps with what you plan to do after the wait ends — it will be returned to you to keep the workflow on track.",
    ],
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target member name" },
        content: { type: "string", description: "Message body" },
        nextSteps: { type: "string", description: "基于工作流程，wait 结束后下一步计划是什么。该信息会在工具返回时一并发送给你，用于强调工作流程方向。" },
      },
      required: ["to", "content", "nextSteps"],
    },
    async execute(
      _toolCallId: string,
      params: { to: string; content: string; nextSteps: string }
    ): Promise<ToolResult> {
      return sendAndWaitExecute(params, {
        responseWaiter,
        memberOpsStates,
        lastPendingCorrId,
        messageQueue,
      });
    },
  });

    // ── wait_and_get_member_status ───────────────────────────────────
  pi.registerTool({
    name: "wait_and_get_member_status",
    label: "Get Member Operational Status",
    description:
      "等待所有 member 空闲后查看所有 Member 的运行状态 (idle/working/crashed/stopped)。" +
      "No parameters. 如果任何 member 仍在工作中，该工具会阻塞直到所有 member 变为 idle。" +
      "和 team_send_and_wait 检测 all-idle 的方式相同。",
    promptGuidelines: [
      "Use wait_and_get_member_status FIRST to quickly check if members are idle, working, or crashed.",
      "wait_and_get_member_status now WAITS until all members are idle before returning.",
      "If no members started, returns immediately.",
      "Only use get_member_log when you need detailed conversation content.",
    ],
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      const entries = Array.from(memberOpsStates.entries());
      if (entries.length === 0) {
        return {
          details: {},
          content: [{ type: "text" as const, text: "还没有启动任何团队成员。请先使用 start_member 启动成员。" }],
        };
      }

      // Quick check: if all members are already idle, skip waiting
      if (!entries.every(([, s]) => s === "idle")) {
        // Wait until all members are idle (same mechanism as team_send_and_wait)
        await waitForAllIdle(memberOpsStates);
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

// ── Shared helpers ──────────────────────────────────────────

// Exported for testability
 export const WAIT_IDLE_REQUIRED_CONSECUTIVE = 4;
 export const WAIT_IDLE_CHECK_INTERVAL_MS = 3000;

/**
 * Wait until all members are in "idle" operational state.
 * Uses the same consecutive-idle-count mechanism as team_send_and_wait.
 * NOTE: Does NOT do a quick-start check — always polls for at least
 * WAIT_IDLE_REQUIRED_CONSECUTIVE checks. Callers that want a fast path
 * (e.g. wait_and_get_member_status) should do their own pre-check before calling.
 */
async function waitForAllIdle(
  memberOpsStates: Map<string, MemberOperationalState>
): Promise<void> {
  return new Promise<void>((resolve) => {
    let consecutiveIdleCount = 0;
    const pollTimer = setInterval(() => {
      const currentEntries = Array.from(memberOpsStates.entries());
      if (currentEntries.length > 0 && currentEntries.every(([, s]) => s === "idle")) {
        consecutiveIdleCount++;
        if (consecutiveIdleCount >= WAIT_IDLE_REQUIRED_CONSECUTIVE) {
          clearInterval(pollTimer);
          resolve();
        }
      } else {
        consecutiveIdleCount = 0;
      }
    }, WAIT_IDLE_CHECK_INTERVAL_MS);
  });
}

interface SendAndWaitCtx {
  responseWaiter: ResponseWaiter;
  memberOpsStates: Map<string, MemberOperationalState>;
  lastPendingCorrId: Map<string, string>;
  messageQueue: MessageQueue;
}

async function waitWithAllIdleCheck(
  corrId: string,
  memberName: string,
  nextSteps: string,
  ctx: SendAndWaitCtx
): Promise<ToolResult> {
  const { responseWaiter, memberOpsStates, lastPendingCorrId } = ctx;

  const waitPromise = responseWaiter.waitForResponse(corrId);
  const allIdlePromise = waitForAllIdle(memberOpsStates);

  const result = await Promise.race([waitPromise, allIdlePromise]);

  const nextStepsFooter = "\n\n---\n下一步计划：" + nextSteps;

  if (result && result.status === "response") {
    lastPendingCorrId.delete(memberName);
    return {
      details: { nextSteps },
      content: [{ type: "text" as const, text: "[" + memberName + " reply] " + result.content + nextStepsFooter }],
    };
  }
  if (result && result.status === "cancelled") {
    lastPendingCorrId.delete(memberName);
    return {
      details: { nextSteps },
      content: [{ type: "text" as const, text: "Wait for " + memberName + " was cancelled." + nextStepsFooter }],
    };
  }
  // all_idle — cancel the waiter so it doesn't orphan; keep lastPendingCorrId alive
  // so auto-injection works when the member's reply eventually arrives
  responseWaiter.cancelByCorrId(corrId);
  return {
    details: { allIdle: true, nextSteps },
    content: [{ type: "text" as const, text: "所有团队成员均处于空闲状态，" + memberName + " 可能已完成任务。请检查工作成果。" + nextStepsFooter }],
  };
}

async function sendAndWaitExecute(
  params: { to: string; content: string; nextSteps: string },
  ctx: SendAndWaitCtx
): Promise<ToolResult> {
  const { responseWaiter, lastPendingCorrId, messageQueue } = ctx;

  // Generate corr ID, send message, register waiter
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

  return waitWithAllIdleCheck(corrId, params.to, params.nextSteps, ctx);
}
