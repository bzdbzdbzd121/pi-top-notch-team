import type { Router } from "../channel/router";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle } from "../process/member-process";

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
  router: Router;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
  tlToolNames: string[];
}
