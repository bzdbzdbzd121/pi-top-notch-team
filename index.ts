import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTeamCommand } from "./src/commands/team";
import { TeamModeEditor } from "./src/ui/team-mode-editor";
import { getSessionState, endSession } from "./src/session/state";
import {
  setManifestRuntimeContext,
  syncActiveManifest,
  resetManifestRuntimeContext,
} from "./src/session/manifest";
import type { TeamContext } from "./src/session/context";
import { getRootDir } from "./src/config";
import { loadSettings } from "./src/settings/settings";
import { resolveAutoCompact } from "./src/settings/resolve-auto-compact";
import { registerTlTools, type TlToolsDeps } from "./src/tools/tl-tools";
import { registerGoalTools, registerGoalAgentHandler, resetGoal, GOAL_TOOL_NAMES } from "./src/tools/goal-tools";
import { registerSharedContextTool, SHARED_CONTEXT_TOOL_NAME } from "./src/tools/shared-context-tool";
import { ensureToolRegistered } from "./src/commands/shared/ensure-tool";
import { createProcessManager } from "./src/process/manager";
import type { MemberProcessHandle } from "./src/process/member-process";
import { createTeamStatusWidget } from "./src/ui/team-status-widget";
import { createEditModeWidget } from "./src/ui/edit-mode-widget";
import { createCreateModeWidget } from "./src/ui/create-mode-widget";
import {
  createAndRegisterMember,
  buildMemberConfig,
  getMemberLog,
} from "./src/setup/member-lifecycle";
import { createMessageChannel } from "./src/setup/message-channel";
import { buildDynamicModePrompt } from "./src/prompts/dynamic-mode";
import { FIRST_ACTION_PROTOCOL_PROMPT } from "./src/prompts/tl-first-action";
import { buildWorkflowPrompt, WORKFLOW_ACTIVATION_BANNER } from "./src/prompts/workflow-prompt";
import { createTlReadGuard, createDesignReadGuard } from "./src/session/tl-read-guard";
import { enforceSessionToolVisibility, SESSION_TOOL_NAMES } from "./src/session/session-tool-visibility";
import { getSharedContextPath } from "./src/session/shared-context";
import { openMemberInspector, type MemberInspectorHandle } from "./src/ui/member-inspector";
import {
  registerStartTeamSessionTool,
  registerStopTeamSessionTool,
} from "./src/tools/agent-session-tools";
import {
  START_TEAM_SESSION_TOOL_NAME,
  STOP_TEAM_SESSION_TOOL_NAME,
} from "./src/tools/agent-session-tool-names";
import { buildAgentInitiatedPrompt } from "./src/prompts/agent-initiated-mode";
import {
  createActivityTracker,
  type ActivityTracker,
} from "./src/channel/activity-tracker";

/**
 * Team-tool names that leave durable traces in the conversation history when
 * the TL orchestrates a team session. Used to decide whether the one-shot
 * "session ended" banner is relevant for the CURRENT conversation (see
 * before_agent_start).
 */
const TEAM_TRACE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SESSION_TOOL_NAMES,
  "add_dynamic_member",
  START_TEAM_SESSION_TOOL_NAME,
  STOP_TEAM_SESSION_TOOL_NAME,
]);

/**
 * Whether the current conversation history contains team-session traces.
 *
 * Signals (any one suffices):
 * 1. An assistant message with a toolCall named after a team tool
 *    (start_member, team_send_and_wait, …) — the TL actively orchestrated.
 * 2. A custom_message entry with customType "team-message" — member replies
 *    routed to the TL via the message channel.
 *
 * Fail-open: when the session manager is unavailable (RPC mode, tests) the
 * check cannot be performed — treat as traced so the primary /team stop
 * → next-turn case keeps working. A fresh /new conversation has neither
 * signal, so the banner is correctly skipped there; /fork and /resume of a
 * team conversation copy/restore the entries, so the banner fires there too.
 */
function historyHasTeamTraces(ctx: {
  sessionManager?: { getEntries?: () => unknown[] } | null;
} | null | undefined): boolean {
  const entries = ctx?.sessionManager?.getEntries?.() ?? null;
  if (!entries) return true; // no session manager → fail open (inject)
  return entries.some((e: any) => {
    if (!e) return false;
    if (e.type === "custom_message") {
      return e.customType === "team-message";
    }
    if (e.type !== "message" || e.message?.role !== "assistant") return false;
    return Array.isArray(e.message.content) && e.message.content.some(
      (c: any) => c?.type === "toolCall" && typeof c?.name === "string" && TEAM_TRACE_TOOL_NAMES.has(c.name)
    );
  });
}

