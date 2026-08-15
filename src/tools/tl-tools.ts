import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import type { ResponseWaiter, WaitResult } from "../channel/response-waiter";
import type { MessageQueue } from "../channel/message-queue";
import type { TeamMessage } from "../channel/types";
import type { AutoCompactRuntime } from "../channel/auto-compact";
import type { ResolvedAutoCompact } from "../settings/resolve-auto-compact";
import type { MemberOperationalState } from "../session/context";
import { getSessionState } from "../session/state";
import { syncActiveManifest } from "../session/manifest";
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
  /**
   * Resolve the effective Auto-Compaction config (per call, so /team setting
   * changes take effect immediately). Absent = feature disabled.
   */
  getAutoCompact?: () => ResolvedAutoCompact;
  /** Resolve a member's process handle by name (batch barrier compact RPC). */
  getHandle?: (name: string) => MemberProcessHandle | undefined;
  /**
   * Shared auto-compaction runtime (from createMessageChannel). The batch
   * barrier and the inline dispatch path share one pending/flush mechanism.
   * Absent = the batch barrier is disabled (legacy path).
   */
  autoCompact?: AutoCompactRuntime;
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
      // ── Shared context gate ──
      // A member must never start before the TL has written the shared context
      // (members read .shared-context.md at startup). Only the
      // write_shared_context tool lifts this gate.
      const sessionState = getSessionState();
      if (!sessionState.active || !sessionState.sharedContextWritten) {
        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text:
                `无法启动成员 "${params.name}"：共享上下文尚未写入。\n\n` +
                `请先调用 \`write_shared_context\` 工具，将团队共享上下文（项目背景与目标、成员分工、工作流、协作规则、术语表与关键决策）写入 .shared-context.md，然后再调用 start_member。`,
            },
          ],
        };
      }

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
        // Persist started member + pid into the session manifest (/team resume
        // restarts exactly this set and uses pids for orphan cleanup).
        syncActiveManifest({ startedMember: { name: params.name, pid: handle.getState().pid } });
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
      // Intentional stop: remove from the manifest's started set so a later
      // /team resume does not revive a member the TL deliberately stopped.
      syncActiveManifest({ stoppedMember: params.name });
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
      "BATCH ALIGNMENT (自动压缩): in a multi-task batch, if a member needs auto-compaction, ALL prompts of the batch wait until the LAST needed compaction finishes, then dispatch together — no member starts early (unified start). The barrier is internal and fully silent — the TL only experiences a longer wait, bounded by the batch budget (default 15 min, /team setting).",
      "team_send_and_wait waits for ALL tasks to complete. Returns PARTIAL results if some members become idle without replying — in batch mode, one member's failure does not block the other members' results from being returned.",
      "Always fill in nextSteps with what you plan to do after the wait ends — it will be returned to you to keep the workflow on track.",
    ],
    parameters: {
      type: "object",
      properties: {
        tasks: {
          // `as any` on the closing brace: TypeBox's Static<> cannot infer
          // the JSON-schema `oneOf` keyword (tasks collapses to `undefined`),
          // which breaks the execute param variance check. Runtime schema
          // and validation are unaffected.
          oneOf: [
            {
              type: "array",
              description: "正确格式：原始 JSON 数组，条目为 {to, content} 对象",
              // P1（schema 放宽）：items 有意放宽为 {}，不再要求 type/required。
              // 流式输出截断时框架 partial-json 会把缺字段条目静默补全成
              // "合法但缺 to"的对象——若 items 带硬约束，TypeBox oneOf 在
              // execute 之前短路，parseTasks 的防御性恢复被完全架空，且框架
              // 错误文本误导 TL 反复原样重试。放宽后所有条目形态（null/标量/
              // 缺字段对象）都进入 execute，由 isValidTask 统一过滤并逐条提示。
              items: {},
            },
            {
              type: "object",
              // P1：单对象形态（LLM 幻觉）激活 parseTasks 的包裹路径。
              // 刻意不设 required：设了会让缺字段单对象同时命中 array+object+
              // string 三分支失败，oneOf 噪音不减反增（D4 裁决）——与 array
              // 分支同策略，由 execute 的 isValidTask 统一判定。
              description: "自动修复：单个任务对象会被 parseTasks 自动包裹为数组",
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
        } as any,
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
        autoCompact: deps.autoCompact,
        getAutoCompact: deps.getAutoCompact,
        getHandle: deps.getHandle,
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

      // Quick check: if no member is actively working, skip waiting.
      // "stopped" and "crashed" members won't transition to "idle" on their own.
      const anyActive = entries.some(([, s]) => s === "working" || s === "compacting");
      if (anyActive) {
        // Wait until all members are idle (same mechanism as team_send_and_wait)
        await waitForAllIdle(memberOpsStates);
      }

      const lines = entries.map(([name, state]) => {
        const icon = state === "working" ? "🔧"
                   : state === "compacting" ? "🗜️"
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
 * Wait until all members are no longer actively working.
 * "Active" means "working" or "compacting" — these states indicate
 * a member is processing a task. Members in "idle", "stopped", or
 * "crashed" state are considered done (they won't transition on their own).
 *
 * Uses the same consecutive-count mechanism as the original waitForAllIdle.
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

      // Check if any member is actively working (won't resolve on its own).
      // Empty map = trivially no active members.
      const anyActive = currentEntries.some(
        ([, s]) => s === "working" || s === "compacting"
      );

      if (!anyActive) {
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
  /** Shared auto-compaction runtime — required for the batch barrier. Absent = legacy path. */
  autoCompact?: AutoCompactRuntime;
  /** Resolve the effective auto-compaction config. Absent = feature disabled. */
  getAutoCompact?: () => ResolvedAutoCompact;
  /** Resolve a member's process handle (batch barrier compact RPC). */
  getHandle?: (name: string) => MemberProcessHandle | undefined;
}

// ── Batch alignment barrier (phase 3) ──────────────────────
// Unified-start semantics: when a batch (tasks.length > 1) needs
// auto-compaction, EVERY prompt in the batch is sent only after the LAST
// needed compaction completes — none may start early. Compactions run
// STRICTLY SERIAL (one compact RPC at a time): without PD separation,
// concurrent compactions are concurrent prefill bursts — the exact problem
// the user reported.
//
// Scope: only the tasks[] explicit targets participate (to:"all" broadcasts
// are excluded, E13). Member-to-member messages and Inspector direct
// messages never participate (manual intervention wins).
//
// Architecture invariant E1: the WHOLE barrier runs BEFORE any corrId
// registration / enqueue, so no wait detection can fire early. This order
// is locked by tests (messageQueue stays empty until all compactions end).

/** Poll interval for waiting on compacting members (WAIT phase). */
const BARRIER_WAIT_POLL_MS = 1000;

/**
 * Pure decision for the batch alignment barrier.
 *
 * Classifies the deduped explicit target set by operational state:
 *   - idle → toQuery: stats decide whether compaction is needed
 *   - compacting → toWait: a compaction is already in flight (inline path /
 *     previous batch after Esc) — never send a second compact (D3); wait
 *     until it ends instead
 *   - working/crashed/stopped → skip: messages go through the existing
 *     followUp / undeliverable paths, nothing to align (E6/E16)
 *
 * `cfg` is retained in the signature for future policy extensions (e.g. a
 * parallel-compaction switch); classification itself only depends on state.
 */
export function planBatchCompaction(
  targets: string[],
  getState: (name: string) => MemberOperationalState,
  _cfg: ResolvedAutoCompact
): BatchCompactionPlan {
  const plan: BatchCompactionPlan = { toQuery: [], toWait: [], skip: [] };
  for (const name of targets) {
    const state = getState(name);
    if (state === "idle") {
      plan.toQuery.push(name);
    } else if (state === "compacting") {
      plan.toWait.push(name);
    } else {
      plan.skip.push(name);
    }
  }
  return plan;
}

export interface BatchCompactionPlan {
  /** Idle members — the barrier queries their stats in parallel. */
  toQuery: string[];
  /** Members already compacting — wait for them instead of re-compacting (E3). */
  toWait: string[];
  /** working/crashed/stopped members — not part of the barrier. */
  skip: string[];
}

/**
 * Wait until all given members are out of `compacting`, or the deadline
 * passes. 1s poll (BARRIER_WAIT_POLL_MS); deadline = batch budget
 * (0 = unlimited).
 *
 * Release condition is "not compacting" (idle / crashed / stopped all
 * release): a toWait member that crashes mid-compaction or is stopped via
 * /team stop would otherwise never reach idle and the poll would hang until
 * the deadline (or forever with an unlimited budget). Once the compaction is
 * no longer running, alignment is meaningless — the batch proceeds and the
 * member's messages take the existing undeliverable/followUp paths.
 */
function waitForMembersIdle(
  names: string[],
  memberOpsStates: Map<string, MemberOperationalState>,
  deadline: number
): Promise<void> {
  return new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      const allReleased = names.every((n) => memberOpsStates.get(n) !== "compacting");
      if (allReleased || Date.now() >= deadline) {
        clearInterval(poll);
        resolve();
      }
    }, BARRIER_WAIT_POLL_MS);
    // Do not keep the process alive just for the poll if the tool call is
    // abandoned (e.g. session teardown while the barrier waits).
    if (typeof (poll as NodeJS.Timeout).unref === "function") {
      (poll as NodeJS.Timeout).unref();
    }
  });
}

/**
 * Run the batch alignment barrier for the deduped explicit targets.
 *
 * Returns the set of members that actually received a compaction ATTEMPT
 * (success OR failure — "at most one compaction per dispatch"). Only those
 * members' messages carry skipAutoCompact in the commit phase; members
 * skipped by maxWait budget, missing handles, or non-S classification get
 * no marker, so the inline path naturally gives them a second chance.
 *
 * Fail-open everywhere: stats failures, compaction failures, timeouts and
 * budget overruns all end with the batch dispatched as-is.
 *
 * The barrier is FULLY SILENT to the TL — it is an internal mechanism; the
 * TL only experiences a longer wait inside team_send_and_wait. No [批屏障]
 * notices are sent (they were removed: the TL does not need to perceive
 * the compaction barrier).
 */
async function runBatchCompactionBarrier(
  targets: string[],
  ctx: SendAndWaitCtx
): Promise<Set<string>> {
  const cfg = ctx.getAutoCompact?.();
  const runtime = ctx.autoCompact;
  const getHandle = ctx.getHandle;
  if (!cfg?.enabled || !runtime || !getHandle) {
    return new Set<string>();
  }

  const plan = planBatchCompaction(
    targets,
    (name) => ctx.memberOpsStates.get(name) ?? "idle",
    cfg
  );

  // Total batch budget: WAIT phase + all compactions share it (D1 maxWait).
  const budgetMs =
    cfg.batchMaxWaitMinutes > 0 ? cfg.batchMaxWaitMinutes * 60_000 : Infinity;
  const deadline = Date.now() + budgetMs;

  // 1. WAIT: members already compacting (E3 — never re-compact). Silent —
  //    the barrier is internal; the TL only experiences a longer wait.
  //    Releases as soon as a member is out of compacting (crashed/stopped
  //    included — no hang).
  if (plan.toWait.length > 0) {
    await waitForMembersIdle(plan.toWait, ctx.memberOpsStates, deadline);
    if (Date.now() >= deadline) {
      return new Set<string>();
    }
  }

  // 2. PREPARE: parallel stats query (local RPC, no model calls — safe to
  //    parallelize). Per-member fail-open: failures count as "no compaction".
  const statsResults = await Promise.all(
    plan.toQuery.map(async (name): Promise<{ name: string; needs: boolean }> => {
      const handle = getHandle(name);
      if (!handle) return { name, needs: false }; // no handle → not part of barrier
      const result = await runtime.queryStats(name, handle);
      return { name, needs: result.ok && runtime.shouldCompact(result.stats, cfg) };
    })
  );
  const toCompact = statsResults.filter((r) => r.needs).map((r) => r.name);

  // 3. COMPACT: strictly serial (at most one compact RPC at a time). A
  //    compaction already in flight when the budget runs out is left to run
  //    to its own timeout — "stop remaining" means stop NOT-YET-STARTED
  //    compactions only.
  const attempted = new Set<string>();
  for (const name of toCompact) {
    if (Date.now() >= deadline) {
      // Budget exhausted — stop the not-yet-started compactions (D1:
      // maxWait fallback). Silent: the batch still dispatches as-is.
      break;
    }
    // Re-check state: the member may have left idle between stats and here
    // (gap race, E15). Non-idle members are skipped WITHOUT the marker — the
    // inline path handles them naturally.
    if (ctx.memberOpsStates.get(name) !== "idle") continue;
    const handle = getHandle(name);
    if (!handle) continue;

    // Synchronous state set before any await (race-free, F2 pattern);
    // finally-reset on every path (F3 / E8: Esc-safe). Success and failure
    // are both silent — the batch dispatches as-is either way (fail-open).
    runtime.beginCompaction(name);
    await runtime.compactNow(name, handle, cfg);
    runtime.endCompaction(name);

    // Success or failure both count as an attempt (at most one per dispatch).
    attempted.add(name);
  }

  return attempted;
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
  ctx: SendAndWaitCtx,
  preamble = ""
): Promise<ToolResult> {
  const { responseWaiter, memberOpsStates, lastPendingCorrId } = ctx;

  const nextStepsFooter = "\n\n---\n下一步计划：" + nextSteps;
  const preambleBlock = preamble ? preamble + "\n\n---\n" : "";

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
      content: [{ type: "text" as const, text: preambleBlock + parts.join("\n\n---\n") + nextStepsFooter }],
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
    content: [{ type: "text" as const, text: preambleBlock + parts.join("\n\n---\n") + nextStepsFooter }],
  };
}

interface ParsedTasks {
  tasks: Array<{ to: string; content: string }>;
  /** 非空时表示输入不规范（salvage 恢复 / 条目被丢弃），需要在结果中提醒 TL。 */
  recoveryNote: string;
  /**
   * 被丢弃条目的字段级原因（P1）：recoveryNote 逐条提示的数据源，
   * 也是 0 任务分支截断启发式的输入（缺 to 且 content 超长 → 疑似截断）。
   */
  droppedDetails: DroppedTaskDetail[];
}

/** 被丢弃条目的字段级信息（P1）。 */
interface DroppedTaskDetail {
  /** 条目在 tasks 数组中的下标（逐条提示定位用）。 */
  index: number;
  /** 人类可读的字段级无效原因（逐条提示展示用）。 */
  reason: string;
  /** 条目 content 字段的字符长度（0 任务截断启发式用）。 */
  contentLength: number;
  /**
   * 结构化截断嫌疑判据（W1/S4）：to 字段缺失（而非类型错误）——流式截断
   * 意味着 to 的字节从未发出，partial-json 修复后表现为字段缺失；而
   * {to: 123} 类型错误、null 元素等与截断无关形态不误报。用布尔字段而非
   * 字符串 contains 匹配，避免 reason 文案改动破坏判定。
   */
  missingTo: boolean;
}

/**
 * 0 任务截断启发式的 content 长度阈值：被丢弃条目缺 to 且 content 超过
 * 该长度时，错误文案显式给出截断指引（D8——只做间接推断，不做未闭合检测：
 * execute 层拿到的是 partial-json 修复后的对象，截断痕迹已丢失）。
 */
export const TRUNCATION_CONTENT_THRESHOLD = 500;

/** 条目判定结果：有效（含规范化任务）或无效（含字段级原因 + 截断嫌疑标记）。 */
type TaskClassification =
  | { ok: true; task: { to: string; content: string } }
  | { ok: false; reason: string; missingTo: boolean };

/**
 * 条目分类器（P1）：单一判定源。细分"为什么无效"：
 * 非对象 / 缺 to / 缺 content / 两者都缺。missingTo 只对"to 字段缺失"
 * 置位（类型错误如 {to: 123} 不算截断嫌疑——W1 语义）。
 */
function classifyTask(t: unknown): TaskClassification {
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    return { ok: false, reason: "不是对象", missingTo: false };
  }
  const rec = t as Record<string, unknown>;
  const missingTo = !("to" in rec);
  const toOk = typeof rec.to === "string" && rec.to !== "";
  const contentOk = typeof rec.content === "string" && rec.content !== "";
  if (toOk && contentOk) {
    return { ok: true, task: { to: rec.to as string, content: rec.content as string } };
  }
  if (!toOk && !contentOk) return { ok: false, reason: "缺少有效的 to 与 content 字段", missingTo };
  if (!toOk) return { ok: false, reason: "缺少有效的 to 字段", missingTo };
  return { ok: false, reason: "缺少有效的 content 字段", missingTo };
}

/** 条目 content 字段的字符长度（截断启发式用；非字符串按 0 计）。 */
function contentLengthOf(t: unknown): number {
  if (typeof t !== "object" || t === null) return 0;
  const content = (t as Record<string, unknown>).content;
  return typeof content === "string" ? content.length : 0;
}

function isValidTask(t: unknown): t is { to: string; content: string } {
  return classifyTask(t).ok;
}

/** Extract a string field from a broken JSON object snippet. Tolerates raw control chars and key order. */
function extractStringField(snippet: string, key: string): string | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s");
  const m = snippet.match(re);
  if (!m) return undefined;
  // Re-escape raw control characters so JSON.parse accepts the string literal
  const repaired = m[1]
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  try {
    return JSON.parse(`"${repaired}"`) as string;
  } catch {
    return m[1];
  }
}

