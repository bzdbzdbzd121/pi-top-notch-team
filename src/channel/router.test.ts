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
  it("updateMembers changes valid targets", () => {
    const sendToMember = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: ["analyzer"],
    });

    // Add new members
    router.updateMembers(["analyzer", "mover", "verifier"]);

    router.route(makeMsg({ from: "analyzer", to: "verifier", content: "Hi" }));
    expect(sendToMember).toHaveBeenCalledWith("verifier", expect.anything());
  });

  it("updateMembers with empty list clears targets", () => {
    const sendToMember = vi.fn();
    const router = createRouter({
      sendToMember,
      sendToTl: vi.fn(),
      memberNames: ["analyzer"],
    });

    router.updateMembers([]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    router.route(makeMsg({ from: "analyzer", to: "analyzer" }));
    // Should skip self and not send
    expect(sendToMember).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });


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
