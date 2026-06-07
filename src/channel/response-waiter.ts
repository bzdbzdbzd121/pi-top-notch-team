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

  /** Cancel all pending waits (e.g. on /team stop). */
  cancelAll(): void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * Create a ResponseWaiter that manages pending "send and wait" requests,
 * keyed by correlation ID.
 */
export function createResponseWaiter(): ResponseWaiter {
  const pending = new Map<string, PendingEntry>();

  return {
    waitForResponse(
      correlationId: string,
      timeoutMs?: number
    ): Promise<WaitResult> {
      const effectiveTimeout = Math.min(
        timeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS
      );

      return new Promise<WaitResult>((resolve) => {
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
      if (!entry) return false;

      clearTimeout(entry.timeout);
      pending.delete(correlationId);
      entry.resolve({
        status: "response",
        from,
        content,
        subject,
      });
      return true;
    },

    cancelAll(): void {
      for (const [, entry] of pending) {
        clearTimeout(entry.timeout);
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