/** Find top-level {...} spans in a (possibly broken) JSON array string. Unterminated tail is included as a candidate. */
function extractObjectSpans(raw: string): string[] {
  const spans: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    if (raw[i] !== "{") { i++; continue; }
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let j = i;
    let closed = false;
    for (; j < n; j++) {
      const ch = raw[j];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { closed = true; j++; break; }
        }
      }
    }
    if (closed) {
      spans.push(raw.slice(i, j));
      i = j;
    } else {
      // Unterminated tail (e.g. truncated LLM output) — keep as salvage candidate, then stop
      spans.push(raw.slice(i));
      break;
    }
  }
  return spans;
}

/** Salvage tasks from a string that failed strict JSON.parse (truncation, raw newlines, ...). */
function salvageFromString(raw: string): { tasks: Array<{ to: string; content: string }>; dropped: number } {
  const tasks: Array<{ to: string; content: string }> = [];
  let dropped = 0;
  for (const span of extractObjectSpans(raw)) {
    let obj: unknown;
    try { obj = JSON.parse(span); } catch { obj = undefined; }
    if (isValidTask(obj)) {
      tasks.push({ to: obj.to, content: obj.content });
      continue;
    }
    // Regex fallback tolerates raw control characters inside the string values
    const to = extractStringField(span, "to");
    const content = extractStringField(span, "content");
    if (to && content) {
      tasks.push({ to, content });
      continue;
    }
    dropped++;
  }
  return { tasks, dropped };
}

