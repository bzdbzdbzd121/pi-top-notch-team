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
 *    gradient is affordable at 12.5 fps in phase 3.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_GRADIENT_STOPS,
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

const makeCtx = (over: Partial<PaintContext> = {}): PaintContext => ({
  width: 120,
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
    const cells = [...line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/g)].map((m) => m[0]);
    // Rebuild per-character ANSI to check the label run without a parser here.
    let ansi = "";
    const labelAnsi: string[] = [];
    let column = 0;
    for (const token of cells) {
      if (token.startsWith("\x1b")) {
        ansi = token;
        continue;
      }
      if (column >= labelStart && column < labelStart + 10) labelAnsi.push(ansi);
      column += 1;
    }
    expect(new Set(labelAnsi)).toEqual(new Set([LABEL_ANSI]));
  });

  it(`keeps ≤ steps runs and ≤ 800 bytes at 120 columns (truecolor)`, () => {
    const line = paintBorderLine("─".repeat(120), makeCtx());
    expect(sgrRuns(line)).toBeLessThanOrEqual(DEFAULT_GRADIENT_STOPS);
    expect(line.length).toBeLessThanOrEqual(800);
  });

  it(`keeps ≤ steps runs and ≤ 500 bytes at 120 columns (256 colour)`, () => {
    const line = paintBorderLine("─".repeat(120), makeCtx({ mode: "256color" }));
    expect(sgrRuns(line)).toBeLessThanOrEqual(DEFAULT_GRADIENT_STOPS);
    expect(line.length).toBeLessThanOrEqual(500);
  });

  it("allows one extra run for the hint label on top of the stop budget", () => {
    const plain = `${"─".repeat(15)} ↑ 3 more ${"─".repeat(95)}`;
    const line = paintBorderLine(plain, makeCtx());
    expect(sgrRuns(line)).toBeLessThanOrEqual(DEFAULT_GRADIENT_STOPS + 1);
  });

  it("clamps the stop budget to [1, width]", () => {
    const wide = paintBorderLine("─".repeat(20), makeCtx({ width: 20, stops: 10_000 }));
    expect(sgrRuns(wide)).toBeLessThanOrEqual(20);

    const single = paintBorderLine("─".repeat(20), makeCtx({ width: 20, stops: 0 }));
    expect(sgrRuns(single)).toBe(1);
    expect(plainOf(single)).toBe("─".repeat(20));
  });

  it("is deterministic for identical inputs", () => {
    expect(paintBorderLine("─".repeat(80), makeCtx({ width: 80 }))).toBe(
      paintBorderLine("─".repeat(80), makeCtx({ width: 80 })),
    );
  });

  it("changes colours but not characters when the phase advances", () => {
    const a = paintBorderLine("─".repeat(80), makeCtx({ width: 80, phase: 0 }));
    const b = paintBorderLine("─".repeat(80), makeCtx({ width: 80, phase: 0.05 }));
    expect(plainOf(a)).toBe(plainOf(b));
    expect(a).not.toBe(b);
  });

  it("keeps the character count for every width in the matrix", () => {
    for (const width of [1, 2, 3, 5, 20, 80, 137, 201]) {
      const line = paintBorderLine("─".repeat(width), makeCtx({ width }));
      expect(plainOf(line)).toBe("─".repeat(width));
    }
  });

  it("stays inside the byte cap in the worst case (every channel three digits)", () => {
    // Alternating extremes keep all 32 stops distinct while forcing the longest
    // possible `38;2;r;g;b` prefixes: 32 runs x 19 bytes + 120 columns + reset.
    const wideAnchors: Rgb[] = Array.from({ length: 6 }, (_, index) =>
      index % 2 === 0 ? { r: 255, g: 255, b: 255 } : { r: 100, g: 100, b: 100 },
    );
    const truecolor = paintBorderLine("─".repeat(120), makeCtx({ anchors: wideAnchors }));
    // Adjacent stops may round to the same RGB (rounding merges that pair), so the
    // run count is bounded by the stop budget rather than exactly equal to it.
    expect(sgrRuns(truecolor)).toBeGreaterThanOrEqual(24);
    expect(sgrRuns(truecolor)).toBeLessThanOrEqual(DEFAULT_GRADIENT_STOPS);
    expect(truecolor.length).toBeLessThanOrEqual(800);

    const indexed = paintBorderLine("─".repeat(120), makeCtx({ anchors: wideAnchors, mode: "256color" }));
    expect(sgrRuns(indexed)).toBeGreaterThanOrEqual(16);
    expect(sgrRuns(indexed)).toBeLessThanOrEqual(DEFAULT_GRADIENT_STOPS);
    expect(indexed.length).toBeLessThanOrEqual(500);
  });
});
