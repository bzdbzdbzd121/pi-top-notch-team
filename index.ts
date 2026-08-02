import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTeamCommand } from "./src/commands/team";
import { TeamModeEditor } from "./src/ui/team-mode-editor";
import { getSessionState, endSession } from "./src/session/state";
import type { TeamContext } from "./src/session/context";
import { getRootDir } from "./src/config";
import { loadSettings } from "./src/settings/settings";
import { resolveAutoCompact } from "./src/settings/resolve-auto-compact";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { registerTlTools } from "./src/tools/tl-tools";
import { registerGoalTools, registerGoalAgentHandler, resetGoal, GOAL_TOOL_NAMES } from "./src/tools/goal-tools";
import { registerSharedContextTool, SHARED_CONTEXT_TOOL_NAME } from "./src/tools/shared-context-tool";
import { ensureToolRegistered } from "./src/commands/shared/ensure-tool";
import { createProcessManager } from "./src/process/manager";
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
import { createTlReadGuard } from "./src/session/tl-read-guard";
import { getSharedContextPath } from "./src/session/shared-context";
import { openMemberInspector, type MemberInspectorHandle } from "./src/ui/member-inspector";

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
    processManager: null,
    memberHandles: memberHandlesRO,
    getHandle: (name) => memberHandles.get(name),
    setHandle: (name, handle) => { memberHandles.set(name, handle); },
    clearHandles: () => { memberHandles.clear(); },
    tlToolNames: ["start_member", "stop_member", "list_members", "get_member_log", "team_send_and_wait", "wait_and_get_member_status", "set_goal", "finish_goal", SHARED_CONTEXT_TOOL_NAME],

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

  // ── Member Inspector (成员检视浮窗) ───────────────────────
  // Handle for the currently-open inspector overlay; null when closed.
  let inspectorHandle: MemberInspectorHandle | null = null;
  // Whether the TL agent is processing a turn (agent_start..agent_settled).
  // Drives the inspector's unified notification batching: while busy, all
  // intervention reminders queue; when settled, they are delivered together.
  let tlBusy = false;

  pi.registerShortcut("alt+t", {
    description: "Member Inspector（成员检视浮窗）",
    handler: async (ctx) => {
      // Only during an active team session (decision #7: no reaction otherwise)
      if (!getSessionState().active) return;
      if (inspectorHandle?.isOpen()) return;
      inspectorHandle = openMemberInspector(ctx, {
        pi,
        getMembers: () => getSessionState().teamDefinition?.members ?? [],
        getHandle: (name: string) => teamCtx.getHandle(name),
        memberOpsStates,
        isTlBusy: () => tlBusy,
      });
    },
  });

  // waitWithAllIdleCheck is defined in src/tools/tl-tools.ts

  // Capture ctx.ui.notify for UI-only routing notifications
  let uiNotify: ((msg: string, type?: "info" | "warning" | "error") => void) | null = null;

  // ── Message channel: queue → router (extracted to src/setup/message-channel.ts) ──
  const { router, messageQueue, responseWaiter } = createMessageChannel({
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
    onMemberActivity: (memberName: string, _eventType: string) => {
      inspectorHandle?.markDirty(memberName);
    },
  };

  // ── TL current model tracking (for /team setting "follow" mode) ──────
  // Updated on session_start and model_select so buildMemberConfig can pass
  // the TL's current model to members spawned in "follow" mode.
  let tlCurrentModel: string | undefined;

  // Only register the agent_end reminder handler at module init (safe, guards itself).
  // Goal tools (set_goal/finish_goal) are registered on-demand when a session starts.
  registerGoalAgentHandler(pi);

  registerTlTools({
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
        pi.sendMessage({
          customType: "team-message",
          content: "[系统] 动态团队模式已进入执行阶段。TL 现在可以读取项目代码和分析文件。",
          display: true,
        });
      }
    },
  });

  // write_shared_context — dedicated shared-context write tool. Registered eagerly,
  // activated via teamCtx.tlToolNames (setActiveTools) during team sessions only.
  // start_member is gated on its write having happened (see start_member tool).
  registerSharedContextTool(pi);

  // team_send_and_wait and wait_and_get_member_status are registered in src/tools/tl-tools.ts

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
  pi.on("agent_start", (_event, ctx) => {
    tlBusy = true;
    tlReadGuard.resetTurn();
    // Clear any leftover guard status from the previous turn (UI may be absent in RPC mode).
    try {
      ctx?.ui?.setStatus?.("tl-pre-dispatch-guard", undefined);
    } catch { /* fail-open */ }
  });

  // ── Call-level guard: whitelist-based blocking during team session ───
  pi.on("tool_call", (event, ctx) => {
    if (!getSessionState().active) return; // only block during active team session

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
      // ── Pre-dispatch guard: count non-management tool calls, block once ──
      // Applies to ALL whitelisted tools (read, bash, web_search, ctx_execute, etc.)
      // — not just `read` — because TL can bypass a read-only guard via bash grep/rg/cat.
      // Management tools (start_member, team_send_and_wait, write, edit, etc.) are
      // exempted inside checkToolCall.
      // Execution phase only — design phase has no Members to dispatch to.
      if (!isDesignPhase) {
        const filePath =
          event.toolName === "read" || event.toolName === "write" || event.toolName === "edit"
            ? extractPathFromInput(event.input)
            : undefined;
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
    // TL turn finished: inspector delivers any notifications queued while busy.
    tlBusy = false;
    inspectorHandle?.onTlSettled();

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
  pi.on("session_shutdown", () => {
    const _session = getSessionState();
    if (_session.active) {
      const teamName = _session.teamDefinition?.name;
      const sessionId = _session.sessionId;
      const isDynamic = teamCtx.isDynamicSession;

      // Reset the inspector's TL-busy flag so a fresh session does not
      // inherit stale batching state (queued-while-busy would otherwise
      // never trigger until the first agent_settled).
      tlBusy = false;

      endSession();
      resetGoal();
      if (teamCtx.onSessionEnd) {
        teamCtx.onSessionEnd();
      }
      teamCtx.onEditEnd?.();
      teamCtx.onCreateEnd?.();

      // Deactivate team tools on session shutdown
      const _shutdownActive = pi.getActiveTools();
      const _shutdownToRemove = new Set([...teamCtx.tlToolNames, "add_dynamic_member", "create_team_definition", "update_team_definition"]);
      pi.setActiveTools(_shutdownActive.filter((t: string) => !_shutdownToRemove.has(t)));

      // Best-effort cleanup of session directory
      if (isDynamic && teamName) {
        try { rmSync(join(getRootDir(), "sessions", teamName), { recursive: true, force: true }); } catch (e) { console.warn('[top-notch-team] Failed to clean up dynamic session dir:', e); }
      } else if (teamName && sessionId) {
        try { rmSync(join(getRootDir(), "sessions", teamName, sessionId), { recursive: true, force: true }); } catch (e) { console.warn('[top-notch-team] Failed to clean up session dir:', e); }
      }
      teamCtx.isDynamicSession = false;
      teamCtx.dynamicPhase = "design";
    }
  });

  // ── session_start: reset stale team state + register autocomplete/editor ──
  pi.on("session_start", (_event, ctx) => {
    // Track TL current model for /team setting "follow" mode
    tlCurrentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    // Part 1: Clean up stale team state when fresh session detected
    if (ctx.sessionManager) {
      const entries = ctx.sessionManager.getEntries() ?? [];
      const isFresh = entries.length <= 1;
      if (isFresh && getSessionState().active) {
        const _session = getSessionState();
        const teamName = _session.teamDefinition?.name;
        const sessionId = _session.sessionId;
        const isDynamic = teamCtx.isDynamicSession;

        endSession();
        resetGoal();
        if (teamCtx.onSessionEnd) {
          teamCtx.onSessionEnd();
        }
        teamCtx.onEditEnd?.();
        teamCtx.onCreateEnd?.();

        // Deactivate team tools on stale session cleanup
        const _freshActive = pi.getActiveTools();
        const _freshToRemove = new Set([...teamCtx.tlToolNames, "add_dynamic_member", "create_team_definition", "update_team_definition"]);
        pi.setActiveTools(_freshActive.filter((t: string) => !_freshToRemove.has(t)));

        if (isDynamic && teamName) {
          try { rmSync(join(getRootDir(), "sessions", teamName), { recursive: true, force: true }); } catch (e) { console.warn('[top-notch-team] Failed to clean up dynamic session dir:', e); }
        } else if (teamName && sessionId) {
          try { rmSync(join(getRootDir(), "sessions", teamName, sessionId), { recursive: true, force: true }); } catch (e) { console.warn('[top-notch-team] Failed to clean up session dir:', e); }
        }
        teamCtx.isDynamicSession = false;
        teamCtx.dynamicPhase = "design";
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
    ctx.ui.setEditorComponent((tui: any, theme: any, kb: any) => {
      teamModeEditorInstance = new TeamModeEditor(tui, theme, kb, ctx.ui.theme);
      if (getSessionState().active) {
        teamModeEditorInstance.setTeamMode(true);
      }
      return teamModeEditorInstance;
    });
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
    })) ?? [])
  );

  // ── Team status widget (team mode visual indicator) ─────
  let teamStatusWidget: ReturnType<typeof createTeamStatusWidget> | null = null;

  // Wire UI lifecycle hooks so commands/team.ts can install/uninstall immediately
  teamCtx.onSessionStart = (ui) => {
    // If already installed, skip
    if (teamStatusWidget) return;
    const session = getSessionState();
    if (!session.teamDefinition) return;

    // Register goal tools on-demand when a team session starts
    for (const toolName of GOAL_TOOL_NAMES) {
      ensureToolRegistered(pi, toolName, () => registerGoalTools(pi));
    }

    teamStatusWidget = createTeamStatusWidget({
      teamName: session.teamDefinition.name,
      getMembers: () => getSessionState().teamDefinition?.members ?? [],
      teamCtx,
      memberOpsStates,
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

    // Safety net: if widget wasn't installed by /team start (e.g., session resume),
    // install it here. Also clean up if session ended without /team stop.
    if (session.active && session.teamDefinition && !teamStatusWidget) {
      teamStatusWidget = createTeamStatusWidget({
        teamName: session.teamDefinition.name,
        getMembers: () => getSessionState().teamDefinition?.members ?? [],
        teamCtx,
        memberOpsStates,
      });
      teamStatusWidget.install(_ctx.ui, _ctx.ui.theme);
      _ctx.ui.setStatus("team-inspector-hint", "alt+t 打开成员检视浮窗");
    }
    if (!session.active && teamStatusWidget) {
      teamStatusWidget.uninstall();
      teamStatusWidget = null;
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
      extraPrompt = buildDynamicModePrompt(session.teamDefinition, teamCtx.dynamicPhase, session.sessionId);
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
2. **主动询问用户是否要设定目标**（\`set_goal\`）—— 如果用户同意，使用 \`set_goal\` 设定清晰的可验证完成条件；如果用户说不需要，跳过即可。目标可以让系统在任务中途自动提醒你继续执行，避免不必要的中断。
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

    if (extraPrompt) {
      return { systemPrompt: event.systemPrompt + extraPrompt };
    }
  });
}