function validateTaskArray(arr: unknown[]): ParsedTasks {
  const tasks: Array<{ to: string; content: string }> = [];
  const droppedDetails: DroppedTaskDetail[] = [];
  arr.forEach((t, index) => {
    const cls = classifyTask(t);
    if (cls.ok) {
      tasks.push({ to: cls.task.to, content: cls.task.content });
    } else {
      droppedDetails.push({
        index,
        reason: cls.reason,
        contentLength: contentLengthOf(t),
        missingTo: cls.missingTo,
      });
    }
  });
  return {
    tasks,
    droppedDetails,
    recoveryNote: buildDropRecoveryNote(droppedDetails),
  };
}

/**
 * 丢弃提示（P1 逐条化）：首行中性描述 + 逐条字段级原因。
 * 截断嫌疑警告单独条件化（W1）：仅当存在缺 to 条目（missingTo）时才提示
 * "疑似截断"——{to:123} 类型错误、null 元素等与截断无关形态不误报。
 * 与正常结果分离（recoveryNote 独立字段，不混入正文）。
 */
function buildDropRecoveryNote(droppedDetails: DroppedTaskDetail[]): string {
  if (droppedDetails.length === 0) return "";
  const lines = [`⚠️ ${droppedDetails.length} 个任务条目无效已被丢弃。`];
  const truncationSuspects = droppedDetails.filter((d) => d.missingTo);
  if (truncationSuspects.length > 0) {
    lines.push(
      `其中 ${truncationSuspects.length} 条缺少 to 字段，疑似参数生成时被截断（常见于 content 过长）。`
    );
  }
  lines.push(...droppedDetails.map((d) => `tasks[${d.index}] ${d.reason}，已丢弃`));
  return lines.join("\n");
}

