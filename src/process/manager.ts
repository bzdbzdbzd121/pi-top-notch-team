import type { MemberProcessHandle, MemberState } from "./member-process";
import { transitionState } from "../session/state-machine";
import type { MemberOperationalState } from "../session/state-machine";

export interface ProcessManagerOptions {
  /** Whether to automatically restart crashed members. Default: true */
  autoRestart?: boolean;
  /** Max restarts within the tracking window before giving up. Default: 5 */
  maxRestarts?: number;
  /** Tracking window in ms. Default: 60000 (1 minute) */
  restartWindowMs?: number;
  /** Initial backoff delay in ms before first restart. Default: 1000 (1s) */
  initialBackoffMs?: number;
  /** Called when a member exceeds the max restart threshold and is marked as error. */
  onCrashLoopDetected?: (name: string, restarts: number) => void;
  /** Called on each restart attempt. */
  onRestarting?: (name: string, attempt: number, delayMs: number) => void;
}

export interface ProcessManager {
  listStatus(): MemberState[];
  getStatus(name: string): MemberState | null;
  stop(name: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Called when a member process exits unexpectedly. Triggers auto-restart if enabled. */
  handleExit(name: string, exitCode: number | null): void;
  /** Dynamically add a new member handle (e.g. from start_member tool). */
  addHandle(handle: MemberProcessHandle): void;

  // ── Operational state (unified with memberOpsStates) ──
  /** Set the operational state for a member. */
  setOperationalState(name: string, state: MemberOperationalState): void;
  /** Get the operational state for a member. */
  getOperationalState(name: string): MemberOperationalState | undefined;
  /** Get the internal operational state map (for consumers that need direct map access). */
  getOperationalStateMap(): Map<string, MemberOperationalState>;
}

/**
 * Manages the lifecycle of multiple Member processes with crash-loop protection.
 *
 * Crash-loop detection: counts restarts within a sliding window.
 * If the count exceeds `maxRestarts`, the process is left in "error" state
 * and the `onCrashLoopDetected` callback is invoked.
 */
export function createProcessManager(
  handles: MemberProcessHandle[] = [],
  options: ProcessManagerOptions = {}
): ProcessManager {
  const {
    autoRestart = false,
    maxRestarts = 5,
    restartWindowMs = 60_000,
    initialBackoffMs = 1_000,
    onCrashLoopDetected,
    onRestarting,
  } = options;
  const memberMap = new Map<string, MemberProcessHandle>();

  // Crash tracking per member
  const crashTimestamps = new Map<string, number[]>();
  // Members that exceeded the crash limit and are frozen (no restart)
  const frozenMembers = new Set<string>();
  // Pending restart timers keyed by member name (for cancellation on stop)
  const pendingRestartTimers = new Map<string, NodeJS.Timeout>();
  // Unified operational state tracking (replaces standalone memberOpsStates map)
  const operationalStates = new Map<string, MemberOperationalState>();

  /**
   * Prune crash timestamps older than the tracking window,
   * then return the count within the window.
   */
  function pruneCrashCount(name: string): number {
    const now = Date.now();
    const timestamps = crashTimestamps.get(name) ?? [];
    const recent = timestamps.filter((t) => now - t < restartWindowMs);
    crashTimestamps.set(name, recent);
    return recent.length;
  }

  /**
   * Record a crash and check if the limit is exceeded.
   */
  function recordCrash(name: string): boolean {
    const now = Date.now();
    let timestamps = crashTimestamps.get(name) ?? [];
    // Prune old entries
    timestamps = timestamps.filter((t) => now - t < restartWindowMs);
    timestamps.push(now);
    crashTimestamps.set(name, timestamps);
    return timestamps.length > maxRestarts;
  }

  /**
   * Calculate exponential backoff delay given a crash count.
   * Pure function — no side effects.
   * The count is crashes *in the window including current*, so the delay
   * for the *next* start attempt uses (count - 1) as the exponent.
   */
  function getBackoffDelay(count: number): number {
    const exponent = Math.max(0, count - 1);
    const delay = initialBackoffMs * Math.pow(2, exponent);
    // Cap at 30 seconds
    return Math.min(delay, 30_000);
  }

  for (const handle of handles) {
    memberMap.set(handle.name, handle);
  }

  const manager: ProcessManager = {
    listStatus(): MemberState[] {
      return Array.from(memberMap.values()).map((h) => {
        const state = h.getState();
        // Override status for frozen (crashed-too-many) members
        if (frozenMembers.has(h.name)) {
          return { ...state, status: "error" as const };
        }
        return state;
      });
    },

    getStatus(name: string): MemberState | null {
      const handle = memberMap.get(name);
      if (!handle) return null;
      const state = handle.getState();
      if (frozenMembers.has(name)) {
        return { ...state, status: "error" as const };
      }
      return state;
    },

    async stop(name: string): Promise<void> {
      // Cancel any pending restart timer for this member
      const timer = pendingRestartTimers.get(name);
      if (timer) {
        clearTimeout(timer);
        pendingRestartTimers.delete(name);
      }
      const handle = memberMap.get(name);
      if (handle) {
        // Clear crash history on intentional stop
        crashTimestamps.delete(name);
        frozenMembers.delete(name);
        operationalStates.set(name, transitionState(operationalStates.get(name) ?? "idle", { type: "stopped" }));
        await handle.stop();
      }
    },

    async stopAll(): Promise<void> {
      // Cancel all pending restart timers
      for (const [, timer] of pendingRestartTimers) {
        clearTimeout(timer);
      }
      pendingRestartTimers.clear();
      crashTimestamps.clear();
      frozenMembers.clear();
      await Promise.all(
        Array.from(memberMap.values()).map((h) => h.stop())
      );
    },

    handleExit(name: string, exitCode: number | null): void {
      if (!autoRestart) return;

      const handle = memberMap.get(name);
      if (!handle) return;

      // Don't restart frozen members
      if (frozenMembers.has(name)) return;

      // Severe signals (SIGSEGV=11, SIGABRT=6) → freeze immediately
      // Normal exit (code=0, null) and SIGTERM (code=143) are not crash-worthy
      // Regular error codes (code=1, etc.) go through the normal crash loop
      const isSevere = exitCode === 6 || exitCode === 11;

      // Check crash loop
      const exceeded = recordCrash(name);
      if (exceeded || isSevere) {
        frozenMembers.add(name);
        operationalStates.set(name, transitionState(operationalStates.get(name) ?? "idle", { type: "process_exit", isCrashLoop: true }));
        crashTimestamps.delete(name); // Reset so next manual start works
        onCrashLoopDetected?.(name, maxRestarts + 1);
        return;
      }

      // Prune crash count and compute backoff delay separately
      const count = pruneCrashCount(name);
      const delayMs = getBackoffDelay(count);
      const attempt = count;

      onRestarting?.(name, attempt, delayMs);

      const timer = setTimeout(() => {
        pendingRestartTimers.delete(name);
        // Re-check: might have been stopped/frozen intentionally while waiting
        if (!frozenMembers.has(name) && handle.getState().status !== "running") {
          handle.start().catch(() => {});
        }
      }, delayMs);
      pendingRestartTimers.set(name, timer);
    },

    addHandle(handle: MemberProcessHandle): void {
      memberMap.set(handle.name, handle);
      // Initialize operational state via started event
      if (!operationalStates.has(handle.name)) {
        operationalStates.set(handle.name, transitionState("idle", { type: "started" }));
      }
    },

    setOperationalState(name: string, state: MemberOperationalState): void {
      operationalStates.set(name, state);
    },

    getOperationalState(name: string): MemberOperationalState | undefined {
      return operationalStates.get(name);
    },

    getOperationalStateMap(): Map<string, MemberOperationalState> {
      return operationalStates;
    },
  };

  return manager;
}
