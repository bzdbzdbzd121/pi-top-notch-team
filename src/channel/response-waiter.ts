/** Result of a pending wait that resolved or timed out. */
export interface WaitResult {
  status: "response" | "timeout" | "cancelled";
  from?: string;
  content?: string;
  subject?: string;
}

interface PendingEntry {
  correlationId: string;
  resolve: (result: WaitResult) => void;
  timeout: NodeJS.Timeout;
}

export interface ResponseWaiter {
  /**
   * Register a wait for a response matching `correlationId`.
   * Returns a promise that resolves when:
   *  - A matching message arrives via `resolveIfWaiting` → status: "response"
   *  - `timeoutMs` elapses → status: "timeout"
   *  - `cancelAll()` is called → status: "cancelled"
   *
   * Default timeout: 120s. Capped at 300s.
   */
  waitForResponse(
    correlationId: string,
    timeoutMs?: number
  ): Promise<WaitResult>;

  /**
   * Check if a pending wait matches this correlation ID.
   * If yes, resolve it and return true.
   * If no, return false (caller should deliver the message normally).
   */
  resolveIfWaiting(
    correlationId: string,
    from: string,
    content: string,
    subject?: string
  ): boolean;

  /** Cancel a single pending wait by correlation ID. */
  cancelByCorrId(correlationId: string): void;

  /** Cancel all pending waits (e.g. on /team stop). */
  cancelAll(): void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PENDING_LIMIT = 100;

/** TTL for orphaned response buffer entries (5 minutes). */
const BUFFER_TTL_MS = 300_000;

/**
 * Create a ResponseWaiter that manages pending "send and wait" requests,
 * keyed by correlation ID. Also buffers orphaned responses for re-wait.
 */
export function createResponseWaiter(): ResponseWaiter {
  const pending = new Map<string, PendingEntry>();
  // Buffer for responses that arrived after a wait timed out but before re-wait.
  // When a new waitForResponse registers for the same corrId, the buffered
  // response is delivered immediately instead of waiting for a new timeout.
  const responseBuffer = new Map<
    string,
    { result: WaitResult; timer: NodeJS.Timeout }
  >();

  return {
    waitForResponse(
      correlationId: string,
      timeoutMs?: number
    ): Promise<WaitResult> {
      // Check buffer first: a response for this corrId arrived during the gap
      const buffered = responseBuffer.get(correlationId);
      if (buffered) {
        clearTimeout(buffered.timer);
        responseBuffer.delete(correlationId);
        return Promise.resolve(buffered.result);
      }

      const effectiveTimeout = Math.min(
        timeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS
      );

      return new Promise<WaitResult>((resolve) => {
        // Enforce max pending limit: if exceeded, resolve oldest wait immediately as timeout
        if (pending.size >= MAX_PENDING_LIMIT) {
          const oldestKey = pending.keys().next().value;
          if (oldestKey) {
            const oldest = pending.get(oldestKey)!;
            clearTimeout(oldest.timeout);
            pending.delete(oldestKey);
            oldest.resolve({ status: "timeout" });
          }
        }

        const timeout = setTimeout(() => {
          pending.delete(correlationId);
          resolve({ status: "timeout" });
        }, effectiveTimeout);

        pending.set(correlationId, { correlationId, resolve, timeout });
      });
    },

    resolveIfWaiting(
      correlationId: string,
      from: string,
      content: string,
      subject?: string
    ): boolean {
      const entry = pending.get(correlationId);
      if (entry) {
        clearTimeout(entry.timeout);
        pending.delete(correlationId);
        entry.resolve({
          status: "response",
          from,
          content,
          subject,
        });
        return true;
      }

      // No active waiter — buffer the response for a possible re-wait
      const timer = setTimeout(() => {
        responseBuffer.delete(correlationId);
      }, BUFFER_TTL_MS);
      responseBuffer.set(correlationId, {
        result: { status: "response", from, content, subject },
        timer,
      });
      return false;
    },

    cancelByCorrId(correlationId: string): void {
      const entry = pending.get(correlationId);
      if (!entry) return;
      clearTimeout(entry.timeout);
      pending.delete(correlationId);
      entry.resolve({ status: "cancelled" });
    },

    cancelAll(): void {
      for (const [, entry] of pending) {
        clearTimeout(entry.timeout);
        entry.resolve({ status: "cancelled" });
      }
      pending.clear();
      // Clear all buffer TTL timers
      for (const [, bufferEntry] of responseBuffer) {
        clearTimeout(bufferEntry.timer);
      }
      responseBuffer.clear();
    },
  };
}

/**
 * Extract a `<corr:...>` tag from message content.
 * Returns the correlation ID if found, or null.
 */
export function extractCorrelationId(content: string): string | null {
  const m = content.match(/<corr:([a-zA-Z0-9_-]+)>/);
  return m ? m[1] : null;
}