/** Parsed tasks from LLM input — handles raw array, string-encoded array, single object, and broken JSON salvage. */
function parseTasks(raw: unknown): ParsedTasks {
  // Already an array (correct case)
  if (Array.isArray(raw)) {
    return validateTaskArray(raw);
  }

  // String-encoded array — LLM sometimes double-encodes JSON-in-JSON
  if (typeof raw === "string") {
    let strictFailed = false;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return validateTaskArray(parsed);
      }
      if (isValidTask(parsed)) {
        return { tasks: [{ to: parsed.to, content: parsed.content }], recoveryNote: "", droppedDetails: [] };
      }
    } catch {
      strictFailed = true;
    }
    // Salvage mode: strict parse failed (truncated output, raw newlines in content, ...)
    // or parsed to something unusable. Recover complete task objects best-effort.
    const { tasks, dropped } = salvageFromString(raw);
    if (tasks.length > 0) {
      return {
        tasks,
        recoveryNote:
          `⚠️ tasks 以字符串传入且不是合法 JSON${strictFailed ? "（解析失败）" : ""}，已尽力恢复 ${tasks.length} 个任务` +
          (dropped > 0 ? `，丢弃 ${dropped} 个不完整条目` : "") +
          "。请核对恢复出的任务是否完整；下次直接传原始数组可避免信息丢失。",
        droppedDetails: [],
      };
    }
    return { tasks: [], recoveryNote: "", droppedDetails: [] };
  }

  // Single object wrapped outside array — another common LLM hallucination
  if (isValidTask(raw)) {
    return { tasks: [{ to: raw.to, content: raw.content }], recoveryNote: "", droppedDetails: [] };
  }

  // Invalid non-array object (e.g. truncated `{content: "..."}` single object):
  // record the field-level reason so the 0-task branch can apply the
  // truncation heuristic (缺 to + 超长 content).
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const cls = classifyTask(raw);
    // raw 无效（上方 isValidTask 已放行有效对象）→ cls 必为 ok:false
    if (!cls.ok) {
      return {
        tasks: [],
        recoveryNote: "",
        droppedDetails: [
          { index: 0, reason: cls.reason, contentLength: contentLengthOf(raw), missingTo: cls.missingTo },
        ],
      };
    }
  }

  return { tasks: [], recoveryNote: "", droppedDetails: [] };
}

