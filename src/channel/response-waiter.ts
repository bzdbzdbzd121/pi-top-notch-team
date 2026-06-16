/** Result of a pending wait that resolved or was cancelled. */
export interface WaitResult {
  status: "response" | "cancelled";
  from?: string;
  content?: string;
  subject?: string;
}

interface PendingEntry {
  correlationId: string;
  resolve: (result: WaitResult) => void;
}

export interface ResponseWaiter {
  /**
   * Register a wait for a response matching `correlationId`.
   * Returns a promise that resolves when:
   *  - A matching message arrives via `resolveIfWaiting` → status: "response"
   *  - `cancelAll()` or `cancelByCorrId()` is called → status: "cancelled"
   *
   * Waits indefinitely — no timeout. The caller should use the
   * all-idle detection mechanism to avoid blocking forever.
   */
  waitForResponse(correlationId: string): Promise<WaitResult>;

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

const MAX_PENDING_LIMIT = 100;

/**
 * Create a ResponseWaiter that manages pending "send and wait" requests,
 * keyed by correlation ID. No timeout — waits indefinitely.
 */
export function createResponseWaiter(): ResponseWaiter {
  const pending = new Map<string, PendingEntry>();

  return {
    waitForResponse(correlationId: string): Promise<WaitResult> {
      return new Promise<WaitResult>((resolve) => {
        // Enforce max pending limit: if exceeded, resolve oldest wait immediately as cancelled
        if (pending.size >= MAX_PENDING_LIMIT) {
          const oldestKey = pending.keys().next().value;
          if (oldestKey) {
            const oldest = pending.get(oldestKey)!;
            pending.delete(oldestKey);
            oldest.resolve({ status: "cancelled" });
          }
        }

        pending.set(correlationId, { correlationId, resolve });
      });
    },

    resolveIfWaiting(
      correlationId: string,
      from: string,
      content: string,
      subject?: string
    ): boolean {
      const entry = pending.get(correlationId);
      if (!entry) return false;

      pending.delete(correlationId);
      entry.resolve({
        status: "response",
        from,
        content,
        subject,
      });
      return true;
    },

    cancelByCorrId(correlationId: string): void {
      const entry = pending.get(correlationId);
      if (!entry) return;
      pending.delete(correlationId);
      entry.resolve({ status: "cancelled" });
    },

    cancelAll(): void {
      for (const [, entry] of pending) {
        entry.resolve({ status: "cancelled" });
      }
      pending.clear();
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
