import { describe, it, expect } from "vitest";
import { createTlWaitGate } from "./tl-wait-gate";
import type { TeamMessage } from "./types";

function msg(id: string, from = "worker"): TeamMessage {
  return { id, from, to: "tl", content: `content-${id}`, timestamp: 1 };
}

describe("createTlWaitGate", () => {
  it("is inactive by default (no wait in flight)", () => {
    const gate = createTlWaitGate();
    expect(gate.isWaitActive()).toBe(false);
  });

  it("beginWait/endWait toggle the active state", () => {
    const gate = createTlWaitGate();
    gate.beginWait();
    expect(gate.isWaitActive()).toBe(true);
    gate.endWait();
    expect(gate.isWaitActive()).toBe(false);
  });

  it("counts concurrent waits (inactive only when all ended)", () => {
    const gate = createTlWaitGate();
    gate.beginWait();
    gate.beginWait();
    gate.endWait();
    expect(gate.isWaitActive()).toBe(true);
    gate.endWait();
    expect(gate.isWaitActive()).toBe(false);
  });

  it("never goes negative on unbalanced endWait", () => {
    const gate = createTlWaitGate();
    gate.endWait();
    gate.beginWait();
    gate.endWait();
    expect(gate.isWaitActive()).toBe(false);
  });

  it("drain returns buffered messages FIFO and empties the buffer", () => {
    const gate = createTlWaitGate();
    gate.buffer(msg("a"));
    gate.buffer(msg("b", "analyst"));
    const first = gate.drain();
    expect(first.map((m) => m.id)).toEqual(["a", "b"]);
    expect(first[1].from).toBe("analyst");
    expect(gate.drain()).toEqual([]);
  });
});
