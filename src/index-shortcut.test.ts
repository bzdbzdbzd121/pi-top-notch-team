import { it, expect, vi } from "vitest";

// ── Integration smoke: index.ts default export wiring ──────
// Verifies the Member Inspector shortcut is registered at extension init
// and that the handler is gated on an active team session (decision #7:
// no reaction outside a team session).

function makeMockPi() {
  return {
    registerShortcut: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn(),
    getActiveTools: () => [],
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
  };
}

it("index.ts default export registers alt+t shortcut", async () => {
  const mod = await import("../index");
  const pi = makeMockPi();
  mod.default(pi as any);

  expect(pi.registerShortcut).toHaveBeenCalledWith(
    "alt+t",
    expect.objectContaining({ handler: expect.any(Function) })
  );
});

it("shortcut handler does nothing when no team session is active", async () => {
  const mod = await import("../index");
  const pi = makeMockPi();
  mod.default(pi as any);

  const { handler } = pi.registerShortcut.mock.calls.find(
    ([k]) => k === "alt+t"
  )![1];

  const ctx = { ui: { custom: vi.fn() } };
  await handler(ctx);
  // No active session → overlay must not open
  expect(ctx.ui.custom).not.toHaveBeenCalled();
});
