import type { TeamDefinition, TeamMember } from "../team/definition";

export interface TeamSessionState {
  active: boolean;
  teamDefinition: TeamDefinition | null;
  startedAt: number | null;
}

let currentSession: TeamSessionState = {
  active: false,
  teamDefinition: null,
  startedAt: null,
};

export function getSessionState(): TeamSessionState {
  return structuredClone(currentSession);
}

/** Return a frozen read-only snapshot of the current team members. */
export function getFrozenMembers(): readonly TeamMember[] {
  return Object.freeze([...currentSession.teamDefinition?.members ?? []]);
}

export function startSession(team: TeamDefinition): void {
  currentSession = {
    active: true,
    teamDefinition: team,
    startedAt: Date.now(),
  };
}

export function endSession(): void {
  currentSession = {
    active: false,
    teamDefinition: null,
    startedAt: null,
  };
}

/**
 * Add a new member to the active session's team definition.
 * Used by /team dynamic mode to dynamically build the team.
 * Refreshes the session state so subsequent getSessionState() calls see the change.
 */
export function addMemberToSession(member: TeamMember): TeamDefinition {
  if (!currentSession.active || !currentSession.teamDefinition) {
    throw new Error("No active session — cannot add member");
  }
  const updatedTeam: TeamDefinition = {
    ...currentSession.teamDefinition,
    members: [...currentSession.teamDefinition.members, member],
  };
  startSession(updatedTeam);
  return updatedTeam;
}
