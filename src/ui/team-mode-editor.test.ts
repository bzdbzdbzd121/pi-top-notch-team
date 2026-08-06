/**
 * Tests for TeamModeEditor.render border rewriting.
 *
 * Regression: when the autocomplete list is visible, the base Editor appends
 * suggestion rows AFTER the bottom border. TeamModeEditor used to blindly
 * rewrite the LAST rendered line as the bottom border, destroying the last
 * autocomplete item on every keystroke (candidates vanished one by one while
 * typing "/team s" → "/team st" → "/team sto").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock pi-tui Editor base class before importing TeamModeEditor ---
// We simulate the base render() output: top border, text, bottom border,
// then optional autocomplete rows appended at the end.
vi.mock("@earendil-works/pi-coding-agent", () => {
  class CustomEditor {
    autocompleteLines: string[] = [];
    render(_width: number): string[] {
      const base = ["─".repeat(20), "/team s", "─".repeat(20)];
      return [...base, ...this.autocompleteLines];
    }
    invalidate() {}
  }
  return { CustomEditor };
});
vi.mock("@earendil-works/pi-tui", () => ({
  visibleWidth: (s: string) => s.length,
}));

import { TeamModeEditor } from "./team-mode-editor";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme = { fg: (_color: string, text: string) => `<fg>${text}</fg>` };

function createEditor(autocompleteLines: string[] = []): TeamModeEditor {
  const editor = new TeamModeEditor({} as any, {} as any, {} as any, theme as unknown as Theme);
  (editor as any).autocompleteLines = autocompleteLines;
  editor.setTeamMode(true);
  return editor;
}

describe("TeamModeEditor.render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rewrites top and bottom borders when no autocomplete is visible", () => {
    const editor = createEditor([]);
    const lines = editor.render(20);
    expect(lines[0]).toContain("<fg>"); // top border rainbow-colored
    expect(lines[lines.length - 1]).toContain("<fg>"); // bottom border rainbow-colored
    expect(lines[1]).toBe("/team s"); // text untouched
  });

  it("does NOT destroy the last autocomplete row", () => {
    const editor = createEditor(["  stop — 终止团队会话", "  status — 查看当前团队状态", "  setting — 团队设置（成员默认模型）"]);
    const lines = editor.render(20);
    // All three autocomplete rows must survive verbatim
    expect(lines).toContain("  stop — 终止团队会话");
    expect(lines).toContain("  status — 查看当前团队状态");
    expect(lines).toContain("  setting — 团队设置（成员默认模型）");
    // None of the autocomplete rows may be replaced by a border
    const survivors = lines.filter((l) => l.includes("setting"));
    expect(survivors.length).toBe(1);
  });

  it("still rainbow-colors the real bottom border when autocomplete is visible", () => {
    const editor = createEditor(["  stop — 终止团队会话"]);
    const lines = editor.render(20);
    // Structure: [top, text, bottom(border), autocomplete-row]
    // The bottom border (index 2) should be rainbow-colored
    expect(lines[2]).toContain("<fg>");
    // The autocomplete row (last) must remain untouched
    expect(lines[lines.length - 1]).toBe("  stop — 终止团队会话");
  });

  it("leaves lines untouched when team mode is inactive", () => {
    const editor = createEditor(["  stop"]);
    editor.setTeamMode(false);
    const lines = editor.render(20);
    expect(lines[0]).toBe("─".repeat(20));
    expect(lines[lines.length - 1]).toBe("  stop");
  });
});
