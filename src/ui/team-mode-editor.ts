import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";

/**
 * Team-mode input border colouring.
 *
 * The editor renders its two horizontal borders with a single theme colour. In a
 * team session this subclass repaints them after the base render: the dashes get
 * a palette colour, everything else (scroll hints such as `↑ 3 more`, spaces)
 * keeps the accent colour.
 *
 * Phase 1 invariant: **only colours change, characters never do**. Painting per
 * column (instead of rebuilding the line) is what keeps scroll hints intact —
 * the old implementation took the hint text length as the whole line width and
 * emitted zero gradient dashes, so the border degraded to one accent-coloured
 * line as soon as the input overflowed the visible area.
 */

/** Border glyph used by the editor for its horizontal lines. */
const HORIZONTAL = "─";

/**
 * Six theme semantic colours, in cycle order. Phase 2 replaces this hard-cut
 * palette with a per-column interpolated gradient; the painting structure below
 * stays the same.
 */
const BORDER_COLORS = ["error", "syntaxKeyword", "warning", "accent", "syntaxType", "success"] as const;

export type BorderColorName = (typeof BORDER_COLORS)[number];

/**
 * A line counts as an editor border line when it consists solely of border
 * glyphs, blanks, scroll-hint characters (`↑ N more`, `↓ N more`, `...` / `…`)
 * and digits. Requiring at least one `─` keeps a blank content line (all
 * padding) from being mistaken for the bottom border — see `looksLikeBorder`.
 */
const BORDER_LINE_RE = /^[─\s↑↓mor.e…\d]+$/;

const SGR_RE = /\x1b\[[\d;]*m/g;

/** Drop SGR colour sequences; keeps the visible character sequence. */
function stripAnsi(text: string): string {
  return text.replace(SGR_RE, "");
}

/**
 * pi's shell-mode trigger, mirrored from `interactive-mode.js`:
 * `isBashMode = text.trimStart().startsWith("!")`.
 *
 * Implemented as a scan for the first non-whitespace character (no copy of a
 * potentially very long input). Missing text is treated as "not bash mode"
 * (fail-open: the border keeps its colour).
 */
export function isBashModeText(text: string | undefined | null): boolean {
  if (typeof text !== "string") return false;
  // `\S|$` = first non-whitespace char, or the end of the string.
  const firstContent = text.search(/\S|$/);
  return text[firstContent] === "!";
}

export interface BorderPaint {
  /** 0-based column → theme colour name for a border dash. */
  colorAtColumn: (column: number) => BorderColorName;
  /** Theme colour name for every non-dash character (scroll hint text, spaces). */
  labelColor: BorderColorName;
  /** Theme colouring function, usually `theme.fg`. */
  fg: (color: BorderColorName, text: string) => string;
}

/**
 * Colour a plain (uncoloured) border line column by column.
 *
 * Only foreground colours are emitted: adjacent characters sharing a colour are
 * merged into one run, and the line ends with `\x1b[39m` so the terminal's
 * foreground colour does not leak into whatever the TUI writes next.
 *
 * Implementation assumption: border lines contain single-column characters only
 * (dashes, blanks, `↑`/`↓`, ASCII hint text), so the character index equals the
 * column. If a future version seeds the border with wide characters (CJK/emoji),
 * columns must be accumulated with `visibleWidth` instead of counting characters.
 */
export function paintBorderLine(plain: string, paint: BorderPaint): string {
  if (plain.length === 0) return plain;

  let out = "";
  let runColor: BorderColorName | undefined;
  let runText = "";
  let column = 0;

  for (const ch of plain) {
    const color = ch === HORIZONTAL ? paint.colorAtColumn(column) : paint.labelColor;
    if (color !== runColor) {
      if (runText.length > 0 && runColor !== undefined) out += paint.fg(runColor, runText);
      runColor = color;
      runText = "";
    }
    runText += ch;
    column += 1;
  }
  if (runText.length > 0 && runColor !== undefined) out += paint.fg(runColor, runText);

  return `${out}\x1b[39m`;
}

export class TeamModeEditor extends CustomEditor {
  private teamModeActive = false;
  private fullTheme: Theme;

  constructor(tui: any, theme: any, keybindings: any, fullTheme: Theme) {
    super(tui, theme, keybindings);
    this.fullTheme = fullTheme;
  }

  setTeamMode(active: boolean): void {
    if (this.teamModeActive === active) return;
    this.teamModeActive = active;
    this.invalidate();
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.teamModeActive || lines.length < 2) return lines;

    // Bash mode: pi paints the border with its single-colour `bashMode` hint and
    // the text is not addressed to the agent. Hand the border back untouched.
    if (isBashModeText(this.currentText())) return lines;

    // Fail-open: colouring must never escape render(). pi calls its render loop
    // without a boundary guard, so a throw here terminates the whole process
    // (a theme rejecting a colour name — `theme.fg` throws on unknown colours —
    // is the realistic trigger). Lines are assigned only after every paint
    // succeeded, so a failure leaves the untouched base render: no half-painted
    // frame, just an uncoloured border. Same guard style as currentText().
    try {
      for (const [index, painted] of this.paintedBorders(lines, width)) lines[index] = painted;
    } catch {
      // Keep the base render.
    }

    return lines;
  }

  /**
   * Colour both horizontal borders.
   *
   * Returns `[lineIndex, paintedLine]` pairs instead of mutating in place so the
   * caller can discard a partial result when the theme throws.
   */
  private paintedBorders(lines: string[], width: number): Array<[number, string]> {
    const theme = this.fullTheme;
    const segmentWidth = Math.max(1, Math.ceil(width / BORDER_COLORS.length));
    const paint: BorderPaint = {
      colorAtColumn: (column) =>
        BORDER_COLORS[Math.min(BORDER_COLORS.length - 1, Math.floor(column / segmentWidth))]!,
      labelColor: "accent",
      fg: (color, text) => theme.fg(color, text),
    };

    // The first rendered line is always the top border, with or without a
    // scroll hint (`─── ↑ N more ───…`), so paint it directly.
    const painted: Array<[number, string]> = [[0, paintBorderLine(stripAnsi(lines[0]!), paint)]];

    // Bottom border: when autocomplete is visible the base editor appends the
    // candidate rows AFTER the bottom border, so scan upward for the first line
    // that is made of border glyphs only. (Rewriting the last line blindly
    // destroyed the last candidate on every keystroke.)
    const bottom = findBottomBorderLine(lines);
    if (bottom >= 0) painted.push([bottom, paintBorderLine(stripAnsi(lines[bottom]!), paint)]);

    return painted;
  }

  /** `getText()` must never break rendering: fall back to "unknown" (not bash). */
  private currentText(): string | undefined {
    try {
      return typeof this.getText === "function" ? this.getText() : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Tight border-line test: border glyphs only, and at least one dash. */
function looksLikeBorder(plain: string): boolean {
  return plain.includes(HORIZONTAL) && BORDER_LINE_RE.test(plain);
}

/**
 * Index of the bottom border line, or -1 when the render has none (starts at 1:
 * line 0 is the top border).
 */
function findBottomBorderLine(lines: string[]): number {
  for (let i = lines.length - 1; i >= 1; i--) {
    if (looksLikeBorder(stripAnsi(lines[i]!))) return i;
  }
  return -1;
}
