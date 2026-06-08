import type { Router } from "../channel/router";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle } from "../process/member-process";

/** Member operational state, tracked in TL side. */
export type MemberOperationalState = "idle" | "working" | "crashed" | "stopped";

/**
 * Shared mutable state for the active team session.
 * Passed to command registration functions so they can
 * interact with the TL tools, message channel, and session lifecycle.
 */
export interface TeamContext {
  isCreatingTeam: boolean;
  /** When editing, holds the team name. Null otherwise. */
  editingTeamName: string | null;
  processManager: ProcessManager | null;
  memberHandles: Map<string, MemberProcessHandle>;
  router: Router | null;
  messageQueue: MessageQueue | null;
  responseWaiter: ResponseWaiter | null;
  tlToolNames: string[];
  /** Tool names to remove from active set during a team session (e.g. code-writing tools). */
  blockedToolNames: string[];
  /** Member operational state tracking map (TL side). */
  memberOperationalStates: Map<string, MemberOperationalState> | null;
}
