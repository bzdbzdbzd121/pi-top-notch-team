import { describe, it, expect, vi } from "vitest";
import {
  enforceSessionToolVisibility,
  SESSION_TOOL_NAMES,
  AGENT_SESSION_TOOL_NAMES,
  type SessionToolVisibilityDeps,
} from "./session-tool-visibility";

// ── Test helpers ───────────────────────────────────────────

function makeDeps(overrides: Partial<SessionToolVisibilityDeps> = {}) {
  const registered = new Set<string>();
  const registerTools = vi.fn(() => {
    for (const name of [...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES]) registered.add(name);
  });
  const setActiveTools = vi.fn();
  const deps: SessionToolVisibilityDeps = {
    sessionActive: false,
    agentInitiated: false,
    activeTools: ["read", "bash"],
    isRegistered: (name) => registered.has(name),
    registerTools,
    setActiveTools,
    ...overrides,
  };
  return { deps, registerTools, setActiveTools, registered };
}

const MODE_TOOLS = ["add_dynamic_member", "create_team_definition", "update_team_definition"];

describe("SESSION_TOOL_NAMES", () => {
  it("contains exactly the 9 team-session tools", () => {
    expect(SESSION_TOOL_NAMES).toEqual([
      "start_member",
      "stop_member",
      "list_members",
      "get_member_log",
      "team_send_and_wait",
      "wait_and_get_member_status",
      "write_shared_context",
      "set_goal",
      "finish_goal",
    ]);
  });
});

describe("enforceSessionToolVisibility", () => {
  describe("outside a team session", () => {
    it("no-op when the active set is already correct (fresh process: load-time-registered start_team_session auto-active, session tools absent)", () => {
      const { deps, setActiveTools, registerTools } = makeDeps({
        sessionActive: false,
        // 阶段③ L1：生产 fresh process 的现实形态——start_team_session 加载时注册
        // 并自动激活（E9），session tools 从未注册、不在活跃集；策略 enabled（缺省）
        // ⇒ 已正确，幂等 no-op。
        activeTools: ["read", "bash", START_TEAM_SESSION_TOOL_NAME],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(result.activeTools).toEqual(["read", "bash", START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).not.toHaveBeenCalled();
      expect(registerTools).not.toHaveBeenCalled();
    });

    it("removes ALL leaked session tools from the active set (post-session cleanup; start_team_session preserved)", () => {
      const leaked = ["read", "bash", ...SESSION_TOOL_NAMES, "ctx_search", START_TEAM_SESSION_TOOL_NAME];
      const { deps, setActiveTools, registerTools } = makeDeps({
        sessionActive: false,
        activeTools: leaked,
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      // Only session tools removed; everything else preserved (start_team_session
      // 按 L1 统一不变式恒可见——enabled 缺省态不清除)
      expect(result.activeTools).toEqual(["read", "bash", "ctx_search", START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "ctx_search", START_TEAM_SESSION_TOOL_NAME]);
      // Never register outside a session
      expect(registerTools).not.toHaveBeenCalled();
    });

    it("removes a partially leaked active list (only some session tools active; start_team_session preserved)", () => {
      const { deps, setActiveTools } = makeDeps({
        sessionActive: false,
        activeTools: ["read", "set_goal", "start_member", "finish_goal", "bash", START_TEAM_SESSION_TOOL_NAME],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read", "bash", START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", START_TEAM_SESSION_TOOL_NAME]);
    });

    it("does NOT touch mode-scoped tools (add_dynamic_member / create / update; start_team_session preserved)", () => {
      const { deps, setActiveTools } = makeDeps({
        sessionActive: false,
        activeTools: ["read", ...MODE_TOOLS, START_TEAM_SESSION_TOOL_NAME],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(result.activeTools).toEqual(["read", ...MODE_TOOLS, START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).not.toHaveBeenCalled();
    });
  });

  describe("inside a team session", () => {
    it("no-op when all session tools are already registered and active (start_team_session active per L1)", () => {
      const { deps, setActiveTools, registerTools, registered } = makeDeps({
        sessionActive: true,
        activeTools: ["read", "bash", START_TEAM_SESSION_TOOL_NAME, ...SESSION_TOOL_NAMES],
      });
      for (const name of SESSION_TOOL_NAMES) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(result.activeTools).toEqual(["read", "bash", START_TEAM_SESSION_TOOL_NAME, ...SESSION_TOOL_NAMES]);
      expect(setActiveTools).not.toHaveBeenCalled();
      expect(registerTools).not.toHaveBeenCalled();
    });

    it("registers (if missing) and activates all session tools when inactive", () => {
      const { deps, setActiveTools, registerTools } = makeDeps({
        sessionActive: true,
        activeTools: ["read", "bash"],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(registerTools).toHaveBeenCalledTimes(1);
      // Registration must happen before activation (setActiveTools ignores unknown names)
      expect(registerTools.mock.invocationCallOrder[0])
        .toBeLessThan(setActiveTools.mock.invocationCallOrder[0]);
      expect(result.activeTools).toEqual(["read", "bash", ...SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", ...SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME]);
    });

    it("activates without re-registering when already registered but inactive", () => {
      const { deps, setActiveTools, registerTools, registered } = makeDeps({
        sessionActive: true,
        activeTools: ["read"],
      });
      for (const name of SESSION_TOOL_NAMES) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(registerTools).not.toHaveBeenCalled();
      expect(result.activeTools).toEqual(["read", ...SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME]);
    });

    it("re-adds a partially missing tool (e.g. only set_goal active)", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        activeTools: ["read", "set_goal"],
      });
      for (const name of SESSION_TOOL_NAMES) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read", "set_goal", ...SESSION_TOOL_NAMES.filter((n) => n !== "set_goal"), START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).toHaveBeenCalled();
    });

    it("deduplicates when session tools are already in the active list", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        activeTools: ["read", "set_goal", "set_goal", "start_member"],
      });
      for (const name of SESSION_TOOL_NAMES) registered.add(name);
      // set_goal + start_member active, but finish_goal etc. missing → must fix
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      // No duplicates in the result
      const counts = new Map<string, number>();
      for (const n of result.activeTools) counts.set(n, (counts.get(n) ?? 0) + 1);
      for (const n of SESSION_TOOL_NAMES) expect(counts.get(n)).toBe(1);
    });
  });

  describe("agent-initiated sessions (ADR-0003)", () => {
    it("activates AGENT_SESSION_TOOL_NAMES alongside the 9 session tools (start_team_session included per L1)", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        agentInitiated: true,
        activeTools: ["read", "bash"],
      });
      for (const name of [...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES]) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual([
        "read", "bash",
        ...SESSION_TOOL_NAMES,
        ...AGENT_SESSION_TOOL_NAMES,
        START_TEAM_SESSION_TOOL_NAME,
      ]);
      expect(setActiveTools).toHaveBeenCalled();
    });

    it("no-op in an agent session when everything is already active (start_team_session included)", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        agentInitiated: true,
        activeTools: ["read", ...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME],
      });
      for (const name of [...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES]) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(setActiveTools).not.toHaveBeenCalled();
    });

    it("removes stop_team_session from a user-initiated session (lifecycle stays user-owned; start_team_session preserved)", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        agentInitiated: false,
        activeTools: ["read", ...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME],
      });
      for (const name of [...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES]) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read", ...SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", ...SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME]);
    });

    it("removes stop_team_session outside a session (leak cleanup; start_team_session preserved)", () => {
      const { deps, setActiveTools } = makeDeps({
        sessionActive: false,
        activeTools: ["read", ...AGENT_SESSION_TOOL_NAMES, START_TEAM_SESSION_TOOL_NAME],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read", START_TEAM_SESSION_TOOL_NAME]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", START_TEAM_SESSION_TOOL_NAME]);
    });
  });
});

