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
  /** Member operational state tracking map (TL side). */
  memberOperationalStates: Map<string, MemberOperationalState> | null;

  // ── UI lifecycle hooks (set by index.ts, called by commands/team.ts) ──
  /** Called immediately when /team start runs. Installs team status widget. */
  onSessionStart?: (ui: {
    setWidget: Function;
    setStatus: Function;
    theme: { fg: Function };
  }) => void;
  /** Called immediately when /team stop runs. Removes team status widget. */
  onSessionEnd?: () => void;
}