export default function (pi: ExtensionAPI) {
  // If running as a member process (TEAM_ROLE is set), skip TL-only tools
  // to avoid tool name conflicts with member.ts.
  if (process.env.TEAM_ROLE) {
    return;
  }

  // ── Team mode editor (border color change) ────────────────
  let teamModeEditorInstance: TeamModeEditor | null = null;
  let sessionUiRef: any = null;

  // ── Shared mutable state ──────────────────────────────────
  const memberHandles = new Map<string, MemberProcessHandle>();
  const memberHandlesRO: ReadonlyMap<string, MemberProcessHandle> = memberHandles;

  const teamCtx: TeamContext = {
    isCreatingTeam: false,
    editingTeamName: null,
    isDynamicSession: false,
    dynamicPhase: "design",
    agentInitiatedTask: null,
    resumedFrom: null,
    sessionEndedNotice: false,
    processManager: null,
    memberHandles: memberHandlesRO,
    getHandle: (name) => memberHandles.get(name),
    setHandle: (name, handle) => { memberHandles.set(name, handle); },
    clearHandles: () => { memberHandles.clear(); },
    tlToolNames: [...SESSION_TOOL_NAMES],

    router: null,
    messageQueue: null,
    responseWaiter: null,
    memberOperationalStates: null,
  };

  // ── Manager (includes unified operational state) ────────────
  const manager = createProcessManager([], {
    autoRestart: false,
    onCrashLoopDetected: (name, restarts) => {
      pi.sendMessage({
          customType: "team-message",
          content: `Member "${name}" 已连续崩溃 ${restarts} 次，已停止自动重启。`,
          display: true,
        });
    },
  });
  teamCtx.processManager = manager;

  // Get the unified operational state map from the manager
  const memberOpsStates = manager.getOperationalStateMap();

  // Track the most recent correlation ID sent to each member via team_send_and_wait.
  // Used to auto-inject correlation ID when a member replies without the <corr:...> tag.
  const lastPendingCorrId = new Map<string, string>();
  // Track recently processed tool_execution_end message fingerprints for de-duplication
  const recentlyProcessedMessages = new Map<string, number>();

  // Auto-reply tracking: last assistant text per member (populated at message_end)
  const lastAssistantTexts = new Map<string, string>();
  // Auto-reply tracking: members that replied via team_send_message in current turn
  const perTurnReplied = new Set<string>();
  // Auto-reply tracking: pending setTimeout refs for scheduled auto-replies
  const pendingAutoReplies = new Map<string, NodeJS.Timeout>();

  // ── Fine-grained activity display layer (phase 1/2) ─────────
  // Per-member activity tracker feeding the team-status widget's live phases
  // (thinking / tool-calling / executing / output). Lifecycle follows the
  // widget: created at session start, cleared at session end (decision #7 —
  // no leaks). The onMemberActivity multi-cast below feeds it per event.
  let activityTracker: ActivityTracker | null = null;

  // ── Member Inspector (成员检视浮窗) ───────────────────────
  // Handle for the currently-open inspector overlay; null when closed.
  let inspectorHandle: MemberInspectorHandle | null = null;

  // ── Team mode editor factory ──
  // Extracted so onSessionStart can RE-register it: onSessionEnd calls
  // setEditorComponent(undefined) which makes pi swap back to the default
  // editor, leaving teamModeEditorInstance as a dangling reference — without
  // re-registration, /team resume (or /team start after /team stop in the
  // same process) would leave the border uncolored.
  const registerTeamEditor = (ui: any) => {
    ui.setEditorComponent((tui: any, theme: any, kb: any) => {
      teamModeEditorInstance = new TeamModeEditor(tui, theme, kb, ui.theme);
      if (getSessionState().active) {
        teamModeEditorInstance.setTeamMode(true);
      }
      return teamModeEditorInstance;
    });
  };

  pi.registerShortcut("alt+t", {
    description: "Member Inspector（成员检视浮窗）",
    handler: async (ctx) => {
      // Only during an active team session (decision #7: no reaction otherwise)
      if (!getSessionState().active) return;
      if (inspectorHandle?.isOpen()) return;
      inspectorHandle = openMemberInspector(ctx, {
        getMembers: () => getSessionState().teamDefinition?.members ?? [],
        getHandle: (name: string) => teamCtx.getHandle(name),
        memberOpsStates,
      });
    },
  });

  // waitWithAllIdleCheck is defined in src/tools/tl-tools.ts

  // Capture ctx.ui.notify for UI-only routing notifications
  let uiNotify: ((msg: string, type?: "info" | "warning" | "error") => void) | null = null;

  // ── Message channel: queue → router (extracted to src/setup/message-channel.ts) ──
  const { router, messageQueue, responseWaiter, autoCompact } = createMessageChannel({
    pi,
    memberOpsStates,
    lastPendingCorrId,
    memberHandles,
    onRouteNotification: (target: string) => {
      uiNotify?.(`[消息已路由给 ${target}]`, "info");
    },
    // Resolve per dispatch so /team setting changes take effect immediately.
    getAutoCompact: () => resolveAutoCompact(loadSettings(getRootDir())),
  });

  teamCtx.router = router;
  teamCtx.messageQueue = messageQueue;
  teamCtx.responseWaiter = responseWaiter;
  teamCtx.memberOperationalStates = memberOpsStates;

  // (delegated to src/setup/member-lifecycle.ts via registerTlTools below)

  const memberLifecycleDeps = {
    pi,
    memberOpsStates,
    messageQueue,
    responseWaiter,
    lastPendingCorrId,
    recentlyProcessedMessages,
    processManager: manager,
    lastAssistantTexts,
    perTurnReplied,
    pendingAutoReplies,
    // Phase 1 wiring: the event handler now consumes compaction_end events
    // (shared runtime) and queries get_state after prompt rejections (handle
    // map) — both fix the compaction-timeout permanent-working black hole.
    memberHandles,
    autoCompact,
    onMemberActivity: (memberName: string, event: any) => {
      // Multi-cast to all activity consumers with PER-CONSUMER isolation (N4):
      // a throwing observer must never break the other observers — and the
      // event-handler call site also guards the state machine updates that
      // follow (belt and suspenders). Order matters: tracker first, then the
      // widget signature (which reads tracker state), P3 delete in between.
      try {
        inspectorHandle?.onMemberEvent(memberName, event);
      } catch {
        /* isolate */
      }
      try {
        activityTracker?.onEvent(memberName, event);
      } catch {
        /* isolate */
      }
      // P3: process death clears the member's display state — an executing
      // member that crashes would otherwise display ⚙️ forever (executing is
      // staleness-exempt). Auto-restart re-creates the entry on the next
      // agent_start.
      if (event?.type === "process_exit" || event?.type === "process_error") {
        try {
          activityTracker?.delete(memberName);
        } catch {
          /* isolate */
        }
      }
      try {
        teamStatusWidget?.onMemberEvent(memberName, event);
      } catch {
        /* isolate */
      }
    },
  };

  // ── TL current model tracking (for /team setting "follow" mode) ──────
  // Updated on session_start and model_select so buildMemberConfig can pass
  // the TL's current model to members spawned in "follow" mode.
  let tlCurrentModel: string | undefined;

  // The goal lifecycle handlers are registered below, after the shared
  // agent_settled status handler. In a fresh process the session tools are NOT
  // registered here — they are registered on-demand at session start via
  // ensureSessionToolsRegistered() (see below). pi has no unregister API, so
  // after that first registration they remain in the registry; outside a
  // session, activeTools hides them from the model.

  // start_team_session is the SINGLE deliberate exception to session-scoped
  // registration (ADR-0003): it must be visible at all times so the agent can
  // autonomously enter a team session. stop_team_session stays session-scoped
  // (registered via ensureSessionToolsRegistered, activated only in
  // agent-initiated sessions — see session-tool-visibility.ts).
  registerStartTeamSessionTool({ pi, teamCtx });

  // TL tools (start_member … wait_and_get_member_status) are registered only
  // when a session starts. The deps are captured here (module scope) and passed
  // to registerTlTools at that time — all are closures over module-level state,
  // so late registration is safe.
  const tlToolsDeps: TlToolsDeps = {
    pi,
    manager,
    responseWaiter,
    memberOpsStates,
    lastPendingCorrId,
    messageQueue,
    createMember: (config) => {
      const handle = createAndRegisterMember(pi, config, memberLifecycleDeps);
      teamCtx.setHandle(config.name, handle);
      return handle;
    },
    buildMemberConfig: (memberName) => buildMemberConfig(memberName, getSessionState(), { tlCurrentModel }),
    getMemberLog: async (memberName, maxLines, maxContentLength) => {
      const handle = teamCtx.getHandle(memberName);
      if (!handle) {
        throw new Error(`Member "${memberName}" not found`);
      }
      return getMemberLog(handle, maxLines, maxContentLength);
    },
    // Dynamic mode phase transition: design → execution on first member start
    onDynamicPhaseTransition: () => {
      if (teamCtx.isDynamicSession && teamCtx.dynamicPhase === "design") {
        teamCtx.dynamicPhase = "execution";
        setManifestRuntimeContext({ dynamicPhase: "execution" });
        syncActiveManifest();
        pi.sendMessage({
          customType: "team-message",
          content: "[系统] 动态团队模式已进入执行阶段。TL 现在可以读取项目代码和分析文件。",
          display: true,
        });
      }
    },
    // Batch alignment barrier (phase 3) wiring: the shared auto-compaction
    // runtime + per-call config + handle resolution power the pre-check that
    // aligns batch prompts behind member compactions.
    autoCompact,
    getAutoCompact: () => resolveAutoCompact(loadSettings(getRootDir())),
    getSettings: () => loadSettings(getRootDir()),
    getHandle: (name: string) => teamCtx.getHandle(name),
  };

  // ── Session-only tools: register on-demand, never at extension load ──
  // All team-session tools (6 TL process tools + write_shared_context +
  // set_goal/finish_goal) are registered on-demand when a team session starts
  // (onSessionStart) and enforced at every turn boundary (before_agent_start).
  // After first registration they remain in pi's registry; outside a session
  // the active-tool set removes them, making them hidden and uncallable.
  const ensureSessionToolsRegistered = () => {
    // registerTlTools registers all six TL tools atomically — checking one name suffices.
    ensureToolRegistered(pi, "start_member", () => registerTlTools(tlToolsDeps));
    ensureToolRegistered(pi, SHARED_CONTEXT_TOOL_NAME, () => registerSharedContextTool(pi));
    for (const toolName of GOAL_TOOL_NAMES) {
      ensureToolRegistered(pi, toolName, () => registerGoalTools(pi));
    }
    // stop_team_session is registered at every session start (harmless) but
    // ACTIVATED only in agent-initiated sessions (session-tool-visibility).
    ensureToolRegistered(pi, STOP_TEAM_SESSION_TOOL_NAME, () =>
      registerStopTeamSessionTool({ pi, teamCtx })
    );
  };

  // ── Helper: safely extract path from tool input ─────────
  function extractPathFromInput(input: unknown): string | undefined {
    if (typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      return typeof obj.path === "string" ? obj.path : undefined;
    }
    return undefined;
  }

  // ── Tool whitelists for team sessions ───────────────────
  //
  // Instead of blacklisting specific tools (which always misses something),
  // we define a whitelist of tools that are safe during team sessions.
  // Any tool not on the whitelist is blocked.

  /** Tools allowed during design phase (dynamic mode only). */
  const DESIGN_PHASE_WHITELIST = new Set([
    // Team management
    "add_dynamic_member",
    "start_member", "stop_member", "list_members", "get_member_log",
    "wait_and_get_member_status", "team_send_and_wait",
    "set_goal", "finish_goal", SHARED_CONTEXT_TOOL_NAME,
    // Agent-initiated session lifecycle (ADR-0003): start → clean re-entry error; stop → abort delegation
    START_TEAM_SESSION_TOOL_NAME, STOP_TEAM_SESSION_TOOL_NAME,
    // read/write: read unrestricted, write restricted to .md files (checked separately)
    "read",
    "write",
  ]);

  /** Tools allowed during execution phase (normal session + dynamic execution). */
  const EXECUTION_PHASE_WHITELIST = new Set([
    // Team management
    "start_member", "stop_member", "list_members", "get_member_log",
    "wait_and_get_member_status", "team_send_and_wait",
    "set_goal", "finish_goal", "add_dynamic_member", SHARED_CONTEXT_TOOL_NAME,
    // Agent-initiated session lifecycle (ADR-0003)
    START_TEAM_SESSION_TOOL_NAME, STOP_TEAM_SESSION_TOOL_NAME,
    // Read-only exploration & monitoring
    "read", "bash",
    "web_search", "fetch_content", "get_search_content",
    // write/edit: restricted to .md files (checked separately)
    "write", "edit",
    // Context-mode read-only / indexing
    "ctx_search", "ctx_stats", "ctx_doctor", "ctx_insight",
    "ctx_index", "ctx_fetch_and_index",
    // True-sight knowledge base (read-only safe)
    "true_sight_search", "true_sight_get_facts", "true_sight_filter",
    "true_sight_related", "true_sight_graph_viz", "true_sight_report",
    "true_sight_coverage", "true_sight_validate", "true_sight_review",
    "true_sight_synthesize", "true_sight_ingest",
    "true_sight_diff_impact", "true_sight_verify_evidence",
  ]);

  // ── TL pre-dispatch guard: sticky block on non-management tools before dispatch ──
  // Counts all non-management tool calls (read, bash, web_search, etc.) — not just `read` —
  // because TL can bypass a read-only guard via bash grep/rg/cat or ctx_execute.
  // Once the threshold is exceeded before any dispatch, every subsequent non-management
  // call is blocked until team_send_and_wait happens (sticky). Counters reset at the
  // start of every user-message turn (agent_start). Fail-open: member processes never
  // reach this (TEAM_ROLE early return above).
  const tlReadGuard = createTlReadGuard();
  const designReadGuard = createDesignReadGuard();
  pi.on("agent_start", (_event, ctx) => {
    tlReadGuard.resetTurn();
    designReadGuard.resetTurn();
    // Clear any leftover guard status from the previous turn (UI may be absent in RPC mode).
    try {
      ctx?.ui?.setStatus?.("tl-pre-dispatch-guard", undefined);
      ctx?.ui?.setStatus?.("tl-design-read-guard", undefined);
    } catch { /* fail-open */ }
  });

  // ── Call-level guard: whitelist-based blocking during team session ───
  pi.on("tool_call", (event, ctx) => {
    const sessionForGuard = getSessionState();
    if (!sessionForGuard.active) return; // only block during active team session

    // ADR-0003: dispatch-policing guards (design read limiter, TL pre-dispatch
    // guard) apply ONLY to user-initiated sessions. In agent-initiated sessions
    // the team is the agent's own chosen means — reading/analyzing freely is
    // legitimate. Write guards (below) apply to both origins.
    const isAgentInitiated = sessionForGuard.origin === "agent";

    // ── Resolve current phase ──
    const isDesignPhase = teamCtx.isDynamicSession && teamCtx.dynamicPhase === "design";
    const whitelist = isDesignPhase ? DESIGN_PHASE_WHITELIST : EXECUTION_PHASE_WHITELIST;

    // Track dispatch for the pre-dispatch guard (team_send_and_wait is whitelisted in both phases)
    if (event.toolName === "team_send_and_wait") {
      tlReadGuard.recordDispatch();
      // Dispatch unlocks the guard — clear any visible warning status.
      try {
        ctx?.ui?.setStatus?.("tl-pre-dispatch-guard", undefined);
      } catch { /* fail-open */ }
    }

    // Quick pass: whitelisted tool?
    if (whitelist.has(event.toolName)) {
      // write/edit: additionally check file extension
      if (event.toolName === "write" || event.toolName === "edit") {
        const filePath = extractPathFromInput(event.input) ?? "";
        // The shared context must be written via the dedicated tool — the
        // start_member gate depends on write_shared_context having set the
        // session flag. Redirect direct write/edit attempts here.
        if (filePath.endsWith(".shared-context.md")) {
          return {
            block: true,
            reason:
              `共享上下文必须通过 \`write_shared_context\` 工具写入（该工具会记录写入状态，未写入前 start_member 会被拦截）。` +
              `请调用 write_shared_context 工具，而不是用 ${event.toolName} 直接写 .shared-context.md。`,
          };
        }
        if (!filePath.endsWith(".md")) {
          const phaseLabel = isDesignPhase ? "设计阶段" : "团队会话";
          return {
            block: true,
            reason: `${phaseLabel}期间不得使用 ${event.toolName} 写代码文件。请委派给 Member 执行。你可以编写 .md 文档（如 .shared-context.md、ADR 等）。`,
          };
        }
      }
      // ── Phase-specific runtime guards ──
      const filePath =
        event.toolName === "read" || event.toolName === "write" || event.toolName === "edit"
          ? extractPathFromInput(event.input)
          : undefined;
      if (isDesignPhase && !isAgentInitiated) {
        // Design-phase read limiter: read is ALLOWED (exploring the project
        // to design the team is legitimate), but every `threshold`-th
        // non-.md read is blocked ONCE as a soft reminder — the next read
        // call passes again if it is genuinely needed. Not sticky: there is
        // no Member to dispatch to in the design phase.
        // (Skipped for agent-initiated sessions — ADR-0003.)
        const verdict = designReadGuard.checkToolCall(event.toolName, filePath);
        if (verdict.block) {
          if (verdict.firstBlock) {
            try {
              ctx?.ui?.notify?.(
                `⚠️ 设计阶段已拦截第 ${designReadGuard.readCount} 次非文档 read — 若确需读取可再次调用 read（单次提醒，不持续拦截）`,
                "warning"
              );
              ctx?.ui?.setStatus?.(
                "tl-design-read-guard",
                "⚠️ 设计阶段 read 频率提醒 — 确需读取可再次调用 read"
              );
            } catch { /* fail-open */ }
          }
          return { block: true, reason: verdict.reason };
        }
      } else if (!isDesignPhase && !isAgentInitiated) {
        // ── Pre-dispatch guard: count non-management tool calls, block once ──
        // Applies to ALL whitelisted tools (read, bash, web_search, ctx_execute, etc.)
        // — not just `read` — because TL can bypass a read-only guard via bash grep/rg/cat.
        // Management tools (start_member, team_send_and_wait, write, edit, etc.) are
        // exempted inside checkToolCall.
        // (Skipped for agent-initiated sessions — ADR-0003.)
        const verdict = tlReadGuard.checkToolCall(event.toolName, filePath);
        if (verdict.block) {
          // First block: surface a user-visible notification + status bar warning so
          // the reminder cannot be missed (blocked calls otherwise only appear as
          // a tool error in the transcript).
          if (verdict.firstBlock) {
            try {
              ctx?.ui?.notify?.(
                `⚠️ 已拦截 TL 在未派发任务情况下的亲自分析（第 ${tlReadGuard.preDispatchCalls} 次工具调用）— 请通过 team_send_and_wait 派发任务给 Member`,
                "warning"
              );
              ctx?.ui?.setStatus?.("tl-pre-dispatch-guard", "⚠️ TL 未派发任务 — 亲自分析已被持续拦截，直到 team_send_and_wait");
            } catch { /* fail-open */ }
          }
          return { block: true, reason: verdict.reason };
        }
      }
      return; // allowed
    }

    // ── Block: tool not in whitelist ──
    const phaseLabel = isDesignPhase ? "动态团队模式设计阶段" : "团队会话期间";
    const detail = isDesignPhase
      ? `请专注于与用户讨论需求、设计团队方案。`
      : `请使用委派给 Member 的方式完成编码任务。允许的工具：${Array.from(whitelist).filter(t => t !== "write" && t !== "edit").join(", ")}。`;
    return {
      block: true,
      reason: `${phaseLabel}不得使用 ${event.toolName}。${detail}`,
    };
  });

  // ── agent_settled: detect Escape-interrupt during team session with running members ──
  // When the user presses Escape during a team session, pi cancels the TL's turn
  // but member processes keep running. This handler notifies the user.
  pi.on("agent_settled", async (_event, ctx) => {
    const session = getSessionState();
    if (!session.active) {
      // Session already ended (e.g. /team stop) — clear stale status
      ctx.ui.setStatus("team-members-running", undefined);
      return;
    }

    // Check if any member processes are still running
    const runningMembers = Array.from(memberOpsStates.entries())
      .filter(([, state]) => state === "working" || state === "idle");

    if (runningMembers.length > 0 && ctx.signal?.aborted) {
      // User interrupted via Escape — notify that members are still running
      ctx.ui.setStatus("team-members-running", `\u26a0\ufe0f ${runningMembers.length} \u4e2a\u6210\u5458\u4ecd\u5728\u8fd0\u884c \u2014 \u4f7f\u7528 /team stop \u7ed3\u675f\u4f1a\u8bdd`);
      ctx.ui.notify(`\u6309 Esc \u53d6\u6d88\u4e86 TL\uff0c\u4f46\u6210\u5458\u8fdb\u7a0b\u4ecd\u5728\u8fd0\u884c\u3002\u4f7f\u7528 /team stop \u7ed3\u675f\u56e2\u961f\u4f1a\u8bdd\u3002`, "warning");
    }

    // Show a subtle persistent status if members are running (even without abort)
    if (runningMembers.length > 0 && !ctx.signal?.aborted) {
      ctx.ui.setStatus("team-members-running", `\u56e2\u961f\u6210\u5458\u8fd0\u884c\u4e2d \u2014 \u4f7f\u7528 /team stop \u7ed3\u675f\u4f1a\u8bdd`);
    } else if (runningMembers.length === 0) {
      ctx.ui.setStatus("team-members-running", undefined);
    }
  });

  // ── session_shutdown: clean up team state on /new, /resume, /fork ──
  // The session DIRECTORY IS PRESERVED (member contexts stay resumable via
  // /team resume; manifest status stays "active" = interrupted). Member
  // processes are stopped best-effort so no orphan keeps appending to a
  // session file a later resume would reopen.
  pi.on("session_shutdown", () => {
    const _session = getSessionState();
    if (_session.active) {
      const isDynamic = teamCtx.isDynamicSession;

      teamCtx.processManager?.stopAll().catch(() => {});
      endSession();
      resetGoal();
      if (teamCtx.onSessionEnd) {
        teamCtx.onSessionEnd();
      }
      teamCtx.onEditEnd?.();
      teamCtx.onCreateEnd?.();

      // Deactivate team tools on session shutdown
      const _shutdownActive = pi.getActiveTools();
      const _shutdownToRemove = new Set([...teamCtx.tlToolNames, "add_dynamic_member", "create_team_definition", "update_team_definition", STOP_TEAM_SESSION_TOOL_NAME]);
      pi.setActiveTools(_shutdownActive.filter((t: string) => !_shutdownToRemove.has(t)));

      teamCtx.isDynamicSession = false;
      teamCtx.dynamicPhase = "design";
      teamCtx.agentInitiatedTask = null;
      teamCtx.resumedFrom = null;
      resetManifestRuntimeContext();
    }
  });

  // ── session_start: reset stale team state + register autocomplete/editor ──
  pi.on("session_start", (event, ctx) => {
    // Track TL current model for /team setting "follow" mode
    tlCurrentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

    // A brand-new conversation (/new) has no team history — a pending
    // session-ended notice would be pure noise there, so drop it. /fork and
    // /resume COPY/RESTORE the history (which may contain team traces where
    // the banner is helpful), so they leave the flag alone — the content
    // check at consumption time decides. (The flag is only ever set by
    // teardownTeamSession; startup sessions never have it.)
    if ((event as { reason?: string } | undefined)?.reason === "new") {
      teamCtx.sessionEndedNotice = false;
    }

    // Part 1: Clean up stale team state when fresh session detected
    // (session dir preserved — resumable via /team resume; members stopped
    // best-effort, manifest keeps "active" = interrupted status)
    if (ctx.sessionManager) {
      const entries = ctx.sessionManager.getEntries() ?? [];
      const isFresh = entries.length <= 1;
      if (isFresh && getSessionState().active) {
        teamCtx.processManager?.stopAll().catch(() => {});
        endSession();
        resetGoal();
        if (teamCtx.onSessionEnd) {
          teamCtx.onSessionEnd();
        }
        teamCtx.onEditEnd?.();
        teamCtx.onCreateEnd?.();

        // Deactivate team tools on stale session cleanup
        const _freshActive = pi.getActiveTools();
        const _freshToRemove = new Set([...teamCtx.tlToolNames, "add_dynamic_member", "create_team_definition", "update_team_definition", STOP_TEAM_SESSION_TOOL_NAME]);
        pi.setActiveTools(_freshActive.filter((t: string) => !_freshToRemove.has(t)));

        teamCtx.isDynamicSession = false;
        teamCtx.dynamicPhase = "design";
        teamCtx.agentInitiatedTask = null;
        teamCtx.resumedFrom = null;
        resetManifestRuntimeContext();
      }
    }

    // Part 2: Register autocomplete + editor component
    // Store UI ref for session end cleanup
    sessionUiRef = ctx.ui;
    // Capture ctx.ui.notify for UI-only route notifications
    uiNotify = ctx.ui.notify;

    // Note: addAutocompleteProvider intentionally NOT registered here.
    // Command argument completion (subcommands + team names) is handled by
    // getArgumentCompletions in team.ts → CombinedAutocompleteProvider in pi's TUI.
    // A separate addAutocompleteProvider wrapper would intercept the TUI's built-in
    // command autocomplete and could cause empty candidate lists.

    // Register team mode editor factory (border color change)
    registerTeamEditor(ctx.ui);
  });

  // ── model_select: keep TL current model up to date ──
  pi.on("model_select", (event) => {
    tlCurrentModel = `${event.model.provider}/${event.model.id}`;
  });

  // ── Register the /team command ────────────────────────────
  registerTeamCommand(pi, teamCtx, () =>
    (teamCtx.processManager?.listStatus().map((s) => ({
      name: s.name,
      status: s.status,
      pid: s.pid,
    })) ?? []),
    {
      // /team resume: spawn a member resuming its persisted pi session.
      startResumedMember: async (name: string) => {
        const config = buildMemberConfig(name, getSessionState(), { tlCurrentModel, resume: true });
        if (!config) {
          throw new Error(`无法为成员 "${name}" 构建配置`);
        }
        const handle = createAndRegisterMember(pi, config, memberLifecycleDeps);
        teamCtx.setHandle(name, handle);
        await handle.start();
        // Record the fresh pid into the manifest
        syncActiveManifest({ startedMember: { name, pid: handle.getState().pid } });
        return handle.getState().pid;
      },
    }
  );

  // ── Team status widget (team mode visual indicator) ─────
  let teamStatusWidget: ReturnType<typeof createTeamStatusWidget> | null = null;

  // Wire UI lifecycle hooks so commands/team.ts can install/uninstall immediately
  teamCtx.onSessionStart = (ui) => {
    // Register ALL session-only tools on-demand when a team session starts
    // (/team start or /team dynamic). Runs BEFORE the widget guard below —
    // registration must not depend on widget state (the widget may already be
    // installed on session resume). Outside a session, none of these tools
    // exist in the registry.
    ensureSessionToolsRegistered();

    // Persist/refresh the on-disk session manifest (the /team resume anchor).
    // Covers /team start, /team dynamic and /team resume — all funnel through
    // this hook after the session state has been (re)initialized.
    setManifestRuntimeContext({
      isDynamic: teamCtx.isDynamicSession,
      dynamicPhase: teamCtx.dynamicPhase,
      agentInitiatedTask: teamCtx.agentInitiatedTask,
    });
    syncActiveManifest({ status: "active" });

    // Re-register the editor factory BEFORE the widget guard below: after a
    // /team stop the factory was cleared (setEditorComponent(undefined)) and
    // teamModeEditorInstance is dangling — only a fresh factory instantiation
    // (with session now active) reliably restores the colored border.
    registerTeamEditor(ui);

    // If already installed, skip
    if (teamStatusWidget) return;
    const session = getSessionState();
    if (!session.teamDefinition) return;

    teamStatusWidget = createTeamStatusWidget({
      teamName: session.teamDefinition.name,
      getMembers: () => getSessionState().teamDefinition?.members ?? [],
      teamCtx,
      memberOpsStates,
      activityTracker: activityTracker ?? (activityTracker = createActivityTracker()),
      origin: session.origin,
    });
    teamStatusWidget.install(ui, ui.theme);

    // Hint: Member Inspector shortcut
    ui.setStatus("team-inspector-hint", "alt+t 打开成员检视浮窗");

    // Activate team mode editor border
    if (teamModeEditorInstance) {
      teamModeEditorInstance.setTeamMode(true);
      try { (ui as any).requestRender?.(); } catch {}
    }
  };
  teamCtx.onSessionEnd = () => {
    if (teamStatusWidget) {
      teamStatusWidget.uninstall();
      teamStatusWidget = null;
    }

    // Fine-grained activity layer lifecycle follows the widget (no leaks).
    if (activityTracker) {
      activityTracker.clear();
      activityTracker = null;
    }

    // Close the Member Inspector if open
    inspectorHandle?.close();
    inspectorHandle = null;

    // Clear the inspector shortcut hint
    sessionUiRef?.setStatus("team-inspector-hint", undefined);

    // Restore default editor border
    if (teamModeEditorInstance) {
      teamModeEditorInstance.setTeamMode(false);
    }
    if (sessionUiRef) {
      sessionUiRef.setEditorComponent(undefined);
    }
  };

  // ── Edit mode widget (visual indicator for /team edit) ───
  let editModeWidget: ReturnType<typeof createEditModeWidget> | null = null;

  teamCtx.onEditStart = (ui) => {
    if (editModeWidget) return; // already installed
    const editingName = teamCtx.editingTeamName;
    if (!editingName) return;
    editModeWidget = createEditModeWidget(editingName);
    editModeWidget.install(ui, ui.theme);
  };

  teamCtx.onEditEnd = () => {
    if (editModeWidget) {
      editModeWidget.uninstall();
      editModeWidget = null;
    }
  };

  // ── Create mode widget (visual indicator for /team create) ───
  let createModeWidget: ReturnType<typeof createCreateModeWidget> | null = null;

  teamCtx.onCreateStart = (ui) => {
    if (createModeWidget) return; // already installed
    createModeWidget = createCreateModeWidget();
    createModeWidget.install(ui, ui.theme);
  };

  teamCtx.onCreateEnd = () => {
    if (createModeWidget) {
      createModeWidget.uninstall();
      createModeWidget = null;
    }
  };

  // ── TL system prompt injection ───────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const session = getSessionState();

    // ── Session tool visibility enforcement ──
    // Invariant: all team-session tools (start_member … wait_and_get_member_status,
    // write_shared_context, set_goal/finish_goal) are visible ONLY during an
    // active team session (/team start or /team dynamic). They are registered
    // on-demand at session start and pi's active-tool set is the only visibility
    // gate; enforce it at every turn boundary so a stale active list (extension
    // reload, other extensions' setActiveTools, plan-mode toggles) can never
    // leak them outside a session. No-op when the set is already correct.
    enforceSessionToolVisibility({
      sessionActive: session.active,
      agentInitiated: session.active && session.origin === "agent",
      activeTools: pi.getActiveTools(),
      isRegistered: (name) =>
        (((pi as any).getAllTools?.() ?? []) as Array<{ name: string }>).some(
          (t) => t.name === name
        ),
      registerTools: ensureSessionToolsRegistered,
      setActiveTools: (names) => pi.setActiveTools(names),
    });

    // Safety net: if widget wasn't installed by /team start (e.g., session resume),
    // install it here. Also clean up if session ended without /team stop.
    if (session.active && session.teamDefinition && !teamStatusWidget) {
      teamStatusWidget = createTeamStatusWidget({
        teamName: session.teamDefinition.name,
        getMembers: () => getSessionState().teamDefinition?.members ?? [],
        teamCtx,
        memberOpsStates,
        activityTracker: activityTracker ?? (activityTracker = createActivityTracker()),
        origin: session.origin,
      });
      teamStatusWidget.install(_ctx.ui, _ctx.ui.theme);
      _ctx.ui.setStatus("team-inspector-hint", "alt+t 打开成员检视浮窗");
    }
    if (!session.active && teamStatusWidget) {
      teamStatusWidget.uninstall();
      teamStatusWidget = null;
      if (activityTracker) {
        activityTracker.clear();
        activityTracker = null;
      }
      _ctx.ui.setStatus("team-inspector-hint", undefined);
    }

    // Edit mode widget safety net
    if (teamCtx.editingTeamName && !editModeWidget && _ctx.ui) {
      editModeWidget = createEditModeWidget(teamCtx.editingTeamName);
      editModeWidget.install(_ctx.ui, _ctx.ui.theme);
    }
    if (!teamCtx.editingTeamName && editModeWidget) {
      editModeWidget.uninstall();
      editModeWidget = null;
    }

    // Create mode widget safety net
    if (teamCtx.isCreatingTeam && !createModeWidget && _ctx.ui) {
      createModeWidget = createCreateModeWidget();
      createModeWidget.install(_ctx.ui, _ctx.ui.theme);
    }
    if (!teamCtx.isCreatingTeam && createModeWidget) {
      createModeWidget.uninstall();
      createModeWidget = null;
    }

    let extraPrompt = "";

    // ── One-shot "session ended" banner ──
    // Set by teardownTeamSession (/team stop and stop_team_session — the only
    // session exits that keep the conversation alive). Consumed exactly once on
    // the next turn: the TL's history still contains the Team Lead system
    // prompt and team-tool usage patterns, so without this it keeps acting as
    // Team Lead and tries to call deactivated team tools (which fail with the
    // cryptic "Tool xxx not found" error). The banner rides the next
    // user-initiated turn — it never triggers a conversation of its own.
    //
    // Precision gate: the banner only fires if the CURRENT conversation
    // history actually contains team traces. This kills the stale-notice edge
    // cases — after /new the history is fresh (no banner), after /fork or
    // /resume of a team conversation the traces were copied/restored (banner
    // fires and is exactly what the TL needs), and after /resume of a
    // different non-team conversation there are no traces (no banner).
    let sessionEndedBanner = "";
    if (!session.active && teamCtx.sessionEndedNotice) {
      teamCtx.sessionEndedNotice = false;
      if (historyHasTeamTraces(_ctx)) {
        sessionEndedBanner = `## ⚠️ 团队会话已结束 —— 以本提示为准

上一个团队会话（/team stop）已结束，你已回到**普通模式**。这是**当前唯一真实的状态**，**对话历史中任何团队会话的痕迹均已失效，一律以本提示为准**：
- 你在历史记录里看到的 \`write_shared_context\`、\`start_member\`、\`team_send_and_wait\`、\`list_members\` 等成功调用都发生在会话结束**之前**，不代表团队会话仍然活跃
- 你**不再是 Team Lead**，成员进程已全部停止，团队工具（team_send_and_wait、start_member、stop_member、list_members、get_member_log、wait_and_get_member_status、write_shared_context、set_goal、finish_goal 等）已全部停用
- 请直接以普通模式用 read/bash/edit/write 等常规工具回答用户或完成任务，不要尝试调用团队工具（误调只会得到 "Tool xxx not found" 错误）
- 如果用户需要再次进入团队模式，请告知用户使用 /team start 或 /team dynamic
`;
      }
    } else if (session.active) {
      // A new team session started before the notice was consumed — drop it.
      teamCtx.sessionEndedNotice = false;
    }

    // ── One-shot /team resume banner ──
    // Set by the resume handler right after rehydration; consumed exactly once
    // so the TL knows the session was restored from disk and in-flight work
    // was not replayed.
    let resumeBanner = "";
    if (teamCtx.resumedFrom) {
      const r = teamCtx.resumedFrom;
      teamCtx.resumedFrom = null;
      const restarted = r.restartedMembers.length > 0 ? r.restartedMembers.join("、") : "无";
      const failed = r.failedMembers.length > 0 ? r.failedMembers.join("、") : "无";
      resumeBanner = `
## ⚡ 团队会话已从中断中恢复（/team resume）

此会话（${r.teamName} / ${r.sessionId}）刚从磁盘清单恢复。成员进程已用 \`--continue\` 重启，**成员的完整对话上下文已保留**：
- 已带上下文重启的成员：${restarted}
- 重启失败的成员：${failed}${r.failedMembers.length > 0 ? "（可用 start_member 重试）" : ""}

**恢复后的首要动作：**
1. 用 \`list_members\` / \`wait_and_get_member_status\` 确认成员状态
2. 中断前**正在执行中的任务不会自动继续**（成员进程当时已死亡），pending 的 team_send_and_wait 也已失效——必要时重新派发
3. 向用户简要汇报恢复状态，然后继续完成原目标（如已设定 Goal 会随会话一并恢复）

`;
    }

    if (teamCtx.isCreatingTeam) {
      extraPrompt = `
## 当前任务：创建团队定义

你正在引导用户创建一个新的团队。请通过自然语言对话收集信息。

### 自动推断规则
当用户描述角色时（如"一个worker负责编码"），自动推断：
- **label** = 用户描述中的中文角色名（如"编码员"）
- **name** = label 的英文/拼音标识符（如 \`worker\`），小写字母数字连字符
- **systemPrompt** = 根据用户描述的角色职责展开编写
- **model** = 按需指定，不填则用默认模型

**不要**追问 name 和 label——直接从用户的描述中推断。
除非你无法确定合适的标识符，才向用户确认。

### 收集清单
1. **团队名称和描述** — 由用户自由描述
2. **成员角色** — 用户说出每个角色的职责，你自动生成配置
3. **默认模型** — 按需指定（可选）
4. **默认工作流（可选）** — 成员收集完后，询问用户是否需要定义工作流

### 工作流配置（可选）
成员收集完后，询问用户是否需要定义工作流。如果有 workflow，TL 会按步骤拆解任务。

对话流程：
1. 问用户是否需要工作流
2. 需要则问 strictness（strict = 严格按顺序 / reference = 灵活参考）
3. 逐步骤收集：执行成员（从已定义的成员中选择）、步骤名称、描述、可选输入输出、可失败处理
4. 问是否需要循环段（例如「代码审查不通过时循环修改」）
5. 最后调用 \`create_team_definition\` 时 workflow 一并提交

如果用户说不需要工作流，跳过即可。不要强行推荐。

收集完后向用户展示汇总并确认，然后调用 \`create_team_definition\` 工具保存。
如果用户想取消操作，告诉用户输入 \`/team done\`（或 \`/team cancel\`）退出。
`;
    } else if (teamCtx.editingTeamName) {
      const editName = teamCtx.editingTeamName;
      extraPrompt = `
## 当前任务：修改团队定义

你正在协助用户修改团队 **${editName}**。请通过自然语言对话了解用户想做的修改。

可能的修改包括：
- 修改团队名称或描述
- 添加新成员（name/label/systemPrompt/model）
- 修改现有成员（名称、提示词、模型）
- 删除成员
- 修改默认模型
- 添加/修改/删除工作流
- 修改工作流 strictness
- 添加/修改/删除工作流步骤
- 添加/修改/删除循环段

**不要**追问 name 和 label——从用户的描述中推断。

### 关于 update_team_definition 的 merge 机制

调用 \`update_team_definition\` 时注意以下规则以减小 payload：
- **未变更的现有成员** — 只需传 \`{name: "成员名"}\`，不传 systemPrompt。systemPrompt/label/model 自动从磁盘已有配置填充
- **新增或修改的成员** — 传完整数据（name、systemPrompt 等）
- **要删除的成员** — 直接从 members 数组中排除
- **workflow** 和 **defaults** — 如果不变可以不传，自动保留原有值

这样你就不必在 tool call 中重复所有成员的长篇 systemPrompt，避免 payload 过大导致输出截断。

了解清楚所有修改后，向用户展示修改汇总并确认，然后调用 \`update_team_definition\` 工具保存最终定义。
如果用户想取消操作，告诉用户输入 \`/team done\`（或 \`/team cancel\`）退出。
`;
    } else if (teamCtx.isDynamicSession && session.teamDefinition) {
      extraPrompt = session.origin === "agent"
        ? buildAgentInitiatedPrompt(
            session.teamDefinition,
            teamCtx.dynamicPhase,
            session.sessionId,
            teamCtx.agentInitiatedTask ?? "（任务描述缺失——请回顾对话上下文确认使命）",
          )
        : buildDynamicModePrompt(session.teamDefinition, teamCtx.dynamicPhase, session.sessionId);
    } else if (session.active && session.teamDefinition) {
      const team = session.teamDefinition;
      const memberLines = team.members
        .map((m) => `  - ${m.name}（${m.label ?? m.name}）— ${m.systemPrompt.slice(0, 80)}`)
        .join("\n");

      // Workflow prompt injection (operational, not declarative — see workflow-prompt.ts)
      const workflowText = buildWorkflowPrompt(team.workflow);

      const sharedCtxPath = getSharedContextPath(team.name, session.sessionId);

      extraPrompt = `
## 当前任务：Team Lead

你现在是一个 **Team Lead**，负责领导团队完成任务。

${FIRST_ACTION_PROTOCOL_PROMPT}
${team.workflow ? WORKFLOW_ACTIVATION_BANNER : ""}
### 团队：${team.name}
${team.description}

### 团队成员
${memberLines}
${workflowText}
### ⚠️ 铁律：你绝不能自己做 Member 能做的事

你是 Team Lead（团队经理），不是执行者。你的核心工作是**分派任务和管理进度**，不是动手做事。

**具体行为规则：**
- 用户说"分析 XXX 的问题" → 立即拆解任务，派发给分析员/开发员等 Member。**不得自己读代码来分析**
- 用户说"修改/重构 XXX" → 派发给开发员。**不得自己 write/edit 代码文件**
- 用户说"审查/检视 XXX" → 派发给审查员
- **任何时候收到用户需求，你的第一反应必须是"这个任务该派给哪个 Member？"，而不是自己开始做**

**禁止的行为清单：**
  ❌ 自己运行 bash 命令分析代码
  ❌ 自己 read 代码文件然后下结论
  ❌ 自己 write/edit 代码文件（.ts/.js/.py/.json 等）
  ❌ 自己做本应由 Member 完成的任何具体工作

**你唯一能做的事情：**
  ✅ 与用户讨论需求、对齐目标
  ✅ 拆解任务、制定计划
  ✅ 使用 team_send_and_wait 向 Member 分派任务
  ✅ 监控进度、协调异常
  ✅ 向用户汇报结果
  ✅ 编写 .md 文档（共享上下文、ADR 等）

**自查规则：每次收到用户消息后，先问自己"这个任务能交给 Member 做吗？"**
- 能 → 立刻分派，不得自己动手。**即使是简单分析也交给 Member**
- 不能（如管理决策、用户沟通、进度汇报）→ 自己做

> 🧠 记住：如果你在 read 代码文件或写代码，那你就是在做 Member 的工作。停下来，把任务分派出去。

### 成员完成任务后不要主动停止其进程
Member 进程保持运行以便继续接收新任务。仅当成员进程异常时（崩溃、无响应），才使用 stop_member 终止后重新启动。

### 与用户讨论需求的方式

在拆解任务之前，**逐个方面**与用户深入讨论，每次只讨论一个话题，达成共识后再继续下一个。

**期间遵循以下原则：**

- **一次只问一个问题** — 等用户回复后再问下一个。不要一次性抛出多个问题让用户选择。
- **能用代码验证的，不要去问用户** — 为确认某个具体事实，允许读取 1-2 个文件后给出结论。但注意边界：一旦需要连续深入阅读代码才能回答，那就是任务级分析，必须分派给 Member，而不是自己继续。
- **挑战模糊语言** — 当用户用词不精确时，提出更精确的术语。例如用户说"优化性能"——追问"你指的是减少响应时间还是降低资源占用？"
- **用场景检验边界** — 提出具体的边界场景来检验需求。例如"如果 A 成员依赖 B 成员的结果，但 B 还没完成怎么办？"
- **对照实际代码** — 当用户描述现有行为时，检查代码是否一致。发现矛盾时指出来让用户确认。
- **术语和决策立即固化** — 讨论中确定的关键术语、决策、约定，立即用 \`write_shared_context\` 工具写入 shared-context.md（${sharedCtxPath}）的对应章节，不攒到后面。

.shared-context.md 应作为术语表和关键决策记录，不包含实现细节。当某个决策满足以下三个条件时，考虑创建 ADR 文档（在 docs/adr 目录下）：逆决策成本高、外人看会觉得意外、是经过真正权衡后选择的。

讨论达成共识后，拆解任务并委派给各 Member。**委派时明确要求：需要产出的报告、方案、设计文档直接写入文件，避免成员间通过消息传递大段内容。**

### 沟通风格
- 与用户交流时保持简洁精炼，剔除客套话、语气词、多余铺垫与模棱两可的表述
- 保留完整句式与语法，专业术语原样不变
- 只输出核心内容，全程保持精简风格

### 可用工具
你拥有 8 个团队管理工具：

1. **write_shared_context(content)** — 写入团队共享上下文到 \`${sharedCtxPath}\`。**启动任何成员前必须至少调用一次**（未写入时 start_member 会被系统拦截）。内容应包含：项目背景与目标、成员分工、工作流、协作规则、术语表与关键决策。后续更新共享上下文时再次调用，并通知成员重新阅读
2. **start_member(name)** — 启动一个 Member 进程
3. **team_send_and_wait({tasks: [{to, content}], nextSteps})** — 给 Member 发任务并等待回复。tasks 支持多个任务并发发送（如多个独立检视任务可同时发出）。等待所有任务完成或有成员空闲后返回。必须传入 nextSteps（下一步计划），wait结束后该信息会随结果返回。**batch vs sequential 决策规则见下方提示**
4. **list_members** — 查看各 Member 的运行状态
5. **wait_and_get_member_status()** — **优先使用**。等待所有成员空闲后查看操作状态（idle/working/crashed/stopped）。如有成员在工作则阻塞，和 team_send_and_wait 检测 all-idle 的方式相同
6. **get_member_log(name, lines?)** — 查看 Member 最近的详细对话记录，负担较重，仅当需要了解具体内容时才使用
7. **stop_member(name)** — 终止 Member 进程
8. **set_goal(text, criteria) / finish_goal()** — 设定/结束会话目标（见流程第 2 步）

> 提示：team_send_and_wait 的 tasks 参数支持传入多个任务同时发送给不同 Member（如 [{to:"a", content:"..."}, {to:"b", content:"..."}]），实现并发执行。发送的消息包含 <corr:...> 标签。其他成员回复时需在内容中包含此标签。消息通道中的 Team Lead 名称是 tl。
>
> ⚡ **Batch vs Sequential 决策规则：**
>   - **批量（Batch）**：当多个任务**相互独立**时放入同一个 tasks 数组，各 Member 同时工作。适用场景：同时派发不同文件的分析/审查任务。
>   - **逐个（Sequential）**：当任务 B 的指令**依赖**任务 A 的输出时，先发 A 等结果，再用结果构造 B 的任务。适用场景：分析员输出报告后，编码员才能开始重构。
>   - **混合策略**：先 batch A+B 做并行分析，拿到结果后再逐个派发 C（依赖 A+B 结果的任务）。这是最高效的模式。
>   - Batch 模式下单个成员失败，其他成员的结果仍然可用（返回 partial results）。

### 流程
1. 先与用户充分讨论需求，直到和用户对齐细节
2. **主动询问用户是否要设定目标**（\`set_goal\`）—— 如果用户同意，使用 \`set_goal\` 设定清晰的可验证完成条件；如果用户说不需要，跳过即可。目标会在 TL 的一次运行完全结算（不会再自动重试、自动压缩或处理排队续跑）且目标仍未完成时提醒继续；\`agent_end\` 只是中间结束点，不会触发提醒。
3. 拆解任务，制定计划
4. 调用 \`write_shared_context\` 编写 Shared Context（共享上下文），记录：团队成员、项目背景和目标、协作规则、术语表。**未调用前 start_member 会被系统拦截**
5. 用 start_member 启动各 Member
6. 将 Shared Context 随首次任务消息一起发送给各 Member。**在消息中明确告知 Member 任务完成后必须回复 TL，并指示 Member：输出报告/方案/设计文档时写入文件，不要在消息通道中塞入大量内容。**
7. 通过消息通道与 Member 交流，监控进展（可使用 team_send_and_wait 等待成员回复）
8. 根据需要更新 Shared Context，通知所有 Member 重新阅读
9. 任务完成后向用户汇报结果
10. 让用户决定是否 /team stop
`;
    }

    if (extraPrompt || resumeBanner || sessionEndedBanner) {
      return { systemPrompt: event.systemPrompt + sessionEndedBanner + resumeBanner + extraPrompt };
    }
  });

  // Register goal lifecycle handlers after the TL before_agent_start handler.
  // This preserves the existing prompt-injection callback as the primary
  // before_agent_start listener while still letting goal-tools correlate its
  // fire-and-forget marker from the same event.
  registerGoalAgentHandler(pi);
}
