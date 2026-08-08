import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../session/context";
import { getSessionState } from "../session/state";
import { bootstrapDynamicSession } from "../setup/dynamic-session-bootstrap";
import { teardownTeamSession } from "../session/teardown";
import { setGoalInternal } from "./goal-tools";
import { START_TEAM_SESSION_TOOL_NAME, STOP_TEAM_SESSION_TOOL_NAME } from "./agent-session-tool-names";

/**
 * Agent-initiated team session tools (ADR-0003).
 *
 * - `start_team_session` is registered AT EXTENSION LOAD — the single
 *   deliberate exception to decision #21 (session tools are otherwise
 *   registered only during sessions). It lets the agent autonomously enter a
 *   dynamic team session to delegate a complex task.
 * - `stop_team_session` is registered on-demand at session start (via
 *   ensureSessionToolsRegistered in index.ts) but ACTIVATED only in
 *   agent-initiated sessions — user-initiated sessions keep their lifecycle
 *   user-owned (/team stop).
 */

export interface AgentSessionToolsDeps {
  pi: ExtensionAPI;
  teamCtx: TeamContext;
}

type ToolResult = {
  details: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
};

function textResult(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { details, content: [{ type: "text" as const, text }] };
}

/** Registered once at extension load (see module docstring). */
export function registerStartTeamSessionTool(deps: AgentSessionToolsDeps): void {
  const { pi, teamCtx } = deps;

  pi.registerTool({
    name: START_TEAM_SESSION_TOOL_NAME,
    label: "Start Team Session",
    description:
      "Autonomously start a dynamic team session to delegate a complex task to a team of member agents that you design and coordinate. " +
      "You become the Team Lead: you register members (add_dynamic_member), write the shared context, launch member processes, " +
      "dispatch subtasks, monitor progress, and report the final result. The session runs fully autonomously — no user confirmation is required. " +
      "Parameters: task (mission statement describing what the team should accomplish, including verifiable acceptance criteria). " +
      "Use this when a task is large, decomposable into parallel or staged subtasks, or benefits from multiple specialized roles " +
      "(e.g. analysis + implementation + review). Do NOT use for small, single-step tasks you can complete directly — a team session spawns multiple agent processes and costs significantly more tokens.",
    promptGuidelines: [
      "Call start_team_session only after judging that the task genuinely warrants a team (multi-deliverable, parallelizable, or staged pipeline work).",
      "Write a clear, self-contained `task`: it becomes the session goal and the mission statement for team design. Include acceptance criteria.",
      "After the session starts you are in the design phase: read freely to ground your plan, then add_dynamic_member → write_shared_context → start_member.",
      "When the task is done: report the result to the user, call finish_goal, then stop_team_session (unless you anticipate immediate follow-up delegation — then say the team is still running).",
      "If a team session is already active, do NOT call start_team_session again — reuse the running session or stop it first.",
    ],
    promptSnippet: "Delegate complex multi-part tasks to an autonomously designed agent team",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Mission statement for the team session: what to accomplish and verifiable acceptance criteria. " +
            "Becomes the session goal (the system will remind you to keep working until it is met) and anchors team design.",
        },
      },
      required: ["task"],
    },
    async execute(_toolCallId: string, params: { task: string }, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) {
        return textResult("start_team_session 需要非空的 task 参数（使命陈述 + 验收标准）。");
      }

      if (getSessionState().active) {
        return textResult(
          "当前已有活跃团队会话，无法再次启动。" +
          "如需委派新任务，直接在当前会话中调整团队（add_dynamic_member）并派发；" +
          "如确需重开，请先结束当前会话（自主会话用 stop_team_session，手动会话请用户 /team stop）。",
        );
      }

      const teamName = bootstrapDynamicSession(
        pi,
        teamCtx,
        ctx.ui as unknown as SessionUI,
        "agent",
      );
      teamCtx.agentInitiatedTask = task;
      setGoalInternal(
        task,
        `- 任务「${task}」的验收标准已全部满足\n- 执行结果已汇总并向用户汇报`,
      );

      try {
        ctx.ui?.notify?.(`🤖 Agent 已自主启动团队会话：${task.slice(0, 120)}${task.length > 120 ? "…" : ""}`, "info");
      } catch { /* UI may be absent (RPC mode) — fail-open */ }

      return textResult(
        `✅ 团队会话「${teamName}」已启动（agent 自主模式，当前为设计阶段）。任务目标已自动设定为会话 Goal。\n\n` +
        `接下来按顺序推进（全程自主，无需等待用户确认）：\n` +
        `1. **任务拆分与团队设计** — 围绕 task 拆交付物、画依赖图；可自由 read 代码/文档做侦察（此模式下无读取频率限制），但不得写代码文件\n` +
        `2. **add_dynamic_member** — 逐个注册成员（name 英文小写标识符，label 中文，systemPrompt 写清职责与输出规范）\n` +
        `3. **write_shared_context** — 写入项目背景、任务书（含验收标准）、成员分工、工作流、协作规则（未写入前 start_member 会被拦截）\n` +
        `4. **start_member** — 启动成员，自动进入执行阶段\n` +
        `5. **team_send_and_wait** — 派发子任务并等待结果，监控进度\n` +
        `6. **收尾** — 向用户汇报结果 → finish_goal → stop_team_session（若预判用户会追问，可保留团队并告知用户会话仍在运行）\n\n` +
        `若判断团队方案不可行，可随时调用 stop_team_session 放弃本次委派。`,
        { teamName, origin: "agent" },
      );
    },
  });
}

/**
 * Registered on-demand at session start (index.ts ensureSessionToolsRegistered).
 * Activated only in agent-initiated sessions (session-tool-visibility).
 */
export function registerStopTeamSessionTool(deps: AgentSessionToolsDeps): void {
  const { pi, teamCtx } = deps;

  pi.registerTool({
    name: STOP_TEAM_SESSION_TOOL_NAME,
    label: "Stop Team Session",
    description:
      "End the current agent-initiated team session: stop all member processes, deactivate session tools, remove the team widget, and clean up session data. " +
      "Only available in sessions started via start_team_session — user-initiated sessions (/team start, /team dynamic) are ended by the user with /team stop. " +
      "No parameters.",
    promptGuidelines: [
      "Call stop_team_session after reporting the final result to the user and calling finish_goal.",
      "You may keep the team running if you anticipate immediate follow-up delegation — tell the user the session is still active in that case.",
      "Also call it to abort the delegation if a viable team plan turns out to be impossible.",
    ],
    promptSnippet: "End an agent-initiated team session",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      const session = getSessionState();
      if (!session.active) {
        return textResult("当前无活跃团队会话。");
      }
      if (session.origin !== "agent") {
        return textResult(
          "stop_team_session 仅用于 agent 自主会话（start_team_session 启动）。" +
          "当前会话由用户启动，生命周期归用户所有——请用户输入 /team stop 结束。",
        );
      }

      const { teamName } = await teardownTeamSession(pi, teamCtx);
      return textResult(
        `✅ 团队会话「${teamName}」已结束：成员进程已全部停止，会话数据已清理。`,
        { teamName, stopped: true },
      );
    },
  });
}
