import type { MemberProcessHandle } from "../process/member-process";
import { transitionState } from "../session/state-machine";
import type { MemberOperationalState } from "../session/context";
import { shouldCompact as shouldCompactByThreshold, type ResolvedAutoCompact } from "../settings/resolve-auto-compact";
import type { TeamMessage } from "./types";

// ── Constants ──────────────────────────────────────────────

/** Timeout for the pre-dispatch stats query (same as the status widget). Also used for the get_state compaction-state query (Phase 1). */
const STATS_QUERY_TIMEOUT_MS = 3000;

/** Poll interval for the waitCompactionIdle fallback (Phase 2, 三出口之②). */
const WAIT_COMPACTION_POLL_MS = 30_000;

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
  | {
      ok: false;
      error: string;
      /**
       * Phase 2: true when the LOCAL lease expired (sendCommandAndWait
       * timeout) — the member-side compaction may STILL be running, so the
       * caller must NOT dispatch into it (queue instead). false = the RPC
       * settled on the member side (safe to dispatch).
       */
      timedOut: boolean;
      /**
       * Phase 3 (审查建议 3, near-miss): true when the lease expired BUT a
       * compaction_end heartbeat was processed during the lease — the
       * member-side compaction actually FINISHED and the compact response is
       * merely delayed. The caller closes the lifecycle and dispatches
       * immediately (the queue/watcher path is unnecessary). The timeout
       * mark is NOT recorded in this case (no stale notification on the next
       * compaction). Only present on the timedOut branch.
       */
      settledByHeartbeat?: boolean;
    };

/** Result of the waitCompactionIdle fallback poll (Phase 2). */
export type WaitCompactionIdleResult =
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
   *
   * Registers an in-flight lease for the duration of the call (see
   * `hasInFlightCompaction`): the compaction_end event branch defers to the
   * lease-owning flow while it is held, because the member emits
   * compaction_end BEFORE the compact response.
   */
  compactNow(name: string, handle: MemberProcessHandle, cfg: ResolvedAutoCompact): Promise<CompactResult>;
  /**
   * True while a compactNow call for the member is awaiting its RPC response
   * (the lease is in flight). The compaction_end branch returns early in
   * this state — the lease-owning flow (inline finally / batch barrier)
   * handles the exit and the ORDERED flush. Only lease-expired heartbeats
   * (timeout already settled the lease) fall through.
   */
  hasInFlightCompaction(name: string): boolean;
  /**
   * Record that a compaction_end heartbeat was processed by the event branch
   * (both the in-flight-deferred path and the close path). Powers two
   * Phase-2 mechanisms:
   *   (a) the near-miss stale-mark suppression inside compactNow (a heartbeat
   *       during THIS lease ⇒ the compaction finished, the response is merely
   *       delayed — no timeout mark);
   *   (b) the batch barrier's attempted 语义 (a member whose compaction
   *       SETTLED via the event during the barrier is marked, so its messages
   *       skip the redundant inline check).
   */
  markCompactionEnd(name: string): void;
  /** Per-member count of processed compaction_end heartbeats (barrier baselines). */
  getCompactionEndCount(name: string): number;
  /**
   * Phase 2 fallback wait (三出口之②): poll until the member's compaction is
   * no longer running, or the budget is exhausted. The compaction_end event
   * is the primary exit; this covers event loss (pipe/network) and process
   * auto-restart (events not replayed). Every 30s, release when
   *   (a) the operational state left `compacting` (process exit — the 2.3
   *       branch owns pending cleanup), or
   *   (b) get_state.isCompacting === false, or the query FAILED (fail-open
   *       treats "unknown" as "ended" — the rejection correction restores
   *       the honest state if the dispatch then gets refused).
   * Budget exhausted → `{ ok: false }` (the caller abandons the pending
   * messages + resolves corrIds + notifies the TL for manual intervention).
   * The poll timer is unref'd (an abandoned wait never holds the process).
   */
  waitCompactionIdle(name: string, handle: MemberProcessHandle, budgetMs: number): Promise<WaitCompactionIdleResult>;
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
   *
   * `front` (审查建议 2): places the message at the HEAD instead of the tail.
   * Used by the stuck-compaction path for the trigger message whose lease
   * expired AFTER later arrivals were queued — its natural position is the
   * head (the success path dispatches it before the pending FIFO).
   */
  queueDuringCompaction(name: string, msg: TeamMessage, front?: boolean): boolean;
  /**
   * Query the member's compaction state via get_state (isCompacting).
   * 3s timeout, fail-open → null on any failure/timeout. Used by the
   * prompt-rejection branch to restore the honest operational state
   * ("ask instead of guess" — never fabricate working/idle).
   */
  queryCompactionState(name: string, handle: MemberProcessHandle): Promise<boolean | null>;
  /**
   * Record that the compact RPC lease expired (local timeout) while the
   * member-side compaction may still be running ("租约 vs 心跳": the lease
   * expiry says nothing about the member). Consumed by the compaction_end
   * event branch to notify the TL when the member-side compaction actually
   * finishes.
   */
  markCompactionTimeout(name: string): void;
  /** Return and clear the recorded compaction-timeout timestamp for a member, if any. */
  takeCompactionTimeout(name: string): number | undefined;
  /**
   * Return and clear the messages queued during compaction (FIFO — backlog
   * before later arrivals). The caller is responsible for dispatching them.
   * No-op (returns []) when nothing is queued.
   */
  flushPending(name: string): TeamMessage[];
}