async function sendAndWaitExecute(
  params: { tasks: unknown; nextSteps: string },
  ctx: SendAndWaitCtx
): Promise<ToolResult> {
  const { responseWaiter, lastPendingCorrId, messageQueue, memberOpsStates } = ctx;

  const { tasks, recoveryNote, droppedDetails } = parseTasks(params.tasks);

  // Validate: at least one task
  if (tasks.length === 0) {
    const receivedType = typeof params.tasks;
    const receivedPreview = typeof params.tasks === "string"
      ? params.tasks.slice(0, 300)
      : JSON.stringify(params.tasks)?.slice(0, 300);
    let parseHint = "";
    if (receivedType === "string") {
      try {
        JSON.parse(params.tasks as string);
      } catch (e) {
        parseHint = `\nJSON.parse 失败原因：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // 截断启发式（P1，D8）：间接推断——被丢弃条目缺 to（missingTo，结构化
    // 判据）且 content 超长。不做"未闭合引号"检测：execute 层拿到的是
    // partial-json 修复后的对象，截断痕迹在修复层已丢失，无法直接检测。
    // 命中时显式给出截断指引，打断 TL "原样重试 → 再截断 → 再失败"的
    // 死循环（β 死循环机制）。
    const truncationSuspect = droppedDetails.some(
      (d) => d.missingTo && d.contentLength > TRUNCATION_CONTENT_THRESHOLD
    );
    const truncationHint = truncationSuspect
      ? "\n\n⚠️ 参数疑似在输出传输中被截断（常见于 content 过长）。请精简 content、拆分为多次调用，或将长文本写入共享上下文后引用。"
      : "";
    // S2：把逐条字段原因（recoveryNote）也拼入错误文本——仅 receivedPreview
    // 展示原始值无法让 TL 定位"为什么无效"。
    const recoveryBlock = recoveryNote ? `\n\n${recoveryNote}` : "";
    return {
      details: {},
      content: [{
        type: "text" as const,
        text: "tasks 无效。需要原始 JSON 数组（如 [{to: \"name\", content: \"...\"}]），"
          + `但收到了 ${receivedType} 类型的值：${receivedPreview}${parseHint}。${recoveryBlock}\n\n`
          + "💡 提示：content 很长或包含换行时，二次序列化成字符串容易出错（超长输出还可能被截断导致 JSON 未闭合）。"
          + "请直接传原始数组，或拆分为多次调用。\n"
          + "正确：\"tasks\": [{ \"to\": \"planner\", \"content\": \"...\" }]\n"
          + "错误：\"tasks\": \"[{...}]\"  ← 不要额外序列化成字符串"
          + truncationHint,
      }],
    };
  }

  // Validate: at least one member is started
  if (memberOpsStates.size === 0) {
    return {
      details: {},
      content: [{
        type: "text" as const,
        text: "还没有启动任何团队成员。请先使用 start_member 启动成员后再发送任务。",
      }],
    };
  }

  // Validate: all target members exist in memberOpsStates
  const unknownTargets = tasks.filter(t => !memberOpsStates.has(t.to));
  if (unknownTargets.length > 0) {
    const names = unknownTargets.map(t => `"${t.to}"`).join(", ");
    const validNames = Array.from(memberOpsStates.keys());
    // 截半形态（P1，γ 实测：`{"content":"abc","to":"c"}` 过校验进 execute）：
    // to 是某个有效成员名的严格前缀且更短 → 高度疑似 to 被截断（长 content
    // 把 to 挤出输出预算），提示重发完整成员名而不是让 TL 怀疑自己传错。
    const truncationSuspects = unknownTargets.filter(
      (t) => validNames.some((n) => n.startsWith(t.to) && n.length > t.to.length)
    );
    const truncationHint = truncationSuspects.length > 0
      ? `\n\n⚠️ ${truncationSuspects.map((t) => `"${t.to}"`).join(", ")} 的 to 值可能被截断（内容不完整），请重发完整成员名。`
      : "";
    return {
      details: {},
      content: [{
        type: "text" as const,
        text: `目标成员 ${names} 不存在或未启动。请先使用 start_member 启动这些成员。\n有效成员：${validNames.join(", ")}。${truncationHint}`,
      }],
    };
  }

  // ── Batch alignment barrier (phase 3) ──
  // Runs BEFORE corrId registration and enqueue (invariant E1). Only for
  // batches (tasks.length > 1); to:"all" entries are excluded from the
  // barrier (E13); single tasks / disabled auto-compaction take the legacy
  // path unchanged (E9). The barrier returns the set of members that got a
  // compaction attempt — the commit phase marks exactly those messages.
  const explicitTargets = tasks
    .filter((t) => t.to !== "all")
    .map((t) => t.to);
  const attempted =
    tasks.length > 1 &&
    explicitTargets.length > 0 &&
    ctx.autoCompact &&
    ctx.getAutoCompact &&
    ctx.getHandle
      ? await runBatchCompactionBarrier([...new Set(explicitTargets)], ctx)
      : new Set<string>();

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
      // Phase 3 skip rule: the marker is added ONLY to members that actually
      // received a compaction attempt in this barrier (success or failure —
      // at most one per dispatch). Members skipped by the maxWait budget or
      // not over threshold carry NO marker, so the inline path naturally
      // gets its second chance.
      ...(attempted.has(task.to) ? { skipAutoCompact: true } : {}),
    };
    messageQueue.enqueue(messagePayload as TeamMessage);
  }

  return waitWithAllIdleCheck(pendingTasks, params.nextSteps, ctx, recoveryNote);
}
