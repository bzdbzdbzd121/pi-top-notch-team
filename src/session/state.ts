import type { TeamDefinition } from "../team/definition";

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
  return { ...currentSession };
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
