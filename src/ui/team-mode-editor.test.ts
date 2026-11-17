/**
 * TeamModeEditor border painting (plan phase 1: structure + bash mode).
 *
 * Two defects / behaviours are pinned here:
 *  - Borders are painted per column instead of rebuilt from scratch. Before
 *    phase 1 a scroll-hint line (`─×15 + " ↑ 3 more " + ─×…`) matched the
 *    "border" regex as a whole, so the hint length was taken as the full line
 *    width and the dash side received zero colour: the whole border degraded
 *    to one accent-coloured line.
 *  - Bash mode (`!cmd`) hands the border back to pi: its single-colour
 *    `bashMode` hint must reach the terminal untouched.
 *
 * The base editor is mocked with a render that mirrors pi-tui's editor output
 * (coloured top border, text lines, coloured bottom border, autocomplete rows
 * appended last). `visibleWidth` is the REAL implementation on purpose: the
 * previous test mocked it as `s.length`, which hid width bugs.
 */
import { describe, it, expect, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

vi.mock("@earendil-works/pi-coding-agent", () => {
  const stripAnsiLocal = (text: string) => text.replace(/\x1b\[[\d;]*m/g, "");
  const FG = { border: "\x1b[90m", bash: "\x1b[35m", reset: "\x1b[39m" };

  class CustomEditor {
    text = "";
    autocompleteLines: string[] = [];
    /** Plain (uncoloured) text of the top/bottom border line; default = all dashes. */
    topBorder: string | undefined;
    bottomBorder: string | undefined;

    getText(): string {
      return this.text;
    }
    setText(text: string): void {
      this.text = text;
    }
    invalidate(): void {}

    render(width: number): string[] {
      // pi's InteractiveMode.updateEditorBorderColor() swaps the editor's
      // borderColor for the single-colour bashMode colour while shell mode is on.
      const bashMode = this.text.trimStart().startsWith("!");
      const borderColor = (s: string) => `${bashMode ? FG.bash : FG.border}${s}${FG.reset}`;
      const border = "─".repeat(width);
      const lines = [borderColor(this.topBorder ?? border)];
      for (const line of this.text.split("\n")) {
        const pad = Math.max(0, width - stripAnsiLocal(line).length);
        lines.push(line + " ".repeat(pad));
      }
      lines.push(borderColor(this.bottomBorder ?? border));
      lines.push(...this.autocompleteLines);
      return lines;
    }
  }

  // `__baseEditorForTest` lets the suite capture the untouched base render so
  // "byte-identical" claims are checked against the base, not against itself.
  return { CustomEditor, __baseEditorForTest: CustomEditor };
});

import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { TeamModeEditor, isBashModeText, paintBorderLine } from "./team-mode-editor";
import type { BorderColorName } from "./team-mode-editor";
import type { Theme } from "@earendil-works/pi-coding-agent";

const BaseEditor = (piCodingAgent as unknown as { __baseEditorForTest: { prototype: { render(width: number): string[] } } })
  .__baseEditorForTest;

/** 256-colour prefixes, deliberately WITHOUT a trailing reset: the editor must emit it. */
const FG: Record<string, string> = {
  error: "\x1b[38;5;203m",
  syntaxKeyword: "\x1b[38;5;141m",
  warning: "\x1b[38;5;214m",
  accent: "\x1b[38;5;75m",
  syntaxType: "\x1b[38;5;114m",
  success: "\x1b[38;5;78m",
};

function makeTheme(): Theme {
  return {
    fg: (color: string, text: string) => `${FG[color] ?? "\x1b[38;5;250m"}${text}`,
    getFgAnsi: (color: string) => FG[color],
    getColorMode: () => "truecolor",
  } as unknown as Theme;
}

interface EditorInit {
  text?: string;
  autocompleteLines?: string[];
  topBorder?: string;
  bottomBorder?: string;
}

function createEditor(init: EditorInit = {}): TeamModeEditor {
  const editor = new TeamModeEditor({} as never, {} as never, {} as never, makeTheme());
  if (init.text !== undefined) editor.setText(init.text);
  const internals = editor as unknown as { autocompleteLines: string[]; topBorder?: string; bottomBorder?: string };
  if (init.autocompleteLines) internals.autocompleteLines = init.autocompleteLines;
  if (init.topBorder !== undefined) internals.topBorder = init.topBorder;
  if (init.bottomBorder !== undefined) internals.bottomBorder = init.bottomBorder;
  editor.setTeamMode(true);
  return editor;
}

/** Untouched base-class render of the very same instance (state is shared). */
function baseRender(editor: TeamModeEditor, width: number): string[] {
  return BaseEditor.prototype.render.call(editor, width);
}

interface Cell {
  ansi: string;
  ch: string;
}

/** Split a rendered line into per-character cells carrying the SGR active for that char. */
function cells(line: string): Cell[] {
  const sgr = /\x1b\[[\d;]*m/g;
  const out: Cell[] = [];
  let ansi = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = sgr.exec(line)) !== null) {
    for (const ch of line.slice(cursor, match.index)) out.push({ ansi, ch });
    ansi = match[0];
    cursor = match.index + match[0].length;
  }
  for (const ch of line.slice(cursor)) out.push({ ansi, ch });
  return out;
}

const plainOf = (line: string): string =>
  cells(line)
    .map((cell) => cell.ch)
    .join("");

/** Distinct SGR colours used by dash characters on this line. */
const dashColors = (line: string): string[] => [
  ...new Set(
    cells(line)
      .filter((cell) => cell.ch === "─")
      .map((cell) => cell.ansi),
  ),
];

/** ANSI active for every character of `label` on this line (assumes label appears once). */
function labelColors(line: string, label: string): string[] {
  const perChar = cells(line);
  const plain = perChar.map((cell) => cell.ch).join("");
  const start = plain.indexOf(label);
  expect(start).toBeGreaterThanOrEqual(0);
  return perChar.slice(start, start + label.length).map((cell) => cell.ansi);
}

describe("isBashModeText", () => {
  it.each([
    ["!ls", true],
    ["  !ls", true],
    ["\n!ls", true],
    [" \t\n !ls", true],
    ["!", true],
    ["  !", true],
    ["", false],
    ["   ", false],
    ["ls", false],
    ["a!b", false],
    ["a\n!ls", false],
    ["  a !ls", false],
    ["echo ! ls", false],
  ])("%j → %s", (text, expected) => {
    expect(isBashModeText(text)).toBe(expected);
  });

  it("treats missing text as non-bash (fail-open, border keeps its colour)", () => {
    expect(isBashModeText(undefined)).toBe(false);
    expect(isBashModeText(null)).toBe(false);
  });

  it("handles very long inputs without copying the whole string", () => {
    expect(isBashModeText(`${" ".repeat(50_000)}!ls`)).toBe(true);
    expect(isBashModeText("x".repeat(50_000))).toBe(false);
  });
});

describe("paintBorderLine", () => {
  const paint = (colors: Record<number, BorderColorName>) => ({
    colorAtColumn: (column: number) => colors[column] ?? "accent",
    labelColor: "accent" as const,
    fg: (color: BorderColorName, text: string) => `${FG[color]}${text}`,
  });

  it("returns an empty line untouched", () => {
    expect(paintBorderLine("", paint({}))).toBe("");
  });

  it("merges adjacent characters that share a colour into one run", () => {
    const line = paintBorderLine("────", paint({ 0: "error", 1: "error", 2: "success", 3: "success" }));
    expect(plainOf(line)).toBe("────");
    expect(line.match(/\x1b\[38;5;/g)?.length).toBe(2);
    expect(line.trimEnd().endsWith("\x1b[39m")).toBe(true);
  });

  it("uses the label colour for non-dash characters", () => {
    const line = paintBorderLine("─ ↑ 3 more ─", paint({}));
    expect(plainOf(line)).toBe("─ ↑ 3 more ─");
    expect(labelColors(line, " ↑ 3 more ")).toEqual(Array(10).fill(FG.accent));
  });
});

describe("TeamModeEditor.render — width", () => {
  it.each([0, 1, 2, 3, 5, 20, 80, 137, 201])("keeps visibleWidth === %i for every line", (width) => {
    const lines = createEditor().render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(width);
    }
    expect(plainOf(lines[0]!)).toBe("─".repeat(width));
    expect(plainOf(lines[lines.length - 1]!)).toBe("─".repeat(width));
  });
});

describe("TeamModeEditor.render — scroll hints", () => {
  it("keeps gradient on the dash sides of a centred hint (width 120)", () => {
    // pi 1.5.2 scroll border: ─×15 + " ↑ 3 more " + ─×95
    const topBorder = `${"─".repeat(15)} ↑ 3 more ${"─".repeat(95)}`;
    expect(visibleWidth(topBorder)).toBe(120);
    const lines = createEditor({ text: "long input", topBorder }).render(120);

    expect(plainOf(lines[0]!)).toBe(topBorder);
    expect(visibleWidth(lines[0]!)).toBe(120);
    expect(dashColors(lines[0]!).length).toBeGreaterThanOrEqual(2);
    expect(labelColors(lines[0]!, " ↑ 3 more ")).toEqual(Array(10).fill(FG.accent));
  });

  it("handles a narrow-screen ellipsis hint (width 20)", () => {
    // Narrow terminals fall back to an ellipsis instead of a full dash run.
    const topBorder = `${"─".repeat(6)} ↑ 12 more ...`;
    expect(visibleWidth(topBorder)).toBe(20);
    const lines = createEditor({ text: "long input", topBorder }).render(20);

    expect(plainOf(lines[0]!)).toBe(topBorder);
    expect(visibleWidth(lines[0]!)).toBe(20);
    expect(dashColors(lines[0]!).length).toBeGreaterThanOrEqual(2);
    expect(labelColors(lines[0]!, " ↑ 12 more ")).toEqual(Array(11).fill(FG.accent));
  });

  it("paints a scrolled bottom border (↓ N more) too", () => {
    const bottomBorder = `${"─".repeat(6)} ↓ 4 more ${"─".repeat(95)}`;
    const lines = createEditor({ text: "long input", bottomBorder }).render(120);
    const last = lines[lines.length - 1]!;
    expect(plainOf(last)).toBe(bottomBorder);
    expect(dashColors(last).length).toBeGreaterThanOrEqual(2);
    expect(labelColors(last, " ↓ 4 more ")).toEqual(Array(10).fill(FG.accent));
  });
});

describe("TeamModeEditor.render — plain borders", () => {
  it("paints both borders with several colours and no character changes", () => {
    const lines = createEditor({ text: "/team s" }).render(80);
    const top = lines[0]!;
    const bottom = lines[lines.length - 1]!;

    expect(plainOf(top)).toBe("─".repeat(80));
    expect(plainOf(bottom)).toBe("─".repeat(80));
    expect(dashColors(top).length).toBeGreaterThanOrEqual(2);
    expect(dashColors(bottom).length).toBeGreaterThanOrEqual(2);
    expect(lines[1]).toBe("/team s".padEnd(80));
  });

  it("ends painted lines with \\x1b[39m and never emits \\x1b[0m", () => {
    const lines = createEditor({ text: "/team s" }).render(80);
    for (const line of [lines[0]!, lines[lines.length - 1]!]) {
      expect(line.endsWith("\x1b[39m")).toBe(true);
    }
    expect(lines.join("\n")).not.toContain("\x1b[0m");
  });
});

describe("TeamModeEditor.render — autocomplete", () => {
  it("does NOT destroy autocomplete rows and colours the border above them", () => {
    const candidates = [
      "  stop — 终止团队会话",
      "  status — 查看当前团队状态",
      "  setting — 团队设置（成员默认模型）",
    ];
    const lines = createEditor({ text: "/team s", autocompleteLines: candidates }).render(20);

    for (const candidate of candidates) {
      expect(lines.filter((line) => line === candidate)).toHaveLength(1);
    }
    // Structure: [top, text, bottom, ...candidates]
    expect(plainOf(lines[2]!)).toBe("─".repeat(20));
    expect(dashColors(lines[2]!).length).toBeGreaterThanOrEqual(1);
    expect(lines.slice(3)).toEqual(candidates);
  });

  it("leaves a single candidate row untouched (legacy regression)", () => {
    const lines = createEditor({ text: "/team s", autocompleteLines: ["  stop — 终止团队会话"] }).render(20);
    expect(lines[2]!.endsWith("\x1b[39m")).toBe(true);
    expect(dashColors(lines[2]!).length).toBeGreaterThanOrEqual(1);
    expect(lines[lines.length - 1]).toBe("  stop — 终止团队会话");
  });
});

describe("TeamModeEditor.render — bash mode", () => {
  it.each(["!ls", "  !ls", "\n!ls", " \t\n !ls"])("%j passes the pi border through untouched", (text) => {
    const editor = createEditor({ text });
    const lines = editor.render(120);

    expect(lines).toEqual(baseRender(editor, 120));
    // Sanity: pi really painted its single bashMode colour, and no gradient leaked in.
    expect(lines[0]).toContain("\x1b[35m");
    expect(lines.join("\n")).not.toContain("\x1b[38;5;");
  });

  it("passes a bash-mode scroll hint through untouched", () => {
    const topBorder = `${"─".repeat(15)} ↑ 3 more ${"─".repeat(95)}`;
    const editor = createEditor({ text: "!paste-script", topBorder });
    const lines = editor.render(120);
    expect(lines).toEqual(baseRender(editor, 120));
    expect(lines.join("\n")).not.toContain("\x1b[38;5;");
  });

  it.each(["a!b", "a\n!ls", "  a !ls"])("%j keeps the gradient (leading text is not bash mode)", (text) => {
    const lines = createEditor({ text }).render(40);
    expect(lines[0]).toContain("\x1b[38;5;");
    expect(plainOf(lines[0]!)).toBe("─".repeat(40));
  });
});

describe("TeamModeEditor.render — inactive", () => {
  it("is byte-identical to the base render outside team mode", () => {
    const editor = createEditor({
      text: "/team s",
      autocompleteLines: ["  stop — 终止团队会话", "  status — 查看当前团队状态"],
    });
    editor.setTeamMode(false);
    expect(editor.render(40)).toEqual(baseRender(editor, 40));
  });

  it("is byte-identical to the base render for scroll hints outside team mode", () => {
    const editor = createEditor({
      text: "many\nlines",
      topBorder: `${"─".repeat(15)} ↑ 3 more ${"─".repeat(95)}`,
      bottomBorder: `${"─".repeat(6)} ↓ 4 more ${"─".repeat(95)}`,
    });
    editor.setTeamMode(false);
    expect(editor.render(120)).toEqual(baseRender(editor, 120));
  });

  it("does not paint anything before team mode is enabled", () => {
    const editor = new TeamModeEditor({} as never, {} as never, {} as never, makeTheme());
    editor.setText("/team s");
    expect(editor.render(40)).toEqual(baseRender(editor, 40));
  });
});

describe("TeamModeEditor.render — timers", () => {
  it("creates no timers when entering and leaving team mode", () => {
    vi.useFakeTimers();
    try {
      const editor = createEditor({ text: "/team s" });
      editor.render(80);
      editor.setTeamMode(false);
      editor.render(80);
      editor.setTeamMode(true);
      editor.render(80);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
