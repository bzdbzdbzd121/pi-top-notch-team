import { MAX_COMMAND_SIZE } from "../process/member-process";

// ── S1 message coalescer (消息合并, 阶段 2) ─────────────────
// Per-receiver merge buckets for the dispatch layer (createSendToMember):
// member→member messages without a wait chain (no corrId) arriving while the
// receiver is working are batched and dispatched as ONE prompt at the
// receiver's turn boundary (agent_end). Pure state + DI — the flusher
// callback (which owns the actual prompt construction + dispatch, including
// the auto-compaction check) is injected by createSendToMember via
// setFlusher; the event handler (agent_end / compaction_end / process_exit)
// only calls flush/drain through the same shared instance.

/** Default limits when nothing is configured (方案裁决: ≤5 条 + ≤4000 字符软上限). */
export const DEFAULT_MAX_BATCH_SIZE = 5;
export const DEFAULT_MAX_BATCH_CHARS = 4000;

/** Effective coalescing limits. */
export interface CoalesceLimits {
  maxBatchSize: number;
  maxBatchChars: number;
}

export const DEFAULT_COALESCE_LIMITS: CoalesceLimits = {
  maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
  maxBatchChars: DEFAULT_MAX_BATCH_CHARS,
};

/** One buffered message. `seq` is a coalescer-wide strictly increasing number (stable FIFO key). */
export interface CoalescedEntry {
  seq: number;
  sender: string;
  content: string;
  /** Optional subject line (preserved from the original TeamMessage). */
  subject?: string;
  at: number;
}

/**
 * 入桶输入：seq 由 coalescer 内部分配（严格递增），调用方无需/不可提供——
 * 输入侧的任何 seq 都会被忽略并覆盖（复审建议 5）。
 */
export type CoalesceableMessage = Omit<CoalescedEntry, "seq">;

/**
 * Per-entry formatting overhead of the merged package (编号 + 来源标注 +
 * 主题前缀) in UTF-8 BYTES — conservative estimate for the worst all-Chinese
 * case (≈40 字符 × 3 字节).
 */
const ENTRY_OVERHEAD_BYTES = 128;
/** Safety margin below the hard MAX_COMMAND_SIZE guard (merged-package framing). */
const HARD_GUARD_MARGIN = 2048;

/**
 * Effective per-message cost used by the prefix budget — measured in UTF-8
 * BYTES (Buffer.byteLength), the SAME unit as the member-process MAX_COMMAND_SIZE
 * guard (复审建议 2): a char-count budget would let a Chinese-heavy package
 * pass the soft cap yet exceed the 1MB hard guard and be rejected (message
 * loss).
 */
function entrySize(e: CoalescedEntry): number {
  return Buffer.byteLength(e.content, "utf8") + ENTRY_OVERHEAD_BYTES;
}

/**
 * Pure prefix selection: take the longest prefix of `bucket` that fits
 * `limits` — at most maxBatchSize entries and at most maxBatchChars BYTES
 * (UTF-8, same unit as the hard guard). A single message larger than
 * maxBatchChars is taken alone (size 1, the caller dispatches it without
 * merging); everything else stays in the bucket for the next flush point.
 * FIFO order is never reversed.
 *
 * The byte budget is capped below the hard MAX_COMMAND_SIZE guard
 * (1MB, member-process.ts) so a user-configured huge maxBatchChars can never
 * produce an oversized command.
 */
export function takePrefixForFlush(
  bucket: CoalescedEntry[],
  limits: CoalesceLimits
): CoalescedEntry[] {
  if (bucket.length === 0) return [];
  const effMaxChars = Math.min(
    limits.maxBatchChars,
    MAX_COMMAND_SIZE - HARD_GUARD_MARGIN
  );
  // A single oversized message is taken alone (dispatched unmerged).
  if (entrySize(bucket[0]) > effMaxChars) {
    return [bucket[0]];
  }
  const result: CoalescedEntry[] = [];
  let totalChars = 0;
  for (const e of bucket) {
    const size = entrySize(e);
    if (
      result.length > 0 &&
      (result.length >= limits.maxBatchSize || totalChars + size > effMaxChars)
    ) {
      break;
    }
    result.push(e);
    totalChars += size;
  }
  return result;
}

