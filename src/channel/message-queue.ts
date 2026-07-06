import type { TeamMessage, TeamMessageHandler } from "./types";

export interface MessageQueueOptions {
  /** Called when the message handler throws. Default: console.warn. */
  onHandlerError?: (msg: TeamMessage, error: Error) => void;
}

export interface MessageQueue {
  enqueue(msg: TeamMessage): void;
  length(): number;
  drain(): Promise<void>;
  stop(): void;
}

/**
 * Create a serial FIFO message queue.
 * Messages are processed one at a time, in FIFO order.
 */
export function createMessageQueue(
  handler: TeamMessageHandler,
  options?: MessageQueueOptions
): MessageQueue {
  const queue: TeamMessage[] = [];
  let processing: Promise<void> | null = null;
  let stopped = false;
  let drainResolve: (() => void) | null = null;

  /** Notify any waiting drain() that processing finished or queue changed. */
  function notifyDrain(): void {
    if (drainResolve) {
      const r = drainResolve;
      drainResolve = null;
      r();
    }
  }

  async function processAll(): Promise<void> {
    while (queue.length > 0 && !stopped) {
      const msg = queue.shift()!;
      try {
        await handler(msg);
      } catch (err) {
        options?.onHandlerError?.(msg, err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  function finalizeProcessing(): void {
    processing = null;
    // Notify drain that a processing round completed
    notifyDrain();
    // If more items were queued during processing, restart automatically
    if (queue.length > 0 && !stopped) {
      ensureProcessing();
    }
  }

  function ensureProcessing(): void {
    if (processing || stopped) return;
    // Use queueMicrotask to defer processing so enqueue returns first
    queueMicrotask(() => {
      if (processing || stopped) return;
      processing = processAll().finally(() => {
        finalizeProcessing();
      });
    });
  }

  return {
    enqueue(msg: TeamMessage): void {
      queue.push(msg);
      ensureProcessing();
    },

    length(): number {
      return queue.length;
    },

    drain(): Promise<void> {
      if (stopped) return Promise.resolve();

      const drainLoop = async (): Promise<void> => {
        // Wait for any in-flight processing
        if (processing) {
          await processing;
        }
        if (stopped) return;

        // Iteratively wait for processing cycles until queue is empty
        while (queue.length > 0 && !stopped) {
          await new Promise<void>((resolve) => {
            drainResolve = resolve;
            // Re-check: queue may have been drained since our last check
            if (queue.length === 0 || stopped) {
              drainResolve = null;
              resolve();
            }
          });
        }
      };
      return drainLoop();
    },

    stop(): void {
      stopped = true;
      // Wake up any waiting drain() so it can return
      notifyDrain();
    },
  };
}
