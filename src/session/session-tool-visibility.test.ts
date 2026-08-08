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
    it("no-op when session tools are not active (fresh process, never registered)", () => {
      const { deps, setActiveTools, registerTools } = makeDeps({
        sessionActive: false,
        activeTools: ["read", "bash"],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(result.activeTools).toEqual(["read", "bash"]);
      expect(setActiveTools).not.toHaveBeenCalled();
      expect(registerTools).not.toHaveBeenCalled();
    });

    it("removes ALL leaked session tools from the active set (post-session cleanup)", () => {
      const leaked = ["read", "bash", ...SESSION_TOOL_NAMES, "ctx_search"];
      const { deps, setActiveTools, registerTools } = makeDeps({
        sessionActive: false,
        activeTools: leaked,
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      // Only session tools removed; everything else preserved
      expect(result.activeTools).toEqual(["read", "bash", "ctx_search"]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "ctx_search"]);
      // Never register outside a session
      expect(registerTools).not.toHaveBeenCalled();
    });

    it("removes a partially leaked active list (only some session tools active)", () => {
      const { deps, setActiveTools } = makeDeps({
        sessionActive: false,
        activeTools: ["read", "set_goal", "start_member", "finish_goal", "bash"],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read", "bash"]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
    });

    it("does NOT touch mode-scoped tools (add_dynamic_member / create / update)", () => {
      const { deps, setActiveTools } = makeDeps({
        sessionActive: false,
        activeTools: ["read", ...MODE_TOOLS],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(result.activeTools).toEqual(["read", ...MODE_TOOLS]);
      expect(setActiveTools).not.toHaveBeenCalled();
    });
  });

  describe("inside a team session", () => {
    it("no-op when all session tools are already registered and active", () => {
      const { deps, setActiveTools, registerTools, registered } = makeDeps({
        sessionActive: true,
        activeTools: ["read", "bash", ...SESSION_TOOL_NAMES],
      });
      for (const name of SESSION_TOOL_NAMES) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(result.activeTools).toEqual(["read", "bash", ...SESSION_TOOL_NAMES]);
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
      expect(result.activeTools).toEqual(["read", "bash", ...SESSION_TOOL_NAMES]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", ...SESSION_TOOL_NAMES]);
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
      expect(result.activeTools).toEqual(["read", ...SESSION_TOOL_NAMES]);
    });

    it("re-adds a partially missing tool (e.g. only set_goal active)", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        activeTools: ["read", "set_goal"],
      });
      for (const name of SESSION_TOOL_NAMES) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read", "set_goal", ...SESSION_TOOL_NAMES.filter((n) => n !== "set_goal")]);
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
    it("activates AGENT_SESSION_TOOL_NAMES alongside the 9 session tools", () => {
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
      ]);
      expect(setActiveTools).toHaveBeenCalled();
    });

    it("no-op in an agent session when everything is already active", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        agentInitiated: true,
        activeTools: ["read", ...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES],
      });
      for (const name of [...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES]) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(false);
      expect(setActiveTools).not.toHaveBeenCalled();
    });

    it("removes stop_team_session from a user-initiated session (lifecycle stays user-owned)", () => {
      const { deps, setActiveTools, registered } = makeDeps({
        sessionActive: true,
        agentInitiated: false,
        activeTools: ["read", ...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES],
      });
      for (const name of [...SESSION_TOOL_NAMES, ...AGENT_SESSION_TOOL_NAMES]) registered.add(name);
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read", ...SESSION_TOOL_NAMES]);
      expect(setActiveTools).toHaveBeenCalledWith(["read", ...SESSION_TOOL_NAMES]);
    });

    it("removes stop_team_session outside a session (leak cleanup)", () => {
      const { deps, setActiveTools } = makeDeps({
        sessionActive: false,
        activeTools: ["read", ...AGENT_SESSION_TOOL_NAMES],
      });
      const result = enforceSessionToolVisibility(deps);
      expect(result.changed).toBe(true);
      expect(result.activeTools).toEqual(["read"]);
      expect(setActiveTools).toHaveBeenCalledWith(["read"]);
    });
  });
});
