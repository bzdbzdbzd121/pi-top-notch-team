import { describe, it, expect, vi } from "vitest";
import { createMessageQueue } from "./message-queue";
import type { TeamMessage } from "./types";

function makeMsg(overrides?: Partial<TeamMessage>): TeamMessage {
  return {
    id: "msg-1",
    from: "analyzer",
    to: "mover",
    content: "Hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("createMessageQueue", () => {
  it("processes messages in FIFO order", async () => {
    const processed: string[] = [];
    const queue = createMessageQueue(async (msg) => {
      processed.push(msg.id);
    });

    queue.enqueue(makeMsg({ id: "msg-1" }));
    queue.enqueue(makeMsg({ id: "msg-2" }));
    queue.enqueue(makeMsg({ id: "msg-3" }));
    await queue.drain();

    expect(processed).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("processes one message at a time (serial)", async () => {
    const processedOrder: string[] = [];
    let releaseNext: (() => void) | null = null;

    const queue = createMessageQueue(async (msg) => {
      processedOrder.push(msg.id);
      // Block until the test explicitly releases this handler
      await new Promise<void>((resolve) => {
        releaseNext = resolve;
      });
    });

    queue.enqueue(makeMsg({ id: "msg-1" }));
    queue.enqueue(makeMsg({ id: "msg-2" }));
    queue.enqueue(makeMsg({ id: "msg-3" }));

    // Give microtask a chance to start processing msg-1
    await new Promise((r) => setTimeout(r, 1));
    expect(processedOrder).toEqual(["msg-1"]);

    // Release msg-1, msg-2 should start
    releaseNext!();
    await new Promise((r) => setTimeout(r, 1));
    expect(processedOrder).toEqual(["msg-1", "msg-2"]);

    // Release msg-2, msg-3 should start
    releaseNext!();
    await new Promise((r) => setTimeout(r, 1));
    expect(processedOrder).toEqual(["msg-1", "msg-2", "msg-3"]);

    // Release msg-3
    releaseNext!();

    await queue.drain();
    expect(processedOrder).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("reports queue length", () => {
    const queue = createMessageQueue(async () => {});
    expect(queue.length()).toBe(0);

    queue.enqueue(makeMsg({ id: "msg-1" }));
    expect(queue.length()).toBe(1);

    queue.enqueue(makeMsg({ id: "msg-2" }));
    expect(queue.length()).toBe(2);
  });

  it("allows handler to throw without crashing the queue", async () => {
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("Handler error"))
      .mockResolvedValueOnce(undefined);

    const queue = createMessageQueue(handler);
    queue.enqueue(makeMsg({ id: "msg-1" }));
    queue.enqueue(makeMsg({ id: "msg-2" }));
    await queue.drain();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not auto-process after stop()", async () => {
    const handler = vi.fn();
    const queue = createMessageQueue(handler);

    queue.stop();
    queue.enqueue(makeMsg({ id: "msg-1" }));

    // Give it a tick
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
  });
});