// ── createAutoCompactRuntime ───────────────────────────────

/**
 * Query the member's compaction state via get_state (isCompacting). 3s
 * timeout, fail-open → null on any failure/timeout. Shared by the
 * queryCompactionState primitive (rejection correction) and the
 * waitCompactionIdle fallback poll.
 */
async function queryCompactionStateRpc(handle: MemberProcessHandle): Promise<boolean | null> {
  try {
    const resp = await handle.sendCommandAndWait(
      { type: "get_state" },
      (event: any) => event.type === "response" && event.command === "get_state",
      STATS_QUERY_TIMEOUT_MS
    );
    if (!resp || resp.success === false) return null;
    const isCompacting = resp?.data?.isCompacting;
    return typeof isCompacting === "boolean" ? isCompacting : null;
  } catch {
    // Timeout / RPC failure — fail-open (null = "could not determine").
    // The caller picks the conservative branch.
    return null;
  }
}

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
  /**
   * Per-member timestamp of the last compactNow lease timeout (Phase 1). The
   * member-side compaction may still be running — the compaction_end event
   * branch consumes the mark to notify the TL.
   */
  const compactionTimeouts = new Map<string, number>();
  /**
   * In-flight compactNow leases (per member) — set on entry, cleared on
   * settle. The compaction_end branch checks this to defer exit+flush to the
   * lease-owning flow (review fix: the member emits compaction_end BEFORE
   * the compact response, so every in-lease success hits this window).
   */
  const inFlightCompactions = new Set<string>();
  /**
   * Per-member compaction_end heartbeat count (Phase 2). Incremented by the
   * event branch; the near-miss suppression reads the delta across a lease,
   * the batch barrier uses it for the attempted 语义 (settled via event).
   */
  const compactionEndCounts = new Map<string, number>();

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
        // pi 上游 getContextUsage()（0.83.x/0.84.x dist 实测，agent-session.js
        // ~2542 行）在「最新压缩条目之后无有效 assistant 回复（stopReason 非
        // aborted/error 且 calculateContextTokens(usage) > 0）」时刻意返回
        // { tokens: null, contextWindow, percent: null }——压缩前的 usage 反映
        // 压缩前的大上下文、不可信，宁缺毋滥（上游注释原文："context token count
        // is unknown until the next LLM response"）。压缩刚完成，上下文 = summary
        // + 保留窗口 + 待派发任务，必然远低于压缩阈值——null 语义化为「已知低」
        // （percent 0），静默跳过本次压缩检查（与现状「跳过+通知」的压缩行为完全
        // 一致，仅去掉误导性「无法查询」通知；批屏障共享 runtime 自动受益）。
        // 注意：percent:0 是语义化猜测而非事实；当前上游 percent/tokens 同时为
        // null，若未来出现混合形态（如 tokens null 而 percent 为 number），需
        // 字段级判别，勿锁死「同时 null」假设。
        if (usage && usage.percent === null) {
          return { ok: true, stats: { percent: 0, tokens: 0 } };
        }
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
      // Register the lease BEFORE any await: the compaction_end branch uses
      // hasInFlightCompaction to defer exit+flush to this call's owner
      // (inline finally / batch barrier). The member emits compaction_end
      // before the compact response, so a healthy in-lease compaction always
      // hits the branch while the lease is held.
      inFlightCompactions.add(name);
      const endCountAtLeaseStart = compactionEndCounts.get(name) ?? 0;
      try {
        const compactResp = await handle.sendCommandAndWait(
          { type: "compact" },
          (event: any) => event.type === "response" && event.command === "compact",
          cfg.timeoutMinutes * 60_000
        );
        if (!compactResp || compactResp.success === false) {
          // Fail-open, but keep the RPC's own error text when available
          // (matches the pre-refactor inline behavior). The member-side
          // compaction already settled — safe to dispatch.
          return { ok: false, error: compactResp?.error ?? "压缩命令未成功", timedOut: false };
        }
        return { ok: true };
      } catch (err) {
        // Timeout / RPC failure — fail-open, but keep the real reason for
        // honest notifications (matches the pre-refactor inline behavior).
        const reason = err instanceof Error ? err.message : String(err);
        // A TIMEOUT records the lease-expired mark ONLY when no compaction_end
        // heartbeat was processed during this lease (租约 vs 心跳 — the lease
        // expiry says nothing about the member-side state). If the heartbeat
        // DID arrive, the compaction actually finished and the response is
        // merely delayed — recording a mark would linger and mis-fire on the
        // NEXT compaction's compaction_end with a stale timestamp (review
        // fix 建议 1: near-miss race). Non-timeout failures mean the
        // compaction RPC already settled on the member side — no mark.
        // 建议 3: the near-miss heartbeat also proves SETTLEMENT — the result
        // carries settledByHeartbeat so the caller dispatches immediately
        // instead of queueing into the fallback watcher.
        const heartbeatSeen =
          (compactionEndCounts.get(name) ?? 0) > endCountAtLeaseStart;
        const timedOut = reason.includes("timed out");
        if (timedOut && !heartbeatSeen) {
          compactionTimeouts.set(name, Date.now());
        }
        return {
          ok: false,
          error: reason,
          timedOut,
          // Present only when the near-miss actually occurred (heartbeat
          // during lease + lease expiry) — absent otherwise.
          ...(timedOut && heartbeatSeen ? { settledByHeartbeat: true } : {}),
        };
      } finally {
        inFlightCompactions.delete(name);
      }
    },

    hasInFlightCompaction(name: string): boolean {
      return inFlightCompactions.has(name);
    },

    markCompactionEnd(name: string): void {
      compactionEndCounts.set(name, (compactionEndCounts.get(name) ?? 0) + 1);
    },

    getCompactionEndCount(name: string): number {
      return compactionEndCounts.get(name) ?? 0;
    },

    async waitCompactionIdle(
      name: string,
      handle: MemberProcessHandle,
      budgetMs: number
    ): Promise<WaitCompactionIdleResult> {
      const deadline = Date.now() + budgetMs;
      return new Promise<WaitCompactionIdleResult>((resolve) => {
        let settled = false;
        // 审查建议 1: EVERY scheduled poll timer must be unref'd — the rearm
        // inside pollOnce included. A stuck compaction abandoned by Esc must
        // not hold the extension process open until the budget expires (the
        // initial timer was already unref'd; the rearm must match).
        const schedulePoll = (): NodeJS.Timeout => {
          const t = setTimeout(pollOnce, WAIT_COMPACTION_POLL_MS);
          if (typeof t.unref === "function") t.unref();
          return t;
        };
        const pollOnce = async (): Promise<void> => {
          if (settled) return;
          // Operational state first: a process exit / intentional stop has
          // already drained the pending queue (2.3) — release without an RPC.
          if (memberOpsStates.get(name) !== "compacting") {
            settled = true;
            resolve({ ok: true });
            return;
          }
          // Ask the member (fail-open): false OR a failed query counts as
          // "ended" — the caller closes the lifecycle and flushes.
          const isCompacting = await queryCompactionStateRpc(handle);
          if (settled) return;
          if (isCompacting === false || isCompacting === null) {
            settled = true;
            resolve({ ok: true });
            return;
          }
          if (Date.now() >= deadline) {
            settled = true;
            resolve({ ok: false, error: "压缩超时上限" });
            return;
          }
          timer = schedulePoll();
        };
        let timer: NodeJS.Timeout = schedulePoll();
      });
    },

    async queryCompactionState(
      name: string,
      handle: MemberProcessHandle
    ): Promise<boolean | null> {
      return queryCompactionStateRpc(handle);
    },

    markCompactionTimeout(name: string): void {
      compactionTimeouts.set(name, Date.now());
    },

    takeCompactionTimeout(name: string): number | undefined {
      const ts = compactionTimeouts.get(name);
      if (ts === undefined) return undefined;
      compactionTimeouts.delete(name);
      return ts;
    },

    endCompaction(name: string): void {
      memberOpsStates.set(
        name,
        transitionState(memberOpsStates.get(name) ?? "idle", { type: "compaction_completed" })
      );
    },

    queueDuringCompaction(name: string, msg: TeamMessage, front = false): boolean {
      // Defensive invariant: only queue while the member is actually
      // compacting. Queuing otherwise would orphan the message — nothing
      // would ever flush it (flushPending only runs after a compaction).
      if (memberOpsStates.get(name) !== "compacting") return false;
      const pending = pendingDuringCompaction.get(name) ?? [];
      if (front) pending.unshift(msg);
      else pending.push(msg);
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
