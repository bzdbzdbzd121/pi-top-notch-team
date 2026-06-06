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
    const inFlight: number[] = [];
    const queue = createMessageQueue(async (msg) => {
      const idx = parseInt(msg.id.replace("msg-", ""));
      inFlight.push(idx);
      expect(inFlight).toHaveLength(1); // no concurrent processing
      await new Promise((r) => setTimeout(r, 10));
      inFlight.pop();
    });

    queue.enqueue(makeMsg({ id: "msg-1" }));
    queue.enqueue(makeMsg({ id: "msg-2" }));
    queue.enqueue(makeMsg({ id: "msg-3" }));
    await queue.drain();

    expect(inFlight).toHaveLength(0);
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
