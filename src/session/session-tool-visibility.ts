import { GOAL_TOOL_NAMES } from "../tools/goal-tools";
import { SHARED_CONTEXT_TOOL_NAME } from "../tools/shared-context-tool";
import {
  START_TEAM_SESSION_TOOL_NAME,
  STOP_TEAM_SESSION_TOOL_NAME,
} from "../tools/agent-session-tool-names";

/**
 * Session-only tool visibility enforcement.
 *
 * Invariant: team-session tools are visible to the TL ONLY while a team
 * session is active (`/team start` or `/team dynamic`):
 *
 *   start_member, stop_member, list_members, get_member_log,
 *   team_send_and_wait, wait_and_get_member_status,
 *   write_shared_context, set_goal, finish_goal
 *
 * Registration: a fresh pi process starts without these nine in its registry;
 * they are registered ON-DEMAND at the first session start (`onSessionStart`)
 * and never at extension load. pi has no unregisterTool API, so after that
 * first registration they stay in the registry forever; outside a session the
 * active-tool set (`pi.setActiveTools`) is therefore the ONLY visibility gate.
 *
 * Enforcement: this pure function is applied at every `before_agent_start`
 * turn boundary. Session active → ensure registered (idempotent) + active.
 * No session → remove from the active set (never register). A stale
 * active-tool list (extension reload, other extensions calling
 * setActiveTools, plan-mode tool toggles, future code paths) can thus never
 * leak the session tools outside a session.
 *
 * Invariant 2 (阶段③ L1 策略门控，D3 统一不变式): start_team_session — the
 * load-time-registration exception (decision #21's single exception) — is
 * POLICY-gated instead of session-gated. Its visibility ⇔ the
 * allowAgentInitiatedSessions setting (resolver: resolveAgentSessionAllowed),
 * INDEPENDENT of session state:
 *   - `startTeamSessionVisible === false` ⇒ NOT in activeTools at the end of
 *     either branch (removed on discovery, same path as leaked session tools;
 *     stale re-injected lists are re-removed at the next turn boundary).
 *   - otherwise (true/undefined, fail-open default) ⇒ in activeTools
 *     (re-added after a disabled→enabled round-trip, E8).
 * Its registration is a load-time fait accompli (F1): the gate NEVER calls
 * registerTools for it — a missing registration is a load-layer defect, and
 * silently re-registering would mask it (the name may still enter the active
 * list; pi's setActiveTools ignores unknown names).
 * E9 known window (recorded, no code needed): a process booted while the
 * setting is disabled briefly exposes the tool between load-time
 * registration/auto-activation and the first before_agent_start — actual
 * exposure is zero (no LLM call opportunity before the first turn, corrected
 * at the boundary) and the L2 execute gate (agent-session-tools.ts) makes it
 * structurally harmless.
 *
 * Mode-scoped tools (create_team_definition / update_team_definition /
 * add_dynamic_member) are NOT covered here — they already have their own
 * register-on-demand + deactivate-on-exit lifecycle.
 */
export const SESSION_TOOL_NAMES = [
  "start_member",
  "stop_member",
  "list_members",
  "get_member_log",
  "team_send_and_wait",
  "wait_and_get_member_status",
  SHARED_CONTEXT_TOOL_NAME,
  ...GOAL_TOOL_NAMES,
] as const;

/**
 * Tools registered at session start like SESSION_TOOL_NAMES but ACTIVATED
 * only in agent-initiated sessions (ADR-0003): user-initiated sessions keep
 * their lifecycle user-owned (/team stop), so stop_team_session must never
 * leak into their active tool set.
 */
export const AGENT_SESSION_TOOL_NAMES = [STOP_TEAM_SESSION_TOOL_NAME] as const;

