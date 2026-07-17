import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import type { ResponseWaiter, WaitResult } from "../channel/response-waiter";
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
      "Send message(s) to one or more team members and WAIT for their responses. "
      + "Use instead of team_send_message when you need the member result.\n"
      + "Waits until ALL targeted members reply or all members become idle.\n"
      + "Params: tasks (array of {to, content}), nextSteps (下一步计划，wait 结束后返回给 TL 以强调工作流程).\n"
      + "For a single member: tasks: [{to: \"name\", content: \"...\"}].\n"
      + "For multiple concurrent members: tasks: [{to: \"a\", content: \"...\"}, {to: \"b\", content: \"...\"}]",
    promptGuidelines: [
      "Use team_send_and_wait when you need a member result before continuing.",
      "⚠️ CRITICAL — tasks MUST be a raw JSON array, NOT a JSON-string-encoded array.",
      '   CORRECT: "tasks": [{ "to": "planner", "content": "..." }]',
      '   WRONG:   "tasks": "[{\"to\": \"planner\", ...}]"  ← Do NOT stringify. If you do, the system will auto-recover via JSON.parse.',
      "DECISION RULE — Batch vs Sequential:",
      "  • BATCH (multiple tasks[] entries) when: tasks are INDEPENDENT — no task's output is needed to craft another task's instructions. Example: concurrent code reviews of different files by different reviewers. Batch = parallel execution: all members work simultaneously.",
      "  • SEQUENTIAL (one team_send_and_wait per task) when: task B's instructions DEPEND on task A's result. Example: analyzer identifies issues → need that report to construct mover's refactoring task. Sequential = each task waits for the previous one.",
      "  • MIXED strategy: batch A+B for parallel discovery, then use their combined outputs to craft C's single-thread task. This is often the most efficient pattern.",
      "BATCH ADVANTAGE: concurrent execution — total wall-clock time ≈ slowest single task rather than sum of all tasks.",
      "SEQUENTIAL COST: total wall-clock time = sum of all task durations; every pause between tasks adds latency.",
      "team_send_and_wait waits for ALL tasks to complete. Returns PARTIAL results if some members become idle without replying — in batch mode, one member's failure does not block the other members' results from being returned.",
      "Always fill in nextSteps with what you plan to do after the wait ends — it will be returned to you to keep the workflow on track.",
    ],
    parameters: {
      type: "object",
      properties: {
        tasks: {
          oneOf: [
            {
              type: "array",
              description: "正确格式：原始 JSON 数组",
              items: {
                type: "object",
                properties: {
                  to: { type: "string", description: "目标成员名称" },
                  content: { type: "string", description: "消息内容" },
                },
                required: ["to", "content"],
              },
            },
            {
              type: "string",
              description: "自动修复：JSON 字符串编码的数组会被 parseTasks 自动恢复",
            },
          ],
          description:
            "⚠️ 必须传原始 JSON 数组，不能传 JSON 编码过的字符串。"
            + "正确示例: tasks: [{to: \"planner\", content: \"...\"}]\n"
            + "错误示例: tasks: \"[{to: 'planner', content: '...'}]\"（这是字符串，框架会自动放行并修复）\n"
            + "要发送的任务列表。单个成员也使用 tasks 数组（如 [{to: \"name\", content: \"...\"}]）。多个成员同时发送时并发执行。",
        },
        nextSteps: { type: "string", description: "基于工作流程，wait 结束后下一步计划是什么。该信息会在工具返回时一并发送给你，用于强调工作流程方向。" },
      },
      required: ["tasks", "nextSteps"],
    },
    async execute(
      _toolCallId: string,
      params: { tasks: unknown; nextSteps: string }
    ): Promise<ToolResult> {
      return sendAndWaitExecute(params as Parameters<typeof sendAndWaitExecute>[0], {
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

/** A pending task with its generated correlation ID. */
interface PendingTask {
  to: string;
  content: string;
  corrId: string;
}

/**
 * Generate a unique correlation ID for team_send_and_wait matching.
 */
function generateCorrId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Wait for ALL pending tasks to complete, or all members to become idle
 * (partial completion). Returns combined results.
 */
async function waitWithAllIdleCheck(
  tasks: PendingTask[],
  nextSteps: string,
  ctx: SendAndWaitCtx
): Promise<ToolResult> {
  const { responseWaiter, memberOpsStates, lastPendingCorrId } = ctx;

  const nextStepsFooter = "\n\n---\n下一步计划：" + nextSteps;

  // Collect results as they arrive
  const results = new Map<string, WaitResult>();

  // Create individual wait promises that record results when resolved
  const waitPromises = tasks.map(async (t) => {
    const r = await responseWaiter.waitForResponse(t.corrId);
    results.set(t.to, r);
    return r;
  });

  const allDonePromise = Promise.all(waitPromises);
  const allIdlePromise = waitForAllIdle(memberOpsStates);

  // Race: all tasks done vs all members idle
  const raceResult = await Promise.race([
    allDonePromise.then(() => "all_done" as const),
    allIdlePromise.then(() => "all_idle" as const),
  ]);

  if (raceResult === "all_done") {
    // All tasks completed successfully
    for (const t of tasks) {
      lastPendingCorrId.delete(t.to);
    }
    const parts: string[] = [];
    for (const t of tasks) {
      const r = results.get(t.to);
      if (r && r.status === "response") {
        parts.push(`[${r.from} reply] ${r.content}`);
      } else if (r && r.status === "cancelled") {
        parts.push(`[${t.to}] ⚠️ 等待被取消`);
      }
    }
    return {
      details: { nextSteps },
      content: [{ type: "text" as const, text: parts.join("\n\n---\n") + nextStepsFooter }],
    };
  }

  // all_idle — collect partial results
  for (const t of tasks) {
    if (!results.has(t.to)) {
      responseWaiter.cancelByCorrId(t.corrId);
    } else {
      lastPendingCorrId.delete(t.to);
    }
  }

  const parts: string[] = [];
  for (const t of tasks) {
    const r = results.get(t.to);
    if (r && r.status === "response") {
      parts.push(`[${r.from} reply] ${r.content}`);
    } else {
      parts.push(`[${t.to}] ⚠️ 未收到回复（成员可能已停止或崩溃）`);
    }
  }

  return {
    details: { allIdle: true, partial: true, nextSteps },
    content: [{ type: "text" as const, text: parts.join("\n\n---\n") + nextStepsFooter }],
  };
}

/** Parsed task from LLM input — handles both raw array and string-encoded array. */
function parseTasks(raw: unknown): Array<{ to: string; content: string }> {
  // Already an array (correct case)
  if (Array.isArray(raw)) {
    return raw as Array<{ to: string; content: string }>;
  }

  // String-encoded array — LLM sometimes double-encodes JSON-in-JSON
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed as Array<{ to: string; content: string }>;
      }
    } catch {
      // Not parseable; fall through to error
    }
  }

  // Single object wrapped outside array — another common LLM hallucination
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.to === "string" && typeof obj.content === "string") {
      return [{ to: obj.to, content: obj.content }];
    }
  }

  return [];
}

