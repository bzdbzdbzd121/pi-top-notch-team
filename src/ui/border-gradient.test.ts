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
  MIN_ANCHOR_HUE_GAP_DEG,
  NEUTRAL_RGB,
  ansiAtCyclePosition,
  oklchToRgb,
  paintBorderLine,
  parseAnsiFg,
  prepareAnchors,
  rgbToAnsi256,
  rgbToOklch,
  type Oklch,
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

/** The anchor ring the gradient actually walks: sorted by hue, near-duplicates collapsed. */
const RING = prepareAnchors(ANCHORS);

/**
 * OKLCH of the synthetic anchors, computed by hand from Ottosson's matrices
 * (independent of the implementation, so order/dedupe assertions do not ask the
 * code what the answer is):
 *   error        (204,0,0)     L 0.5308 C 0.2178 h  29.23
 *   warning      (214,140,0)   L 0.6987 C 0.1495 h  72.07
 *   syntaxType   (102,204,102) L 0.7603 C 0.1696 h 143.68
 *   success      ( 51,204,102) L 0.7450 C 0.1897 h 149.57  ← 5.89° from syntaxType → dropped
 *   accent       ( 51,153,255) L 0.6755 C 0.1765 h 252.26
 *   syntaxKeyword(170,102,204) L 0.6261 C 0.1620 h 313.37
 */
const EXPECTED_RING_HUES = [29.23, 72.07, 143.68, 252.26, 313.37];

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
  anchors: RING,
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

describe("prepareAnchors — hue sort + de-duplication", () => {
  it("sorts by hue and drops an anchor closer than the threshold (hand-computed hues)", () => {
    // success sits 5.89° from syntaxType, i.e. below MIN_ANCHOR_HUE_GAP_DEG = 6,
    // so the ring keeps syntaxType (first in sorted order) and drops success.
    expect(MIN_ANCHOR_HUE_GAP_DEG).toBe(6);
    expect(RING).toHaveLength(5);

    const hues = RING.map((anchor) => anchor.h);
    for (let i = 0; i < hues.length; i++) {
      expect(Math.abs(hues[i]! - EXPECTED_RING_HUES[i]!)).toBeLessThanOrEqual(0.5);
    }
    // Strictly ascending: no revisit, no back-tracking.
    for (let i = 1; i < hues.length; i++) expect(hues[i]!).toBeGreaterThan(hues[i - 1]!);
  });

  it("collapses a repeated anchor (the built-in themes ship accent = syntaxType)", () => {
    const duplicated: Rgb[] = [
      { r: 204, g: 0, b: 0 },
      { r: 170, g: 102, b: 204 },
      { r: 51, g: 153, b: 255 },
      { r: 51, g: 153, b: 255 }, // accent repeated as syntaxType
      { r: 102, g: 204, b: 102 },
      { r: 51, g: 204, b: 102 },
    ];
    const ring = prepareAnchors(duplicated);
    expect(ring).toHaveLength(4); // accent duplicate and success (5.89° from syntaxType) dropped
    for (let i = 1; i < ring.length; i++) expect(ring[i]!.h).toBeGreaterThan(ring[i - 1]!.h);
  });

  it("falls back to the neutral anchor for an empty input", () => {
    const ring = prepareAnchors([]);
    expect(ring).toHaveLength(1);
    expect(ring[0]!.h).toBeCloseTo(rgbToOklch(NEUTRAL_RGB).h, 6);
  });
});

