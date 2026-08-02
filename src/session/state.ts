import type { TeamDefinition, TeamMember } from "../team/definition";

export interface TeamSessionState {
  active: boolean;
  teamDefinition: TeamDefinition | null;
  startedAt: number | null;
  /** Unique session identifier (timestamp-based). Used to isolate session directories. */
  sessionId: string | null;
  /**
   * Whether the TL has written the shared context via the write_shared_context tool.
   * start_member is blocked until this is true (gate: no member starts without a
   * shared context). Only the dedicated tool sets this — direct write/edit of
   * .shared-context.md is intercepted by the tool_call guard.
   */
  sharedContextWritten: boolean;
}

let currentSession: TeamSessionState = {
  active: false,
  teamDefinition: null,
  startedAt: null,
  sessionId: null,
  sharedContextWritten: false,
};

/** Returns a snapshot of the current session state (defensive clone, read-only). */
export function getSessionState(): Readonly<TeamSessionState> {
  return structuredClone(currentSession);
}

/** Quick check whether there's an active session (no clone needed). */
export function isActive(): boolean {
  return currentSession.active;
}

/** Return a snapshot of current team members (new array, not frozen). */
export function getFrozenMembers(): TeamMember[] {
  return [...currentSession.teamDefinition?.members ?? []];
}

/** Generate a short unique session ID (timestamp + random suffix). */
function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

export function startSession(team: TeamDefinition, sessionId?: string): void {
  currentSession = {
    active: true,
    teamDefinition: team,
    startedAt: Date.now(),
    sessionId: sessionId ?? generateSessionId(),
    sharedContextWritten: false,
  };
}

export function endSession(): void {
  currentSession = {
    active: false,
    teamDefinition: null,
    startedAt: null,
    sessionId: null,
    sharedContextWritten: false,
  };
}

/**
 * Mark that the TL has written the shared context via the write_shared_context tool.
 * No-op when no active session exists (defensive — the tool itself guards with isActive).
 */
export function markSharedContextWritten(): void {
  if (currentSession.active) {
    currentSession = { ...currentSession, sharedContextWritten: true };
  }
}

/**
 * Add a new member to the active session's team definition.
 * Used by /team dynamic mode to dynamically build the team.
 * Unlike startSession, this does NOT reset startedAt.
 * Mutates currentSession directly to preserve session ID and startedAt.
 */
export function addMemberToSession(member: TeamMember): TeamDefinition {
  if (!currentSession.active || !currentSession.teamDefinition) {
    throw new Error("No active session — cannot add member");
  }
  const updatedTeam: TeamDefinition = {
    ...currentSession.teamDefinition,
    members: [...currentSession.teamDefinition.members, member],
  };
  currentSession = {
    ...currentSession,
    teamDefinition: updatedTeam,
  };
  return updatedTeam;
}
