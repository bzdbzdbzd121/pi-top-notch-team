import { describe, it, expect, vi } from "vitest";
import { createRouter } from "./router";
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

describe("createRouter", () => {
  it("routes message to a specific member", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer", "mover"] });

    router.route(makeMsg({ from: "analyzer", to: "mover", content: "Hello mover" }));
    expect(sendToMember).toHaveBeenCalledWith("mover", expect.objectContaining({ content: "Hello mover" }));
    expect(sendToTl).not.toHaveBeenCalled();
  });

  it("routes message to TL", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer"] });

    router.route(makeMsg({ from: "mover", to: "tl", content: "Report" }));
    expect(sendToTl).toHaveBeenCalledWith(expect.objectContaining({ content: "Report" }));
    expect(sendToMember).not.toHaveBeenCalled();
  });

  it("routes message to all members", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer", "mover"] });

    router.route(makeMsg({ from: "tl", to: "all", content: "Update" }));
    expect(sendToMember).toHaveBeenCalledTimes(2);
    expect(sendToMember).toHaveBeenCalledWith("analyzer", expect.objectContaining({ content: "Update" }));
    expect(sendToMember).toHaveBeenCalledWith("mover", expect.objectContaining({ content: "Update" }));
  });

  it("does not send message to self (from === to)", () => {
    const sendToMember = vi.fn();
    const sendToTl = vi.fn();
    const router = createRouter({ sendToMember, sendToTl, memberNames: ["analyzer"] });

    router.route(makeMsg({ from: "analyzer", to: "analyzer" }));
    expect(sendToMember).not.toHaveBeenCalled();
  });

  it("logs warning for unknown target", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const router = createRouter({
      sendToMember: vi.fn(),
      sendToTl: vi.fn(),
      memberNames: ["analyzer"],
    });

    router.route(makeMsg({ from: "analyzer", to: "nonexistent" }));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("nonexistent")
    );
    warnSpy.mockRestore();
  });
});
