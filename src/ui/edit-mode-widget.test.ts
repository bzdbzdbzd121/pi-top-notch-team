import { describe, it, expect, vi } from "vitest";

// ── Mock pi-tui ────────────────────────────────────────────

vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: (text: string) => text.length,
}));

// ── Helpers ────────────────────────────────────────────────

function createMockTheme() {
  return {
    fg: vi.fn((_color: string, text: string) => text),
  };
}

async function loadModule() {
  return await import("./edit-mode-widget");
}

describe("createEditModeWidget", () => {
  it("should install widget with correct title", async () => {
    const { createEditModeWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createEditModeWidget("test-team");
    widget.install(ui, theme);

    expect(setWidget).toHaveBeenCalledWith("team-edit-mode", expect.any(Array));
    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("EDIT MODE");
    expect(lines[0]).toContain("test-team");
  });

  it("should uninstall widget and remove it from UI", async () => {
    const { createEditModeWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createEditModeWidget("test-team");
    widget.install(ui, theme);
    widget.uninstall();

    expect(setWidget).toHaveBeenLastCalledWith("team-edit-mode", undefined);
  });

  it("should include hint about edit mode usage", async () => {
    const { createEditModeWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createEditModeWidget("test-team");
    widget.install(ui, theme);

    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines[1]).toContain("自然语言");
    expect(lines[1]).toContain("/team done");
  });

  it("should not throw when uninstall is called without install", async () => {
    const { createEditModeWidget } = await loadModule();
    const widget = createEditModeWidget("test-team");

    expect(() => widget.uninstall()).not.toThrow();
  });

  it("should handle install with throwing setWidget", async () => {
    const { createEditModeWidget } = await loadModule();
    const ui = {
      setWidget: vi.fn().mockImplementation(() => {
        throw new Error("UI gone");
      }),
    };
    const theme = createMockTheme();

    const widget = createEditModeWidget("test-team");
    expect(() => widget.install(ui, theme)).not.toThrow();
  });
});
