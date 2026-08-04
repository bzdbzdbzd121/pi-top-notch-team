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

/** Result of a stats query: usage snapshot, or the failure reason (fail-open). */
export type QueryStatsResult =
  | { ok: true; stats: UsageStats }
  | { ok: false; error: string };

/** Result of a compact RPC: success, or the failure reason (fail-open). */
export type CompactResult =
  | { ok: true }
  | { ok: false; error: string };

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
 * Fail-open everywhere: stats query failure/timeout and compact
 * failure/timeout surface as `{ ok: false, error }` (never a throw), and a
 * failed compaction never blocks dispatch. The `error` carries the
 * underlying RPC failure reason so callers can produce honest notifications
 * ("成功静默、失败可见" philosophy).
 */
export interface AutoCompactRuntime {
  /**
   * Query the member's context usage; 3s timeout or any failure →
   * `{ ok: false, error }` (fail-open). `name` is retained for interface
   * consistency with the barrier and future per-member diagnostics.
   */
  queryStats(name: string, handle: MemberProcessHandle): Promise<QueryStatsResult>;
  /** Threshold check (OR semantics, delegates to resolve-auto-compact). */
  shouldCompact(stats: UsageStats, cfg: ResolvedAutoCompact): boolean;
  /**
   * Mark the member as compacting. MUST be called synchronously before any
   * await (race-free: a second dispatch to the same idle member would
   * otherwise double-compact). Reuses the state-machine shield — non-idle
   * states (working/crashed/stopped) are not disturbed.
   */
  beginCompaction(name: string): void;
  /**
   * Run the compact RPC with cfg.timeoutMinutes timeout.
   * Timeout / failure / non-success response → `{ ok: false, error }`
   * (fail-open). `name` is retained for interface consistency with the
   * barrier and future per-member diagnostics.
   */
  compactNow(name: string, handle: MemberProcessHandle, cfg: ResolvedAutoCompact): Promise<CompactResult>;
  /**
   * Exit compacting (compacting → idle). Called in `finally` so the state is
   * reset on success, failure AND interruption. Does NOT flush — flushing is
   * a separate step (flushPending) so callers can keep their dispatch order:
   * reset → dispatch current message → flush queued ones. Non-compacting
   * states (e.g. crashed/stopped, if the member died mid-compaction) are
   * preserved by the state machine.
   */
  endCompaction(name: string): void;
  /**
   * Queue a message that arrived while the member was compacting. Returns
   * false (and does NOT queue) when the member is not in `compacting` — a
   * defensive invariant: queuing on a non-compacting member would orphan the
   * message (nothing would ever flush it). The inline dispatch path checks
   * the state first and always gets true.
   */
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
    ): Promise<QueryStatsResult> {
      try {
        const statsResp = await handle.sendCommandAndWait(
          { type: "get_session_stats" },
          (event: any) => event.type === "response" && event.command === "get_session_stats",
          STATS_QUERY_TIMEOUT_MS
        );
        const usage = statsResp?.data?.contextUsage;
        if (!usage || typeof usage.percent !== "number") {
          return { ok: false, error: "成员未返回上下文用量数据" };
        }
        return { ok: true, stats: { percent: usage.percent, tokens: usage.tokens ?? 0 } };
      } catch (err) {
        // Timeout / RPC failure — fail-open, but keep the real reason for
        // honest notifications (matches the pre-refactor inline behavior).
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    ): Promise<CompactResult> {
      try {
        const compactResp = await handle.sendCommandAndWait(
          { type: "compact" },
          (event: any) => event.type === "response" && event.command === "compact",
          cfg.timeoutMinutes * 60_000
        );
        if (!compactResp || compactResp.success === false) {
          // Fail-open, but keep the RPC's own error text when available
          // (matches the pre-refactor inline behavior).
          return { ok: false, error: compactResp?.error ?? "压缩命令未成功" };
        }
        return { ok: true };
      } catch (err) {
        // Timeout / RPC failure — fail-open with the real reason.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    endCompaction(name: string): void {
      memberOpsStates.set(
        name,
        transitionState(memberOpsStates.get(name) ?? "idle", { type: "compaction_completed" })
      );
    },

    queueDuringCompaction(name: string, msg: TeamMessage): boolean {
      // Defensive invariant: only queue while the member is actually
      // compacting. Queuing otherwise would orphan the message — nothing
      // would ever flush it (flushPending only runs after a compaction).
      if (memberOpsStates.get(name) !== "compacting") return false;
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