export interface SessionToolVisibilityDeps {
  /** Whether a team session (predefined or dynamic) is currently active. */
  sessionActive: boolean;
  /** Whether the active session is agent-initiated (ADR-0003). Ignored when sessionActive is false. */
  agentInitiated: boolean;
  /** Current active tool names (pi.getActiveTools()). */
  activeTools: string[];
  /**
   * 阶段③ L1（D8 具体入参，非泛型）：start_team_session 的策略可见性。
   * 缺省/undefined/true = 可见（fail-open，现状）；false = 统一不可见（D3：
   * 与会话状态无关，两个分支结束时均从 activeTools 移除）。调用点经
   * getEffectiveSettings 合并层每回合实时求值（index.ts before_agent_start）。
   */
  startTeamSessionVisible?: boolean;
  /** Whether a tool name is already registered (pi.getAllTools()). */
  isRegistered(name: string): boolean;
  /**
   * Register ALL session-only tools (idempotent). Called only when at least
   * one of them is missing from the registry.
   */
  registerTools(): void;
  /** Apply a new active tool set (pi.setActiveTools()). */
  setActiveTools(names: string[]): void;
}

export interface SessionToolVisibilityResult {
  /** Whether the active tool set was modified. */
  changed: boolean;
  /** Active tool set after enforcement. */
  activeTools: string[];
}

export function enforceSessionToolVisibility(
  deps: SessionToolVisibilityDeps
): SessionToolVisibilityResult {
  const { sessionActive, agentInitiated, activeTools } = deps;
  const active = new Set(activeTools);
  // 阶段③ L1 策略门控（D3 统一不变式）：start_team_session 可见性 ⇔ 开关值，
  // 与会话状态无关。缺省 true（fail-open）。
  const startVisible = deps.startTeamSessionVisible !== false;

  if (sessionActive) {
    // Session active → session tools must be registered (idempotent) and
    // active. Agent-only tools (stop_team_session) join the required set only
    // for agent-initiated sessions; in user-initiated sessions they must NOT
    // be active (lifecycle stays user-owned).
    const required = agentInitiated
      ? [...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES]
      : [...SESSION_TOOL_NAMES];
    const forbidden = agentInitiated ? [] : [...AGENT_SESSION_TOOL_NAMES];
    // L1 策略门控：disabled ⇒ start_team_session 并入 forbidden（发现即移除，
    // 含活跃会话期间——E4 运行中会话不终止，stop 照常可见）；enabled ⇒ 并入
    // wanted（E8：disabled→enabled 往返后补回）。移除/补回只经 setActiveTools，
    // registerTools 永不为它触发（F1 加载时注册既成事实，见模块 docstring）。
    const policyForbidden = startVisible ? [] : [START_TEAM_SESSION_TOOL_NAME];
    const wanted = startVisible ? [...required, START_TEAM_SESSION_TOOL_NAME] : required;

    const missingActive = wanted.filter((n) => !active.has(n));
    const leakedActive = [...forbidden, ...policyForbidden].filter((n) => active.has(n));
    if (missingActive.length > 0 || leakedActive.length > 0) {
      if (required.some((n) => !deps.isRegistered(n))) {
        deps.registerTools();
      }
      const leakedSet: ReadonlySet<string> = new Set([...forbidden, ...policyForbidden]);
      const next = [
        ...new Set([
          ...activeTools.filter((n) => !leakedSet.has(n)),
          ...wanted,
        ]),
      ];
      deps.setActiveTools(next);
      return { changed: true, activeTools: next };
    }
    return { changed: false, activeTools };
  }

  // No session → session tools must never be active (they may remain
  // registered; pi has no unregisterTool API, but the active set is the only
  // visibility gate). start_team_session follows the policy (统一不变式):
  // removed when disabled (incl. stale re-injected lists — re-removed at the
  // next turn boundary), re-added when enabled (E8 round-trip). Never
  // registered either way (F1).
  const policyLeaked = startVisible ? [] : [START_TEAM_SESSION_TOOL_NAME];
  const policyWanted = startVisible ? [START_TEAM_SESSION_TOOL_NAME] : [];
  const leakedSet: ReadonlySet<string> = new Set([
    ...SESSION_TOOL_NAMES,
    ...AGENT_SESSION_TOOL_NAMES,
    ...policyLeaked,
  ]);
  const leaked = [...leakedSet].filter((n) => active.has(n));
  const missingPolicy = policyWanted.filter((n) => !active.has(n));
  if (leaked.length > 0 || missingPolicy.length > 0) {
    const next = [
      ...new Set([
        ...activeTools.filter((n) => !leakedSet.has(n)),
        ...policyWanted,
      ]),
    ];
    deps.setActiveTools(next);
    return { changed: true, activeTools: next };
  }
  return { changed: false, activeTools };
}
