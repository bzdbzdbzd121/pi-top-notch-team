import { describe, it, expect, beforeEach } from "vitest";
import { startSession, endSession, getSessionState, addMemberToSession } from "./state";
import type { TeamDefinition, TeamMember } from "../team/definition";

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
