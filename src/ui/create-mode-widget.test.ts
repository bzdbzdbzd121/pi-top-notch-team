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
  return await import("./create-mode-widget");
}

describe("createCreateModeWidget", () => {
  it("should install widget with correct title and key", async () => {
    const { createCreateModeWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createCreateModeWidget();
    widget.install(ui, theme);

    expect(setWidget).toHaveBeenCalledWith("team-create-mode", expect.any(Array));
    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("CREATE MODE");
  });

  it("should uninstall widget and clear the widget", async () => {
    const { createCreateModeWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createCreateModeWidget();
    widget.install(ui, theme);
    widget.uninstall();

    expect(setWidget).toHaveBeenLastCalledWith("team-create-mode", undefined);
  });

  it("should include hint text about describing team", async () => {
    const { createCreateModeWidget } = await loadModule();
    const setWidget = vi.fn();
    const ui = { setWidget };
    const theme = createMockTheme();

    const widget = createCreateModeWidget();
    widget.install(ui, theme);

    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines[1]).toContain("描述");
    expect(lines[1]).toContain("团队");
  });

  it("should not throw when uninstall is called without install", async () => {
    const { createCreateModeWidget } = await loadModule();
    const widget = createCreateModeWidget();

    expect(() => widget.uninstall()).not.toThrow();
  });

  it("should handle install with throwing setWidget", async () => {
    const { createCreateModeWidget } = await loadModule();
    const ui = {
      setWidget: vi.fn().mockImplementation(() => {
        throw new Error("UI gone");
      }),
    };
    const theme = createMockTheme();

    const widget = createCreateModeWidget();
    expect(() => widget.install(ui, theme)).not.toThrow();
  });
});
