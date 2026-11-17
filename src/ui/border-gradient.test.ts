/**
 * Colour maths for the team-mode border gradient (plan phase 2).
 *
 * Everything here is pure: no IO, no timers, no theme access. The editor hands
 * in RGB anchors (resolved from `theme.getFgAnsi` on every render) plus the
 * terminal colour mode, and gets ANSI foreground sequences back.
 *
 * The tests lock two things that are easy to lose later:
 *  - the 256-colour quantisation geometry (cube + grey ramp, weighted distance),
 *    which must stay identical to pi-tui's so both renderers agree;
 *  - the per-line budget (stops, SGR runs, bytes), which is the only reason the
 *    gradient is affordable at the configured frame rate in phase 3.
 */
import { describe, it, expect } from "vitest";
import {
  CYCLE_CHARS,
  NEUTRAL_RGB,
  ansiAtCyclePosition,
  paintBorderLine,
  parseAnsiFg,
  rgbToAnsi256,
  type PaintContext,
  type Rgb,
} from "./border-gradient";

const SGR_RE = /\x1b\[[\d;]*m/g;
const plainOf = (line: string): string => line.replace(SGR_RE, "");
const sgrRuns = (line: string): number => (line.match(/\x1b\[38;[25];/g) ?? []).length;

interface Cell {
  ansi: string;
  ch: string;
}

/** Per-character view of a rendered line: the visible char plus the SGR in force. */
function cells(line: string): Cell[] {
  const tokens = line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? [];
  const out: Cell[] = [];
  let ansi = "";
  for (const token of tokens) {
    if (token.startsWith("\x1b")) {
      ansi = token;
      continue;
    }
    out.push({ ansi, ch: token });
  }
  return out;
}

/** ANSI of every dash column, left to right. */
function columnAnsi(line: string): string[] {
  return cells(line)
    .filter((cell) => cell.ch === "─")
    .map((cell) => cell.ansi);
}

/** Lengths of consecutive same-colour runs (the visible stop geometry). */
function runLengths(line: string): number[] {
  const lengths: number[] = [];
  let previous: string | undefined;
  for (const cell of cells(line)) {
    if (cell.ansi === previous) {
      lengths[lengths.length - 1] = lengths[lengths.length - 1]! + 1;
    } else {
      lengths.push(1);
      previous = cell.ansi;
    }
  }
  return lengths;
}

const TRUE_COLOR = /^\x1b\[38;2;\d{1,3};\d{1,3};\d{1,3}m$/;
const INDEXED_COLOR = /^\x1b\[38;5;\d{1,3}m$/;

/** Six anchors in cycle order, deliberately far apart in hue. */
const ANCHORS: Rgb[] = [
  { r: 204, g: 0, b: 0 }, // error
  { r: 170, g: 102, b: 204 }, // syntaxKeyword
  { r: 214, g: 140, b: 0 }, // warning
  { r: 51, g: 153, b: 255 }, // accent
  { r: 102, g: 204, b: 102 }, // syntaxType
  { r: 51, g: 204, b: 102 }, // success
];

const LABEL_ANSI = "\x1b[38;2;51;153;255m";

/**
 * Anchors with hand-checkable numbers, used where the expected stop colours are
 * spelled out as literals (see the stop-mapping and centre-sampling tests).
 */
const STOP_ANCHORS: Rgb[] = [
  { r: 200, g: 0, b: 0 },
  { r: 0, g: 100, b: 200 },
  { r: 40, g: 160, b: 40 },
  { r: 240, g: 240, b: 0 },
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
];

const makeCtx = (over: Partial<PaintContext> = {}): PaintContext => ({
  phase: 0,
  anchors: ANCHORS,
  mode: "truecolor",
  labelAnsi: LABEL_ANSI,
  ...over,
});

describe("parseAnsiFg", () => {
  it.each([
    ["\x1b[38;2;18;52;86m", { r: 18, g: 52, b: 86 }],
    ["\x1b[38;2;0;0;0m", { r: 0, g: 0, b: 0 }],
    ["\x1b[38;2;255;255;255m", { r: 255, g: 255, b: 255 }],
    // Indexed colour: cube corners, cube interior, grey ramp, xterm basics.
    ["\x1b[38;5;16m", { r: 0, g: 0, b: 0 }],
    ["\x1b[38;5;231m", { r: 255, g: 255, b: 255 }],
    ["\x1b[38;5;21m", { r: 0, g: 0, b: 255 }],
    ["\x1b[38;5;59m", { r: 95, g: 95, b: 95 }],
    ["\x1b[38;5;232m", { r: 8, g: 8, b: 8 }],
    ["\x1b[38;5;255m", { r: 238, g: 238, b: 238 }],
    ["\x1b[38;5;1m", { r: 128, g: 0, b: 0 }],
    ["\x1b[38;5;7m", { r: 192, g: 192, b: 192 }],
  ])("%j → %j", (ansi, expected) => {
    expect(parseAnsiFg(ansi)).toEqual(expected);
  });

  it.each([
    "",
    "not-ansi",
    "#ff0000",
    "\x1b[39m", // terminal default: what pi emits for a token set to ""
    "\x1b[0m",
    "\x1b[1m",
    "\x1b[48;5;16m", // background, not foreground
    "\x1b[48;2;1;2;3m",
    "\x1b[38;5;256m", // out of range
    "\x1b[38;2;256;0;0m",
    "\x1b[38;2;1;2m", // too few components
    "\x1b[38;2;;0;0m",
    "\x1b[38;5;m",
    "\x1b[38;2;1;2;3m trailing",
  ])("rejects %j", (ansi) => {
    expect(parseAnsiFg(ansi)).toBeUndefined();
  });
});

describe("rgbToAnsi256 — quantisation geometry (pi-tui parity)", () => {
  it.each([
    [{ r: 0, g: 0, b: 0 }, 16],
    [{ r: 255, g: 255, b: 255 }, 231],
    [{ r: 255, g: 0, b: 0 }, 196],
    [{ r: 0, g: 0, b: 255 }, 21],
    [{ r: 95, g: 95, b: 95 }, 59],
    [{ r: 175, g: 175, b: 175 }, 145],
  ])("maps cube colour %j to its own cube index (%i)", (rgb, index) => {
    expect(rgbToAnsi256(rgb)).toBe(index);
  });

  it.each([
    [{ r: 8, g: 8, b: 8 }, 232],
    [{ r: 128, g: 128, b: 128 }, 244],
    [{ r: 238, g: 238, b: 238 }, 255],
  ])("maps neutral %j onto the grey ramp (%i)", (rgb, index) => {
    expect(rgbToAnsi256(rgb)).toBe(index);
  });

  it("prefers the grey ramp for near-neutral colours and the cube for saturated ones", () => {
    // Same lightness, different spread: pi uses the grey ramp only when the
    // channel spread is < 10 and the grey is strictly closer.
    expect(rgbToAnsi256({ r: 130, g: 130, b: 130 })).toBe(244);
    expect(rgbToAnsi256({ r: 130, g: 120, b: 140 })).toBe(102);
  });

  it("round-trips every cube and grey index (16..255)", () => {
    const mismatches: number[] = [];
    for (let index = 16; index <= 255; index++) {
      const rgb = parseAnsiFg(`\x1b[38;5;${index}m`)!;
      if (rgbToAnsi256(rgb) !== index) mismatches.push(index);
    }
    expect(mismatches).toEqual([]);
  });

  it("never emits one of the 16 basic colours (pi behaves the same)", () => {
    for (let index = 0; index <= 15; index++) {
      expect(rgbToAnsi256(parseAnsiFg(`\x1b[38;5;${index}m`)!)).toBeGreaterThanOrEqual(16);
    }
    // Documented parity case: basic red is approximated by the cube.
    expect(rgbToAnsi256({ r: 128, g: 0, b: 0 })).toBe(88);
  });

  it("locks the cube/grey handover (spread < 10 and the grey must be closer)", () => {
    // Near-mid grey: the cube step 135 is 2 away per channel (weighted 4), the
    // grey ramp can only offer 128 (weighted 25) → the cube wins even though the
    // colour is neutral.
    expect(rgbToAnsi256({ r: 133, g: 133, b: 133 })).toBe(102);
    expect(rgbToAnsi256({ r: 140, g: 140, b: 140 })).toBe(245);

    // Same colour, one channel moved: spread 9 is still eligible for the grey
    // ramp (128 is closer than the cube's 135) …
    expect(rgbToAnsi256({ r: 120, g: 129, b: 120 })).toBe(244);
    // … while spread 10 is not, even though the grey would be closer, so the
    // cube step 135 wins. These two differ only by the handover guard.
    expect(rgbToAnsi256({ r: 120, g: 130, b: 120 })).toBe(102);

    // Darkest greys stay on the cube: the cube entry is nearer than grey 8.
    expect(rgbToAnsi256({ r: 3, g: 3, b: 3 })).toBe(16);

    // Channel exactly halfway between two cube steps: the lower step wins, not
    // the higher one (115 is 20 away from both 95 and 135).
    expect(rgbToAnsi256({ r: 115, g: 0, b: 0 })).toBe(52);
  });
});

describe("ansiAtCyclePosition", () => {
  it("reproduces every anchor at its own cycle position (≤2 per channel)", () => {
    for (let i = 0; i < ANCHORS.length; i++) {
      const rgb = parseAnsiFg(ansiAtCyclePosition(i / ANCHORS.length, ANCHORS, "truecolor"))!;
      const anchor = ANCHORS[i]!;
      expect(Math.abs(rgb.r - anchor.r)).toBeLessThanOrEqual(2);
      expect(Math.abs(rgb.g - anchor.g)).toBeLessThanOrEqual(2);
      expect(Math.abs(rgb.b - anchor.b)).toBeLessThanOrEqual(2);
    }
  });

  it("emits the quantised anchor in 256-colour mode", () => {
    for (let i = 0; i < ANCHORS.length; i++) {
      const ansi = ansiAtCyclePosition(i / ANCHORS.length, ANCHORS, "256color");
      expect(ansi).toBe(`\x1b[38;5;${rgbToAnsi256(ANCHORS[i]!)}m`);
    }
  });

  it("interpolates with smoothstep (halfway between two anchors is their midpoint)", () => {
    const midway = parseAnsiFg(ansiAtCyclePosition(0.5 / ANCHORS.length, ANCHORS, "truecolor"))!;
    const a = ANCHORS[0]!;
    const b = ANCHORS[1]!;
    expect(Math.abs(midway.r - (a.r + b.r) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(midway.g - (a.g + b.g) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(midway.b - (a.b + b.b) / 2)).toBeLessThanOrEqual(1);
  });

  it("eases with smoothstep, not linearly (hand-computed quarter point)", () => {
    // u = 1/24 → x = 0.25 → t = smoothstep(0.25) = 0.25² × (3 − 0.5) = 0.15625,
    // i.e. 15.6 % of the way from (204,0,0) to (170,102,204):
    //   r = 204 − 34 × 0.15625 = 198.69 → 199
    //   g = 102 × 0.15625      = 15.94  → 16
    //   b = 204 × 0.15625      = 31.88  → 32
    // A linear easing would give (196, 26, 51), so this literal pins the shape
    // instead of asking the implementation what the answer should be.
    expect(parseAnsiFg(ansiAtCyclePosition(1 / 24, ANCHORS, "truecolor"))).toEqual({ r: 199, g: 16, b: 32 });
    expect(parseAnsiFg(ansiAtCyclePosition(1 / 24, ANCHORS, "truecolor"))).not.toEqual({ r: 196, g: 26, b: 51 });
  });

  it("wraps at u = 1 and stays continuous across the seam", () => {
    expect(ansiAtCyclePosition(1, ANCHORS, "truecolor")).toBe(ansiAtCyclePosition(0, ANCHORS, "truecolor"));
    const beforeSeam = parseAnsiFg(ansiAtCyclePosition(1 - 1e-6, ANCHORS, "truecolor"))!;
    const seam = ANCHORS[0]!;
    expect(Math.abs(beforeSeam.r - seam.r)).toBeLessThanOrEqual(2);
    expect(Math.abs(beforeSeam.g - seam.g)).toBeLessThanOrEqual(2);
    expect(Math.abs(beforeSeam.b - seam.b)).toBeLessThanOrEqual(2);
  });

  it.each([-1e-6, -0.25, -42.75, 1 + 1e-6, 42.5, 1e6 + 0.3])(
    "clamps/interpolates an out-of-range position (%s) instead of throwing",
    (u) => {
      const ansi = ansiAtCyclePosition(u, ANCHORS, "truecolor");
      expect(ansi).toMatch(TRUE_COLOR);
    },
  );

  it("treats a non-finite position as the start of the cycle", () => {
    const start = ansiAtCyclePosition(0, ANCHORS, "truecolor");
    for (const u of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(ansiAtCyclePosition(u, ANCHORS, "truecolor")).toBe(start);
    }
  });

  it("keeps the two colour modes mutually exclusive", () => {
    for (let step = 0; step < 64; step++) {
      const u = step / 64;
      expect(ansiAtCyclePosition(u, ANCHORS, "truecolor")).toMatch(TRUE_COLOR);
      expect(ansiAtCyclePosition(u, ANCHORS, "256color")).toMatch(INDEXED_COLOR);
    }
  });

  it("falls back to the neutral anchor when no anchor survived parsing", () => {
    expect(parseAnsiFg(ansiAtCyclePosition(0.3, [], "truecolor"))).toEqual(NEUTRAL_RGB);
  });

  it("handles a single anchor", () => {
    const only = { r: 10, g: 20, b: 30 };
    expect(parseAnsiFg(ansiAtCyclePosition(0.37, [only], "truecolor"))).toEqual(only);
  });
});

describe("paintBorderLine (gradient)", () => {
  it("returns an empty line untouched", () => {
    expect(paintBorderLine("", makeCtx())).toBe("");
  });

  it("keeps every character and terminates the line with a foreground reset", () => {
    const line = paintBorderLine("─".repeat(120), makeCtx());
    expect(plainOf(line)).toBe("─".repeat(120));
    expect(line.endsWith("\x1b[39m")).toBe(true);
    expect(line).not.toContain("\x1b[0m");
  });

  it("paints the scroll-hint label with the label colour", () => {
    const plain = `${"─".repeat(15)} ↑ 3 more ${"─".repeat(95)}`;
    const line = paintBorderLine(plain, makeCtx());
    expect(plainOf(line)).toBe(plain);
    const labelStart = plain.indexOf(" ↑ 3 more ");
    const tokens = [...line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/gu)].map((m) => m[0]);
    let ansi = "";
    const labelAnsi: string[] = [];
    let column = 0;
    for (const token of tokens) {
      if (token.startsWith("\x1b")) {
        ansi = token;
        continue;
      }
      if (column >= labelStart && column < labelStart + 10) labelAnsi.push(ansi);
      column += 1;
    }
    expect(new Set(labelAnsi)).toEqual(new Set([LABEL_ANSI]));
  });

  it("stays inside the per-column byte format at 120 columns", () => {
    // One SGR prefix per column is the point of "one colour per character"; the
    // caps below are the format's worst case (19-byte truecolor prefix, 11-byte
    // 256-colour prefix), so a regression to longer sequences shows up here.
    const truecolor = paintBorderLine("─".repeat(120), makeCtx());
    expect(truecolor.length).toBeLessThanOrEqual(120 * 20 + 4);
    expect(sgrRuns(truecolor)).toBeLessThanOrEqual(120);

    const indexed = paintBorderLine("─".repeat(120), makeCtx({ mode: "256color" }));
    expect(indexed.length).toBeLessThanOrEqual(120 * 12 + 4);
    expect(sgrRuns(indexed)).toBeLessThanOrEqual(120);
  });

  it("paints each column with the smoothstep shape (hand-computed, phase 0)", () => {
    // Column c sits at u = c / 16, so x = 6u, i = floor(x) % 6, t = smoothstep(x - floor(x)).
    // Column 1: u = 0.0625 → x = 0.375 → t = 0.31640625 → (193, 32, 65)
    // Column 2: u = 0.125  → x = 0.75  → t = 0.84375    → (175, 86, 172)
    // Column 3: u = 0.1875 → x = 1.125 → t = 0.04296875 (anchors 1→2) → (172, 104, 195)
    const perColumn = cells(paintBorderLine("─".repeat(4), makeCtx())).map((cell) => parseAnsiFg(cell.ansi));
    expect(perColumn).toEqual([
      { r: 204, g: 0, b: 0 },
      { r: 193, g: 32, b: 65 },
      { r: 175, g: 86, b: 172 },
      { r: 172, g: 104, b: 195 },
    ]);
  });

  it("is deterministic for identical inputs", () => {
    expect(paintBorderLine("─".repeat(80), makeCtx())).toBe(paintBorderLine("─".repeat(80), makeCtx()));
  });

  it("changes colours but not characters when the phase advances", () => {
    const a = paintBorderLine("─".repeat(80), makeCtx({ phase: 0 }));
    const b = paintBorderLine("─".repeat(80), makeCtx({ phase: 0.05 }));
    expect(plainOf(a)).toBe(plainOf(b));
    expect(a).not.toBe(b);
  });

  it("keeps the character count for every width in the matrix", () => {
    for (const width of [1, 2, 3, 5, 20, 80, 137, 201]) {
      const line = paintBorderLine("─".repeat(width), makeCtx());
      expect(plainOf(line)).toBe("─".repeat(width));
    }
  });
});

describe("paintBorderLine — spatial period (CYCLE_CHARS)", () => {
  it("uses a fixed 16-character cycle", () => {
    expect(CYCLE_CHARS).toBe(16);
  });

  it("repeats the pattern every CYCLE_CHARS columns at a fixed phase", () => {
    const perColumn: string[] = [];
    const line = paintBorderLine("─".repeat(48), makeCtx({ phase: 0.3 }));
    const tokens = [...line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/gu)].map((m) => m[0]);
    let ansi = "";
    for (const token of tokens) {
      if (token.startsWith("\x1b")) {
        ansi = token;
        continue;
      }
      perColumn.push(ansi);
    }

    // Column 0 and column 16 are the same spot of the ring; column 8 is halfway.
    expect(perColumn[0]).toBe(perColumn[CYCLE_CHARS]);
    expect(perColumn[0]).toBe(perColumn[CYCLE_CHARS * 2]);
    expect(perColumn[0]).not.toBe(perColumn[CYCLE_CHARS / 2]);
    for (let column = 0; column < CYCLE_CHARS; column++) {
      expect(perColumn[column]).toBe(perColumn[column + CYCLE_CHARS]);
    }
  });

  it("wraps the ring with the phase, so a phase shift moves the whole pattern", () => {
    const atZero = paintBorderLine("─".repeat(CYCLE_CHARS), makeCtx({ phase: 0 }));
    const atOneLap = paintBorderLine("─".repeat(CYCLE_CHARS), makeCtx({ phase: 1 }));
    expect(atOneLap).toBe(atZero);

    // One column of phase == one column of space: shifting the phase by 1/16
    // reproduces the same picture shifted by one column.
    const shifted = paintBorderLine("─".repeat(CYCLE_CHARS * 2), makeCtx({ phase: 1 / CYCLE_CHARS }));
    const plainShift = paintBorderLine("─".repeat(CYCLE_CHARS * 2), makeCtx({ phase: 0 }));
    const colorsOf = (line: string): string[] => {
      const tokens = [...line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/gu)].map((m) => m[0]);
      const out: string[] = [];
      let ansi = "";
      for (const token of tokens) {
        if (token.startsWith("\x1b")) {
          ansi = token;
          continue;
        }
        out.push(ansi);
      }
      return out;
    };
    const a = colorsOf(plainShift);
    const b = colorsOf(shifted);
    for (let column = 0; column < CYCLE_CHARS; column++) {
      expect(b[column]).toBe(a[(column + 1) % CYCLE_CHARS]);
    }
  });

  it("does not depend on the line width (width 40 vs 200)", () => {
    const narrow = paintBorderLine("─".repeat(40), makeCtx({ phase: 0.2 }));
    const wide = paintBorderLine("─".repeat(200), makeCtx({ phase: 0.2 }));
    const cellsOf = (line: string): Array<{ ansi: string; ch: string }> => {
      const tokens = [...line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/gu)].map((m) => m[0]);
      const out: Array<{ ansi: string; ch: string }> = [];
      let ansi = "";
      for (const token of tokens) {
        if (token.startsWith("\x1b")) {
          ansi = token;
          continue;
        }
        out.push({ ansi, ch: token });
      }
      return out;
    };
    const narrowCells = cellsOf(narrow);
    const wideCells = cellsOf(wide);
    // The first full cycle is identical; only the length differs.
    expect(wideCells.slice(0, CYCLE_CHARS)).toEqual(narrowCells.slice(0, CYCLE_CHARS));
    expect(wideCells.slice(CYCLE_CHARS, CYCLE_CHARS * 2)).toEqual(narrowCells.slice(CYCLE_CHARS, CYCLE_CHARS * 2));
  });

  it("never paints a wide uniform block in truecolor (one colour per character)", () => {
    const line = paintBorderLine("─".repeat(120), makeCtx());
    const columnColors = cells(line)
      .filter((cell) => cell.ch === "─")
      .map((cell) => cell.ansi);

    // Adjacent columns are 1/16 lap apart, so their RGB differs: every run is a
    // single character (no block), which is exactly what the quantised
    // stop-based version could not promise. The period still repeats, so the
    // whole line only holds CYCLE_CHARS distinct colours.
    expect(runLengths(line)).toEqual(Array(120).fill(1));
    expect(new Set(columnColors).size).toBe(CYCLE_CHARS);
  });

  it("keeps blocks short in 256 colours (quantisation may merge neighbours)", () => {
    const line = paintBorderLine("─".repeat(120), makeCtx({ mode: "256color" }));
    const lengths = runLengths(line);

    // Quantisation collapses nearby tones onto the same palette entry, so single
    // columns are not guaranteed here — but no block may swallow a whole band.
    expect(Math.max(...lengths)).toBeLessThanOrEqual(4);
    expect(new Set(cells(line).filter((c) => c.ch === "─").map((c) => c.ansi)).size).toBeGreaterThanOrEqual(8);
  });
});
