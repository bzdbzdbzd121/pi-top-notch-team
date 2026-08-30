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

/** Per-entry formatting overhead of the merged package (编号 + 来源标注). */
const ENTRY_OVERHEAD_CHARS = 40;
/** Safety margin below the hard MAX_COMMAND_SIZE guard (merged-package framing). */
const HARD_GUARD_MARGIN = 2048;

/** Effective per-message char cost used by the prefix budget. */
function entrySize(e: CoalescedEntry): number {
  return e.content.length + ENTRY_OVERHEAD_CHARS;
}

/**
 * Pure prefix selection: take the longest prefix of `bucket` that fits
 * `limits` — at most maxBatchSize entries and at most maxBatchChars chars.
 * A single message larger than maxBatchChars is taken alone (size 1, the
 * caller dispatches it without merging); everything else stays in the bucket
 * for the next flush point. FIFO order is never reversed.
 *
 * The char budget is capped below the hard MAX_COMMAND_SIZE guard
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
  /** Buffer a message into the receiver's bucket (FIFO tail). */
  enqueue(receiver: string, entry: CoalescedEntry): void;
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
  /** Trigger a flush: take the fitting prefix and hand it to the flusher. */
  flush(receiver: string, limits?: CoalesceLimits): void;
}

/**
 * Create a shared per-channel coalescer. One instance per message channel:
 * the dispatch entry (createSendToMember) enqueues/flushes and the event
 * handler (agent_end / compaction_end / process_exit) flushes/drains through
 * the same instance — bucket state is never split across paths.
 */
export function createMessageCoalescer(): MessageCoalescer {
  const buckets = new Map<string, CoalescedEntry[]>();
  let nextSeq = 1;
  let flusher: ((receiver: string, entries: CoalescedEntry[]) => void) | null = null;

  return {
    enqueue(receiver, entry) {
      const bucket = buckets.get(receiver);
      const stored: CoalescedEntry = { ...entry, seq: nextSeq++ };
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
      const bucket = buckets.get(receiver);
      if (!bucket || bucket.length === 0) return [];
      const taken = takePrefixForFlush(bucket, limits ?? DEFAULT_COALESCE_LIMITS);
      if (taken.length === bucket.length) {
        buckets.delete(receiver);
      } else {
        bucket.splice(0, taken.length);
      }
      return taken;
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

    flush(receiver, limits) {
      if (!flusher) return; // no dispatch capability yet — entries stay for the next flush point
      const taken = this.takeForFlush(receiver, limits);
      if (taken.length > 0) {
        flusher(receiver, taken);
      }
    },
  };
}
