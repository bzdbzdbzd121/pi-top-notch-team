import type { MemberProcessHandle } from "../process/member-process";
import { transitionState } from "../session/state-machine";
import type { MemberOperationalState } from "../session/context";
import { shouldCompact as shouldCompactByThreshold, type ResolvedAutoCompact } from "../settings/resolve-auto-compact";
import type { TeamMessage } from "./types";

// ── Constants ──────────────────────────────────────────────

/** Timeout for the pre-dispatch stats query (same as the status widget). */
const STATS_QUERY_TIMEOUT_MS = 3000;

// ── Types ──────────────────────────────────────────────────

/** Context usage snapshot of a member (from get_session_stats). */
export interface UsageStats {
  percent: number;
  tokens: number;
}

/**
 * Shared Auto-Compaction runtime.
 *
 * Owns the compaction lifecycle primitives AND the per-member pending queue
 * (messages that arrive while a member is compacting). Both the inline
 * dispatch path (createSendToMember) and the batch pre-check barrier
 * (tl-tools, phase 3) compose this runtime, so a compaction started by one
 * path can never orphan messages queued by the other (E2/D2: shared
 * pending/flush is the structural fix for the orphan-message hazard).
 *
 * Fail-open everywhere: stats query failure/timeout → null; compact
 * failure/timeout → false. Callers decide what to do with the result — a
 * failed compaction never blocks dispatch.
 */
export interface AutoCompactRuntime {
  /** Query the member's context usage; 3s timeout or any failure → null (fail-open). */
  queryStats(name: string, handle: MemberProcessHandle): Promise<UsageStats | null>;
  /** Threshold check (OR semantics, delegates to resolve-auto-compact). */
  shouldCompact(stats: UsageStats, cfg: ResolvedAutoCompact): boolean;
  /**
   * Mark the member as compacting. MUST be called synchronously before any
   * await (race-free: a second dispatch to the same idle member would
   * otherwise double-compact). Reuses the state-machine shield — non-idle
   * states are not disturbed.
   */
  beginCompaction(name: string): void;
  /**
   * Run the compact RPC with cfg.timeoutMinutes timeout.
   * Timeout / failure / non-success response → false (fail-open).
   */
  compactNow(name: string, handle: MemberProcessHandle, cfg: ResolvedAutoCompact): Promise<boolean>;
  /**
   * Exit compacting (compacting → idle). Called in `finally` so the state is
   * reset on success, failure AND interruption. Does NOT flush — flushing is
   * a separate step (flushPending) so callers can keep their dispatch order:
   * reset → dispatch current message → flush queued ones.
   */
  endCompaction(name: string): void;
  /** Queue a message that arrived while the member was compacting. */
  queueDuringCompaction(name: string, msg: TeamMessage): boolean;
  /**
   * Return and clear the messages queued during compaction (FIFO — backlog
   * before later arrivals). The caller is responsible for dispatching them.
   * No-op (returns []) when nothing is queued.
   */
  flushPending(name: string): TeamMessage[];
}

// ── createAutoCompactRuntime ───────────────────────────────

/**
 * Create the shared auto-compaction runtime bound to the given operational
 * state map. The map is held by reference, so the runtime stays in sync with
 * whatever the caller writes (e.g. the state machine transitions from the
 * member RPC event handler).
 */
export function createAutoCompactRuntime(
  memberOpsStates: Map<string, MemberOperationalState>
): AutoCompactRuntime {
  /** Messages that arrive while a member is compacting, held until compaction ends. */
  const pendingDuringCompaction = new Map<string, TeamMessage[]>();

  return {
    async queryStats(
      name: string,
      handle: MemberProcessHandle
    ): Promise<UsageStats | null> {
      try {
        const statsResp = await handle.sendCommandAndWait(
          { type: "get_session_stats" },
          (event: any) => event.type === "response" && event.command === "get_session_stats",
          STATS_QUERY_TIMEOUT_MS
        );
        const usage = statsResp?.data?.contextUsage;
        if (!usage || typeof usage.percent !== "number") {
          return null;
        }
        return { percent: usage.percent, tokens: usage.tokens ?? 0 };
      } catch {
        // Timeout / RPC failure — fail-open: caller treats null as "skip compaction".
        return null;
      }
    },

    shouldCompact(stats: UsageStats, cfg: ResolvedAutoCompact): boolean {
      return shouldCompactByThreshold(stats, cfg);
    },

    beginCompaction(name: string): void {
      memberOpsStates.set(
        name,
        transitionState(memberOpsStates.get(name) ?? "idle", { type: "compaction_started" })
      );
    },

    async compactNow(
      name: string,
      handle: MemberProcessHandle,
      cfg: ResolvedAutoCompact
    ): Promise<boolean> {
      try {
        const compactResp = await handle.sendCommandAndWait(
          { type: "compact" },
          (event: any) => event.type === "response" && event.command === "compact",
          cfg.timeoutMinutes * 60_000
        );
        return !!compactResp && compactResp.success !== false;
      } catch {
        // Timeout / RPC failure — fail-open.
        return false;
      }
    },

    endCompaction(name: string): void {
      memberOpsStates.set(
        name,
        transitionState(memberOpsStates.get(name) ?? "idle", { type: "compaction_completed" })
      );
    },

    queueDuringCompaction(name: string, msg: TeamMessage): boolean {
      const pending = pendingDuringCompaction.get(name) ?? [];
      pending.push(msg);
      pendingDuringCompaction.set(name, pending);
      return true;
    },

    flushPending(name: string): TeamMessage[] {
      const pending = pendingDuringCompaction.get(name);
      if (!pending || pending.length === 0) return [];
      pendingDuringCompaction.delete(name);
      return pending;
    },
  };
}
