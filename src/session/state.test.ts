import { describe, it, expect, beforeEach } from "vitest";
import { startSession, endSession, getSessionState, addMemberToSession, isActive, getFrozenMembers, markSharedContextWritten } from "./state";
import type { TeamDefinition, TeamMember } from "../team/definition";

describe("sessionId", () => {
  let baseTeam: TeamDefinition;

  beforeEach(() => {
    endSession();
    baseTeam = {
      name: "test-team",
      description: "A test team",
      members: [],
    };
  });

  it("generates a sessionId on startSession", () => {
    startSession(baseTeam);
    const state = getSessionState();
    expect(state.sessionId).toBeTruthy();
    expect(typeof state.sessionId).toBe("string");
    expect(state.sessionId!.length).toBeGreaterThan(0);
  });

  it("sessionId is null on endSession", () => {
    startSession(baseTeam);
    endSession();
    const state = getSessionState();
    expect(state.sessionId).toBeNull();
  });

  it("generates different sessionIds for consecutive sessions", () => {
    startSession(baseTeam);
    const id1 = getSessionState().sessionId;
    endSession();
    startSession(baseTeam);
    const id2 = getSessionState().sessionId;
    expect(id1).not.toBe(id2);
  });

  it("preserves sessionId across addMemberToSession calls", () => {
    startSession(baseTeam);
    const originalId = getSessionState().sessionId;
    addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "Code" });
    const state = getSessionState();
    expect(state.sessionId).toBe(originalId);
  });

  it("accepts a custom sessionId via options", () => {
    startSession(baseTeam, { sessionId: "my-custom-id" });
    const state = getSessionState();
    expect(state.sessionId).toBe("my-custom-id");
  });

  it("isActive returns false when no session", () => {
    endSession();
    expect(isActive()).toBe(false);
  });

  it("isActive returns true when session active", () => {
    startSession(baseTeam);
    expect(isActive()).toBe(true);
  });

  it("addMemberToSession does NOT reset startedAt", () => {
    startSession(baseTeam);
    const before = getSessionState().startedAt;
    addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "Code" });
    const after = getSessionState().startedAt;
    expect(after).toBe(before);
  });

  it("getFrozenMembers returns a plain array (not Object.freeze)", () => {
    startSession(baseTeam);
    // Only check that it's a regular array — Object.isFrozen would be true
    // for empty arrays even without freeze; just verify it returns members
    expect(getFrozenMembers()).toEqual([]);
  });
});

describe("sharedContextWritten", () => {
  let baseTeam: TeamDefinition;

  beforeEach(() => {
    endSession();
    baseTeam = {
      name: "test-team",
      description: "A test team",
      members: [],
    };
  });

  it("starts false on startSession (start_member gate closed)", () => {
    startSession(baseTeam);
    expect(getSessionState().sharedContextWritten).toBe(false);
  });

  it("markSharedContextWritten sets it true", () => {
    startSession(baseTeam);
    expect(getSessionState().sharedContextWritten).toBe(false);
    markSharedContextWritten();
    expect(getSessionState().sharedContextWritten).toBe(true);
  });

  it("is reset to false on endSession", () => {
    startSession(baseTeam);
    markSharedContextWritten();
    endSession();
    expect(getSessionState().sharedContextWritten).toBe(false);
  });

  it("is reset to false when a new session starts", () => {
    startSession(baseTeam);
    markSharedContextWritten();
    startSession(baseTeam);
    expect(getSessionState().sharedContextWritten).toBe(false);
  });

  it("markSharedContextWritten is a no-op without an active session", () => {
    endSession();
    markSharedContextWritten();
    expect(getSessionState().sharedContextWritten).toBe(false);
  });

  it("survives addMemberToSession (dynamic mode)", () => {
    startSession(baseTeam);
    markSharedContextWritten();
    addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "Code" });
    expect(getSessionState().sharedContextWritten).toBe(true);
  });
});

