import type { TeamMessage, TeamMessageHandler } from "./types";

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
  handler: TeamMessageHandler
): MessageQueue {
  const queue: TeamMessage[] = [];
  let processing: Promise<void> | null = null;
  let stopped = false;

  async function processAll(): Promise<void> {
    while (queue.length > 0 && !stopped) {
      const msg = queue.shift()!;
      try {
        await handler(msg);
      } catch {
        // Handler error — continue with next message
      }
    }
  }

  function ensureProcessing(): void {
    if (processing || stopped) return;
    // Use queueMicrotask to defer processing so enqueue returns first
    queueMicrotask(() => {
      if (processing || stopped) return;
      processing = processAll().finally(() => {
        processing = null;
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
      const drainLoop = async (): Promise<void> => {
        // Wait for any in-flight processing
        if (processing) {
          await processing;
        }
        // If more items were added during processing, drain again
        if (queue.length > 0 && !stopped) {
          await new Promise((r) => setTimeout(r, 5));
          return drainLoop();
        }
      };
      return drainLoop();
    },

    stop(): void {
      stopped = true;
    },
  };
}