describe("rgbToOklch / oklchToRgb", () => {
  it.each([
    [{ r: 204, g: 0, b: 0 }, { l: 0.5308, c: 0.2178, h: 29.23 }],
    [{ r: 102, g: 204, b: 102 }, { l: 0.7603, c: 0.1696, h: 143.68 }],
    [{ r: 255, g: 255, b: 255 }, { l: 1, c: 0, h: 0 }],
  ])("converts %j to OKLCH within rounding (%j)", (rgb, expected) => {
    const got = rgbToOklch(rgb as Rgb);
    expect(Math.abs(got.l - (expected as Oklch).l)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(got.c - (expected as Oklch).c)).toBeLessThanOrEqual(0.002);
    if ((expected as Oklch).c > 0.01) expect(Math.abs(got.h - (expected as Oklch).h)).toBeLessThanOrEqual(0.5);
  });

  it("round-trips sRGB colours within one unit per channel", () => {
    for (const rgb of [
      { r: 204, g: 0, b: 0 },
      { r: 51, g: 153, b: 255 },
      { r: 51, g: 204, b: 102 },
      { r: 18, g: 52, b: 86 },
      { r: 238, g: 238, b: 238 },
    ] as Rgb[]) {
      const back = oklchToRgb(rgbToOklch(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps lightness and hue when the colour leaves the sRGB gamut", () => {
    // Very high chroma at mid lightness is outside sRGB: the mapper must reduce
    // chroma only, keeping L and h (so a light theme stays light).
    const request: Oklch = { l: 0.716, c: 0.4, h: 150 };
    const rgb = oklchToRgb(request);
    for (const channel of [rgb.r, rgb.g, rgb.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
    const got = rgbToOklch(rgb);
    expect(Math.abs(got.l - request.l)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(got.h - request.h)).toBeLessThanOrEqual(1.5);
    expect(got.c).toBeLessThan(request.c);
  });
});

describe("ansiAtCyclePosition", () => {
  it("reproduces every ring anchor at its own cycle position (≤2 per channel)", () => {
    for (let i = 0; i < RING.length; i++) {
      const rgb = parseAnsiFg(ansiAtCyclePosition(i / RING.length, RING, "truecolor"))!;
      const anchor = oklchToRgb(RING[i]!);
      expect(Math.abs(rgb.r - anchor.r)).toBeLessThanOrEqual(2);
      expect(Math.abs(rgb.g - anchor.g)).toBeLessThanOrEqual(2);
      expect(Math.abs(rgb.b - anchor.b)).toBeLessThanOrEqual(2);
    }
  });

  it("emits the quantised anchor in 256-colour mode", () => {
    for (let i = 0; i < RING.length; i++) {
      const ansi = ansiAtCyclePosition(i / RING.length, RING, "256color");
      expect(ansi).toBe(`\x1b[38;5;${rgbToAnsi256(oklchToRgb(RING[i]!))}m`);
    }
  });

  it("interpolates linearly in OKLCH (quarter of a segment, not smoothstep)", () => {
    // t = 0.125 of segment 0: linear hue = h0 + 0.125 × Δh; smoothstep would give
    // 0.0429 × Δh. L and C also move linearly, which is what keeps a long period
    // from dwelling at the anchors and rushing through the middle.
    const from = RING[0]!;
    const to = RING[1]!;
    const expectedHue = from.h + (to.h - from.h) * 0.125;
    const got = rgbToOklch(parseAnsiFg(ansiAtCyclePosition(0.125 / RING.length, RING, "truecolor"))!);

    expect(Math.abs(got.h - expectedHue)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(got.l - (from.l + (to.l - from.l) * 0.125))).toBeLessThanOrEqual(0.01);
    // A smoothstep easing would land at h0 + 0.0429 × Δh, i.e. well outside this.
    expect(Math.abs(got.h - (from.h + (to.h - from.h) * 0.0429))).toBeGreaterThan(1);
  });

  it("keeps the hue ramp monotone and covers one lap (no back-tracking)", () => {
    const steps = CYCLE_CHARS * 2;
    let previous: number | undefined;
    let travel = 0;
    for (let step = 0; step < steps; step++) {
      const hue = rgbToOklch(parseAnsiFg(ansiAtCyclePosition(step / CYCLE_CHARS, RING, "truecolor"))!).h;
      if (previous !== undefined) {
        // The ring wraps at 360°, so unwrap before comparing.
        let delta = hue - previous;
        if (delta < -180) delta += 360;
        expect(delta).toBeGreaterThan(0);
        travel += delta;
      }
      previous = hue;
    }
    // Two laps ⇒ ≈720° of hue travel (the ring's own gaps sum to 360 per lap),
    // never reversing. Gamut clipping shifts the measured hue by a fraction of a
    // degree per step, so allow ~1.5% drift.
    expect(Math.abs(travel - 720)).toBeLessThanOrEqual(12);
  });

  it("wraps at u = 1 and stays continuous across the seam", () => {
    expect(ansiAtCyclePosition(1, RING, "truecolor")).toBe(ansiAtCyclePosition(0, RING, "truecolor"));
    const beforeSeam = rgbToOklch(parseAnsiFg(ansiAtCyclePosition(1 - 1e-6, RING, "truecolor"))!);
    const seam = rgbToOklch(parseAnsiFg(ansiAtCyclePosition(0, RING, "truecolor"))!);
    expect(Math.abs(beforeSeam.l - seam.l)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(beforeSeam.c - seam.c)).toBeLessThanOrEqual(0.01);
  });

  it.each([-1e-6, -0.25, -42.75, 1 + 1e-6, 42.5, 1e6 + 0.3])(
    "clamps/interpolates an out-of-range position (%s) instead of throwing",
    (u) => {
      expect(ansiAtCyclePosition(u, RING, "truecolor")).toMatch(TRUE_COLOR);
    },
  );

  it("treats a non-finite position as the start of the cycle", () => {
    const start = ansiAtCyclePosition(0, RING, "truecolor");
    for (const u of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(ansiAtCyclePosition(u, RING, "truecolor")).toBe(start);
    }
  });

  it("keeps the two colour modes mutually exclusive", () => {
    for (let step = 0; step < 64; step++) {
      const u = step / 64;
      expect(ansiAtCyclePosition(u, RING, "truecolor")).toMatch(TRUE_COLOR);
      expect(ansiAtCyclePosition(u, RING, "256color")).toMatch(INDEXED_COLOR);
    }
  });

  it("falls back to the neutral anchor when no anchor survived parsing", () => {
    expect(parseAnsiFg(ansiAtCyclePosition(0.3, [], "truecolor"))).toEqual(NEUTRAL_RGB);
  });

  it("stays a single colour with a single anchor (no invented rainbow)", () => {
    const only = prepareAnchors([{ r: 10, g: 20, b: 30 }]);
    const colors = [0, 0.13, 0.5, 0.87].map((u) => ansiAtCyclePosition(u, only, "truecolor"));
    expect(new Set(colors).size).toBe(1);
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
    const perChar = cells(line);
    expect(perChar.slice(labelStart, labelStart + 10).map((cell) => cell.ansi)).toEqual(
      Array(10).fill(LABEL_ANSI),
    );
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

  it("never paints two adjacent columns the same colour in truecolor", () => {
    // Anchors are sorted and de-duplicated, so every column step moves the hue;
    // one lap holds CYCLE_CHARS distinct colours and the pattern repeats.
    const line = paintBorderLine("─".repeat(120), makeCtx());
    expect(runLengths(line)).toEqual(Array(120).fill(1));
    expect(new Set(columnAnsi(line)).size).toBe(CYCLE_CHARS);
  });

  it("keeps blocks short in 256 colours (quantisation may merge neighbours)", () => {
    const line = paintBorderLine("─".repeat(120), makeCtx({ mode: "256color" }));
    const lengths = runLengths(line);

    // Quantisation collapses nearby tones onto the same palette entry, so single
    // columns are not guaranteed here (measured: max run 5, 22 distinct colours at
    // 120 columns). A dead span from a repeated anchor would be far longer, and in
    // truecolor it is caught by the "every run is one character" assertion.
    expect(Math.max(...lengths)).toBeLessThanOrEqual(6);
    expect(new Set(columnAnsi(line)).size).toBeGreaterThanOrEqual(8);
  });
});

describe("paintBorderLine — per-column colour step", () => {
  /** OKLab Euclidean distance (L, a, b) between two OKLCH colours. */
  const deltaE = (first: Oklch, second: Oklch): number => {
    const toLab = (color: Oklch): [number, number, number] => {
      const radians = (color.h * Math.PI) / 180;
      return [color.l, color.c * Math.cos(radians), color.c * Math.sin(radians)];
    };
    const [l1, a1, b1] = toLab(first);
    const [l2, a2, b2] = toLab(second);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  };

  it("keeps every column step small at 48 characters per lap (max ΔE ≤ 0.05)", () => {
    // Measured on a 120-column line: max 0.040, median 0.023. The threshold sits
    // in the analysis report's magnitude (maxColΔE ≈ 0.028 for the built-in
    // themes) with headroom for this synthetic ring's wider wrap leg. Shortening
    // the period (e.g. back to 16) triples the step and turns this red.
    const colors = columnAnsi(paintBorderLine("─".repeat(120), makeCtx())).map(
      (ansi) => rgbToOklch(parseAnsiFg(ansi)!)!,
    );
    let maximum = 0;
    for (let i = 1; i < colors.length; i++) {
      maximum = Math.max(maximum, deltaE(colors[i - 1]!, colors[i]!));
    }
    expect(maximum).toBeLessThanOrEqual(0.05);
    expect(maximum).toBeGreaterThan(0); // the gradient actually moves
  });
});

describe("paintBorderLine — spatial period (CYCLE_CHARS)", () => {
  it("uses a fixed 48-character cycle", () => {
    expect(CYCLE_CHARS).toBe(48);
  });

  it("repeats the pattern every CYCLE_CHARS columns at a fixed phase", () => {
    const perColumn = columnAnsi(paintBorderLine("─".repeat(CYCLE_CHARS * 3), makeCtx({ phase: 0.3 })));

    // Column 0 and column CYCLE_CHARS are the same spot of the ring; halfway is not.
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

    // One column of phase == one column of space: shifting the phase by 1/48
    // reproduces the same picture shifted by one column.
    const shifted = columnAnsi(paintBorderLine("─".repeat(CYCLE_CHARS * 2), makeCtx({ phase: 1 / CYCLE_CHARS })));
    const plain = columnAnsi(paintBorderLine("─".repeat(CYCLE_CHARS * 2), makeCtx({ phase: 0 })));
    for (let column = 0; column < CYCLE_CHARS; column++) {
      expect(shifted[column]).toBe(plain[(column + 1) % CYCLE_CHARS]);
    }
  });

  it("does not depend on the line width (width 96 vs 200)", () => {
    const narrow = cells(paintBorderLine("─".repeat(96), makeCtx({ phase: 0.2 })));
    const wide = cells(paintBorderLine("─".repeat(200), makeCtx({ phase: 0.2 })));

    // The first two laps are identical; only the length differs.
    expect(wide.slice(0, CYCLE_CHARS)).toEqual(narrow.slice(0, CYCLE_CHARS));
    expect(wide.slice(CYCLE_CHARS, CYCLE_CHARS * 2)).toEqual(narrow.slice(CYCLE_CHARS, CYCLE_CHARS * 2));
  });
});
