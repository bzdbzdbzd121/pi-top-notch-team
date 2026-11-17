import { CustomEditor, type Theme } from "@earendil-works/pi-coding-agent";
import {
  BORDER_DASH,
  DEFAULT_GRADIENT_STOPS,
  NEUTRAL_RGB,
  paintBorderLine,
  parseAnsiFg,
  type PaintContext,
} from "./border-gradient";

/**
 * Team-mode input border colouring.
 *
 * The editor renders its two horizontal borders with a single theme colour. In a
 * team session this subclass repaints them after the base render: the dashes take
 * a gradient computed from six theme semantic colours, everything else (scroll
 * hints such as `↑ 3 more`, blanks) keeps the accent colour.
 *
 * Invariant: **only colours change, characters never do**. Painting per column
 * (instead of rebuilding the line) is what keeps scroll hints intact — an earlier
 * implementation took the hint text length as the whole line width and emitted
 * zero gradient dashes, so the border degraded to one accent-coloured line as
 * soon as the input overflowed the visible area.
 *
 * Phase 2 paints a static gradient (cycle position 0); phase 3 will drive the
 * position from the clock. No timers exist in this file.
 */

/** Border glyph used by the editor for its horizontal lines. */
const HORIZONTAL = BORDER_DASH;

/**
 * Six theme semantic colours, in cycle order: the gradient anchors. Each render
 * re-reads them from the theme, so switching themes needs no cache invalidation.
 */
const BORDER_COLORS = ["error", "syntaxKeyword", "warning", "accent", "syntaxType", "success"] as const;

/**
 * A line counts as an editor border line when it consists solely of border
 * glyphs, blanks, scroll-hint characters (`↑ N more`, `↓ N more`, `...` / `…`)
 * and digits. Requiring at least one dash keeps a blank content line (all
 * padding) from being mistaken for the bottom border — see `looksLikeBorder`.
 * The dash comes from `BORDER_DASH` so painting and detection cannot drift.
 */
const BORDER_LINE_RE = new RegExp(`^[${HORIZONTAL}\\s↑↓mor.e…\\d]+$`);

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
    // (`theme.getFgAnsi` throws on an unknown colour name, for instance). Lines
    // are assigned only after every paint succeeded, so a failure leaves the
    // untouched base render: no half-painted frame, just an uncoloured border.
    // Same guard style as currentText().
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
    // One colour source for both parsing and emission: `getColorMode()` decides
    // whether `getFgAnsi` hands back `38;2;` or `38;5;`, and the gradient must
    // emit the same form or a truecolor anchor would be printed as a 256 index.
    const mode = theme.getColorMode();
    const anchors = BORDER_COLORS.map((name) => parseAnsiFg(theme.getFgAnsi(name)) ?? NEUTRAL_RGB);
    const context: PaintContext = {
      width,
      // Static in phase 2; phase 3 feeds `(now / CYCLE_MS) % 1` in here.
      phase: 0,
      anchors,
      mode,
      // Raw theme sequence, so the hint keeps the theme's own encoding even when
      // it cannot be parsed into RGB (e.g. a token set to the terminal default).
      labelAnsi: theme.getFgAnsi("accent"),
      stops: DEFAULT_GRADIENT_STOPS,
    };

    // The first rendered line is always the top border, with or without a
    // scroll hint (`─── ↑ N more ───…`), so paint it directly.
    const painted: Array<[number, string]> = [[0, paintBorderLine(stripAnsi(lines[0]!), context)]];

    // Bottom border: when autocomplete is visible the base editor appends the
    // candidate rows AFTER the bottom border, so scan upward for the first line
    // that is made of border glyphs only. (Rewriting the last line blindly
    // destroyed the last candidate on every keystroke.)
    const bottom = findBottomBorderLine(lines);
    if (bottom >= 0) painted.push([bottom, paintBorderLine(stripAnsi(lines[bottom]!), context)]);

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