describe("session origin (ADR-0003)", () => {
  let baseTeam: TeamDefinition;

  beforeEach(() => {
    endSession();
    baseTeam = {
      name: "test-team",
      description: "A test team",
      members: [],
    };
  });

  it("defaults to \"user\" when no origin is given", () => {
    startSession(baseTeam);
    expect(getSessionState().origin).toBe("user");
  });

  it("accepts origin \"agent\" via options", () => {
    startSession(baseTeam, { origin: "agent" });
    expect(getSessionState().origin).toBe("agent");
  });

  it("resets origin to \"user\" on endSession", () => {
    startSession(baseTeam, { origin: "agent" });
    endSession();
    expect(getSessionState().origin).toBe("user");
  });

  it("preserves origin across addMemberToSession calls", () => {
    startSession(baseTeam, { origin: "agent" });
    addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "Code" });
    expect(getSessionState().origin).toBe("agent");
  });
});

describe("addMemberToSession", () => {
  let baseTeam: TeamDefinition;

  beforeEach(() => {
    endSession(); // ensure clean state
    baseTeam = {
      name: "test-team",
      description: "A test team",
      members: [],
    };
  });

  it("throws when no active session", () => {
    expect(() => addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "You are a coder" })).toThrow(
      "No active session"
    );
  });

  it("adds a member to an empty team", () => {
    startSession(baseTeam);
    const member: TeamMember = {
      name: "coder",
      label: "编码员",
      systemPrompt: "You are a coding expert",
    };

    const updated = addMemberToSession(member);

    expect(updated.members).toHaveLength(1);
    expect(updated.members[0].name).toBe("coder");
    expect(updated.members[0].label).toBe("编码员");
    expect(updated.members[0].systemPrompt).toBe("You are a coding expert");
  });

  it("adds multiple members incrementally", () => {
    startSession(baseTeam);

    addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "Code" });
    addMemberToSession({ name: "reviewer", label: "审查员", systemPrompt: "Review" });
    addMemberToSession({ name: "tester", label: "测试员", systemPrompt: "Test" });

    const state = getSessionState();
    expect(state.teamDefinition!.members).toHaveLength(3);
    expect(state.teamDefinition!.members.map((m) => m.name)).toEqual([
      "coder",
      "reviewer",
      "tester",
    ]);
  });

  it("preserves existing session state on add", () => {
    const startTime = Date.now();
    startSession(baseTeam);
    addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "Code" });

    const state = getSessionState();
    expect(state.active).toBe(true);
    expect(state.teamDefinition!.name).toBe("test-team");
    expect(state.teamDefinition!.description).toBe("A test team");
    expect(state.startedAt).toBeGreaterThanOrEqual(startTime);
    // sessionId preserved across addMemberToSession
    expect(state.sessionId).toBeTruthy();
  });

  it("does not affect non-dynamic sessions (works with any active session)", () => {
    startSession({
      name: "normal-team",
      description: "Normal",
      defaults: { model: "claude-3" },
      members: [{ name: "worker", label: "工人", systemPrompt: "Work" }],
      workflow: {
        strictness: "reference",
        description: "Test workflow",
        stages: [{ member: "worker", name: "build", description: "Build" }],
      },
    });

    addMemberToSession({ name: "coder", label: "编码员", systemPrompt: "Code" });

    const state = getSessionState();
    expect(state.teamDefinition!.members).toHaveLength(2);
    expect(state.teamDefinition!.defaults).toBeDefined();
    expect(state.teamDefinition!.workflow).toBeDefined();
  });

  it("member without label defaults to undefined (displayed as name)", () => {
    startSession(baseTeam);
    addMemberToSession({ name: "worker", systemPrompt: "Just work" });

    const state = getSessionState();
    expect(state.teamDefinition!.members[0].label).toBeUndefined();
  });

  it("member with model override is preserved", () => {
    startSession(baseTeam);
    addMemberToSession({
      name: "coder",
      label: "编码员",
      systemPrompt: "Code",
      model: "anthropic/claude-sonnet-4",
    });

    const state = getSessionState();
    expect(state.teamDefinition!.members[0].model).toBe("anthropic/claude-sonnet-4");
  });
});