async function sendAndWaitExecute(
  params: { tasks: unknown; nextSteps: string },
  ctx: SendAndWaitCtx
): Promise<ToolResult> {
  const { responseWaiter, lastPendingCorrId, messageQueue } = ctx;

  const tasks = parseTasks(params.tasks);

  // Validate: at least one task
  if (tasks.length === 0) {
    const receivedType = typeof params.tasks;
    const receivedPreview = typeof params.tasks === "string"
      ? params.tasks.slice(0, 120)
      : JSON.stringify(params.tasks).slice(0, 120);
    return {
      details: {},
      content: [{
        type: "text" as const,
        text: "tasks 无效。需要原始 JSON 数组（如 [{to: \"name\", content: \"...\"}]），"
          + `但收到了 ${receivedType} 类型的值：${receivedPreview}。\n\n`
          + "⚠️ 注意：tasks 不能传 JSON 字符串，必须传原始数组。\n"
          + "正确：\"tasks\": [{ \"to\": \"planner\", \"content\": \"...\" }]\n"
          + "错误：\"tasks\": \"[{...}]\"  ← 不要额外序列化成字符串",
      }],
    };
  }

  // Generate corr IDs for each task and enqueue messages
  const pendingTasks: PendingTask[] = [];
  const now = Date.now();

  for (const task of tasks) {
    const corrId = generateCorrId();
    lastPendingCorrId.set(task.to, corrId);

    pendingTasks.push({ to: task.to, content: task.content, corrId });

    const messagePayload = {
      id: `msg-${now}-${Math.random().toString(36).slice(2, 8)}`,
      from: "tl" as const,
      to: task.to,
      content: task.content + "\n\n<corr:" + corrId + ">",
      timestamp: now,
      correlationId: corrId,
    };
    messageQueue.enqueue(messagePayload as TeamMessage);
  }

  return waitWithAllIdleCheck(pendingTasks, params.nextSteps, ctx);
}