// ── 阶段③ L1 可见性门控：start_team_session 策略门控（D3 统一不变式） ──

import { START_TEAM_SESSION_TOOL_NAME } from "../tools/agent-session-tool-names";

describe("enforceSessionToolVisibility — start_team_session policy gate (L1, 阶段③)", () => {
  const START = START_TEAM_SESSION_TOOL_NAME;

  it("D3 统一不变式：disabled + 会话活跃 → 移除（含活跃 agent 会话期间；stop_team_session 不受影响）", () => {
    // 运行中的 agent 会话在禁用后不终止（E4）：stop 照常可见（收尾是安全方向，
    // 与开关正交）；仅 start（启动相）被移除。
    const { deps, setActiveTools, registered, registerTools } = makeDeps({
      sessionActive: true,
      agentInitiated: true,
      startTeamSessionVisible: false,
      activeTools: ["read", "bash", START, "stop_team_session"],
    });
    for (const name of [...SESSION_TOOL_NAMES, "stop_team_session"]) registered.add(name);
    const result = enforceSessionToolVisibility(deps);
    expect(result.changed).toBe(true);
    expect(result.activeTools).toContain("stop_team_session");
    expect(result.activeTools).not.toContain(START);
    expect(registerTools).not.toHaveBeenCalled();
    expect(setActiveTools).toHaveBeenCalledWith(
      expect.arrayContaining(["stop_team_session"])
    );
  });

  it("D3 统一不变式：disabled + 无会话 → 移除（陈旧列表重注入同样在下回合边界再移除）", () => {
    const { deps, setActiveTools, registerTools } = makeDeps({
      sessionActive: false,
      startTeamSessionVisible: false,
      activeTools: ["read", "bash", START], // 模拟陈旧 active 列表被其他扩展重注入
    });
    const result = enforceSessionToolVisibility(deps);
    expect(result.changed).toBe(true);
    expect(result.activeTools).toEqual(["read", "bash"]);
    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
    expect(registerTools).not.toHaveBeenCalled();
  });

  it("enabled（含 undefined 缺省）+ 缺失 → 补回（E8: disabled→enabled 往返）", () => {
    for (const visible of [true, undefined]) {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: false,
        startTeamSessionVisible: visible,
        activeTools: ["read", "bash"], // disabled 期间被移除后的状态
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed, `visible=${visible}`).toBe(true);
      expect(result.activeTools, `visible=${visible}`).toEqual(["read", "bash", START]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", START]);
    }
  });

  it("enabled + 会话活跃 + 缺失 → 补回且 registerTools 不被调用（policy gate 与 required→registerTools 隔离）", () => {
    const { deps, setActiveTools, registered, registerTools } = makeDeps({
      sessionActive: true,
      agentInitiated: false,
      startTeamSessionVisible: true,
      activeTools: ["read"],
    });
    for (const name of SESSION_TOOL_NAMES) registered.add(name);
    const result = enforceSessionToolVisibility(deps);
    expect(result.changed).toBe(true);
    expect(result.activeTools).toEqual(["read", ...SESSION_TOOL_NAMES, START]);
    expect(setActiveTools).toHaveBeenCalled();
    // start_team_session 是加载时注册的既成事实（F1）——补回只经 setActiveTools
    expect(registerTools).not.toHaveBeenCalled();
  });

  it("未注册场景：仅补活跃列表名、不补注册（registerTools 不触发；注册缺失属加载层缺陷，静默补注册会掩盖问题）", () => {
    // start_team_session 不在 registered 集合中（模拟加载层缺陷）。E9 记录：
    // 进程启动时已禁用 → 加载期 registerTool 自动激活 → 首个 before_agent_start
    // 之前工具短暂 active，实际暴露面为零（首回合前 LLM 无调用机会、回合边界即
    // 纠正），L2 execute 门控使其结构性无害。
    const { deps, registerTools } = makeDeps({
      sessionActive: false,
      startTeamSessionVisible: true,
      activeTools: ["read", "bash"],
    });
    const result = enforceSessionToolVisibility(deps);
    expect(result.changed).toBe(true);
    expect(result.activeTools).toEqual(["read", "bash", START]);
    expect(registerTools).not.toHaveBeenCalled();
  });

  it("幂等 no-op：disabled + 已移除 / enabled + 已在场 → changed:false、setActiveTools 不调用", () => {
    // disabled + 无会话 + 已移除
    const a = makeDeps({
      sessionActive: false,
      startTeamSessionVisible: false,
      activeTools: ["read", "bash"],
    });
    expect(enforceSessionToolVisibility(a.deps)).toEqual({ changed: false, activeTools: ["read", "bash"] });
    expect(a.setActiveTools).not.toHaveBeenCalled();

    // enabled + 无会话 + 已在场
    const b = makeDeps({
      sessionActive: false,
      startTeamSessionVisible: true,
      activeTools: ["read", START],
    });
    expect(enforceSessionToolVisibility(b.deps)).toEqual({ changed: false, activeTools: ["read", START] });
    expect(b.setActiveTools).not.toHaveBeenCalled();

    // disabled + 会话活跃 + 已移除（session tools 已齐）
    const c = makeDeps({
      sessionActive: true,
      agentInitiated: false,
      startTeamSessionVisible: false,
      activeTools: ["read", ...SESSION_TOOL_NAMES],
    });
    for (const name of SESSION_TOOL_NAMES) c.registered.add(name);
    expect(enforceSessionToolVisibility(c.deps)).toEqual({
      changed: false,
      activeTools: ["read", ...SESSION_TOOL_NAMES],
    });
    expect(c.setActiveTools).not.toHaveBeenCalled();
  });

  it("disabled + user 会话活跃 → start 与 stop_team_session 均被移除（互不干扰既有 forbidden 语义）", () => {
    const { deps, registered, registerTools } = makeDeps({
      sessionActive: true,
      agentInitiated: false,
      startTeamSessionVisible: false,
      activeTools: ["read", START, "stop_team_session", ...SESSION_TOOL_NAMES],
    });
    for (const name of [...SESSION_TOOL_NAMES, "stop_team_session", START]) registered.add(name);
    const result = enforceSessionToolVisibility(deps);
    expect(result.changed).toBe(true);
    expect(result.activeTools).toEqual(["read", ...SESSION_TOOL_NAMES]);
    expect(registerTools).not.toHaveBeenCalled();
  });
});