export interface MessageCoalescer {
  /** Buffer a message into the receiver's bucket (FIFO tail). Caller-supplied seq is ignored. */
  enqueue(receiver: string, entry: CoalesceableMessage): void;
  /** True when the receiver's bucket is non-empty. */
  has(receiver: string): boolean;
  /** Current bucket size (diagnostics/tests). */
  count(receiver: string): number;
  /**
   * Atomically take the longest fitting prefix (see takePrefixForFlush).
   * Taken entries leave the bucket — a later dispatch failure is NOT
   * retried (no wait chain, no re-dispatch duplicates).
   */
  takeForFlush(receiver: string, limits?: CoalesceLimits): CoalescedEntry[];
  /** Take ALL entries (lifecycle drain — process exit / teardown). */
  drain(receiver: string): CoalescedEntry[];
  /**
   * Register the flush dispatch callback (idempotent — the last registration
   * wins). Injected by createSendToMember: builds the merged package and runs
   * the full dispatch path (incl. one auto-compaction check).
   */
  setFlusher(fn: (receiver: string, entries: CoalescedEntry[]) => void): void;
  /**
   * Trigger a flush: take the fitting prefix (limits resolved from the
   * constructor-injected getLimits — 复审建议 1: non-default configured
   * limits take effect at every flush point) and hand it to the flusher.
   * This-independent (no `this` usage) so destructured calls are safe.
   * The merged count is recorded BEFORE the flusher runs, so a dispatch
   * failure inside the flusher can annotate the notification with
   * 「合并包含 N 条消息」(核对退回 1).
   */
  flush(receiver: string): void;
  /**
   * Read-and-consume the count of the receiver's most recent merged-package
   * dispatch (recorded by flush). One-shot — a second read returns
   * undefined, preventing stale annotations on later single-message
   * failures. Undefined when nothing merged was dispatched (yet).
   */
  takeMergedCount(receiver: string): number | undefined;
  /** Clear the recorded merged count (agent_start / single-message dispatch). */
  clearMergedCount(receiver: string): void;
}

/**
 * Create a shared per-channel coalescer. One instance per message channel:
 * the dispatch entry (createSendToMember) enqueues/flushes and the event
 * handler (agent_end / compaction_end / process_exit) flushes/drains through
 * the same instance — bucket state is never split across paths.
 *
 * `getLimits` resolves the effective limits per flush (per-dispatch settings
 * changes take effect immediately). Absent → DEFAULT_COALESCE_LIMITS.
 */
export function createMessageCoalescer(
  getLimits?: () => CoalesceLimits
): MessageCoalescer {
  const buckets = new Map<string, CoalescedEntry[]>();
  // 核对退回 1: per-receiver count of the most recent merged-package dispatch,
  // consumed (takeMergedCount) by the rejection / dispatch-error notification
  // branches to annotate 「合并包含 N 条消息」; cleared on agent_start and on
  // single-message dispatches so stale annotations never attach to a later
  // unrelated failure.
  const lastMergedCounts = new Map<string, number>();
  let nextSeq = 1;
  let flusher: ((receiver: string, entries: CoalescedEntry[]) => void) | null = null;

  const resolveLimits = (): CoalesceLimits => getLimits?.() ?? DEFAULT_COALESCE_LIMITS;

  const doTake = (receiver: string, limits?: CoalesceLimits): CoalescedEntry[] => {
    const bucket = buckets.get(receiver);
    if (!bucket || bucket.length === 0) return [];
    const taken = takePrefixForFlush(bucket, limits ?? resolveLimits());
    if (taken.length === bucket.length) {
      buckets.delete(receiver);
    } else {
      bucket.splice(0, taken.length);
    }
    return taken;
  };

  return {
    enqueue(receiver, message) {
      const bucket = buckets.get(receiver);
      const stored: CoalescedEntry = { ...message, seq: nextSeq++ };
      if (bucket) {
        bucket.push(stored);
      } else {
        buckets.set(receiver, [stored]);
      }
    },

    has(receiver) {
      return (buckets.get(receiver)?.length ?? 0) > 0;
    },

    count(receiver) {
      return buckets.get(receiver)?.length ?? 0;
    },

    takeForFlush(receiver, limits) {
      return doTake(receiver, limits);
    },

    drain(receiver) {
      const bucket = buckets.get(receiver);
      if (!bucket) return [];
      buckets.delete(receiver);
      return bucket;
    },

    setFlusher(fn) {
      flusher = fn;
    },

    flush(receiver) {
      if (!flusher) return; // no dispatch capability yet — entries stay for the next flush point
      const taken = doTake(receiver);
      if (taken.length > 0) {
        // Record BEFORE the flusher runs: a synchronous dispatch failure
        // inside it must see the count for its annotation (核对退回 1).
        lastMergedCounts.set(receiver, taken.length);
        flusher(receiver, taken);
      }
    },

    takeMergedCount(receiver) {
      const count = lastMergedCounts.get(receiver);
      if (count === undefined) return undefined;
      lastMergedCounts.delete(receiver);
      return count;
    },

    clearMergedCount(receiver) {
      lastMergedCounts.delete(receiver);
    },
  };
}
