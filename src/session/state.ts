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
