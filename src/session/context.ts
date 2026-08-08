import type { Router } from "../channel/router";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { ProcessManager } from "../process/manager";
import type { MemberProcessHandle } from "../process/member-process";

/** Member operational state, tracked in TL side. */
export type MemberOperationalState = "idle" | "working" | "compacting" | "crashed" | "stopped";

/** UI object shape expected by onSessionStart (compatible with ExtensionUIContext at runtime). */
export interface SessionUI {
  setWidget: (key: string, content: any) => void;
  setStatus: (key: string, text: string | undefined) => void;
  theme: { fg: (...args: any[]) => string };
}

/**
 * Shared mutable state for the active team session.
 * Passed to command registration functions so they can
 * interact with the TL tools, message channel, and session lifecycle.
 */
export interface TeamContext {
  isCreatingTeam: boolean;
  /** When editing, holds the team name. Null otherwise. */
  editingTeamName: string | null;
  /** Whether the current session is a dynamic team mode (/team dynamic or agent-initiated). */
  isDynamicSession: boolean;
  /** Dynamic team mode phase: "design" (discuss + plan) or "execution" (started members, dispatching tasks).
   *  Only relevant when isDynamicSession is true. */
  dynamicPhase: "design" | "execution";
  /**
   * The mission statement of an agent-initiated session (the `task` argument of
   * start_team_session, ADR-0003). Null for user-initiated sessions. Injected
   * into the autonomous TL prompt; cleared on session teardown.
   */
  agentInitiatedTask: string | null;
  processManager: ProcessManager | null;
  /** Direct Map access (read-only view). Prefer getHandle/setHandle for writes. */
  memberHandles: ReadonlyMap<string, MemberProcessHandle>;
  /** Get a member process handle by name. */
  getHandle(name: string): MemberProcessHandle | undefined;
  /** Set a member process handle. */
  setHandle(name: string, handle: MemberProcessHandle): void;
  /** Remove all member handles. */
  clearHandles(): void;
  router: Router | null;
  messageQueue: MessageQueue | null;
  responseWaiter: ResponseWaiter | null;
  tlToolNames: string[];
  /** Member operational state tracking map (TL side). */
  memberOperationalStates: Map<string, MemberOperationalState> | null;

  // ── UI lifecycle hooks (set by index.ts, called by commands/team.ts) ──
  /** Called immediately when /team start runs. Installs team status widget. */
  onSessionStart?: (ui: SessionUI) => void;
  /** Called immediately when /team stop runs. Removes team status widget. */
  onSessionEnd?: () => void;
  /** Called when /team edit <name> enters. Installs edit-mode widget. */
  onEditStart?: (ui: SessionUI) => void;
  /** Called when edit mode exits (cancel/save/start/stop). Removes edit-mode widget. */
  onEditEnd?: () => void;
  /** Called when /team create enters. Installs create-mode widget. */
  onCreateStart?: (ui: SessionUI) => void;
  /** Called when create mode exits (cancel/save/start). Removes create-mode widget. */
  onCreateEnd?: () => void;
}
