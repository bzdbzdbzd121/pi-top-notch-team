/**
 * Colour maths for the team-mode border gradient (plan phase 2).
 *
 * Pure functions only: no IO, no timers, no theme access. The caller resolves the
 * anchors to RGB (the editor reads them from `theme.getFgAnsi` on every render,
 * so a theme switch needs no invalidation) and passes the terminal colour mode.
 *
 * Pipeline:
 *   theme token → ANSI (`theme.getFgAnsi`) → `parseAnsiFg` → RGB anchors
 *   → ring interpolation at a cycle position → ANSI foreground sequence
 *   (`38;2;r;g;b` in truecolor, `38;5;N` in 256-colour terminals).
 *
 * Phase 2 keeps the picture static: the cycle position (`phase`) is an input, so
 * phase 3 can drive it from the clock without touching this module.
 */

/** Border glyph the editor draws its horizontal lines with. */
export const BORDER_DASH = "─";

/**
 * Colour stops per border line. Terminal output is diffed per line, so the only
 * levers on traffic are frame rate and the number of colour runs; 32 stops cut a
 * 120-column line from ~2.1 KB (per-character) to ~0.7 KB with no visible loss.
 */
export const DEFAULT_GRADIENT_STOPS = 32;

/** Anchor used when a theme token cannot be parsed (e.g. set to the terminal default). */
export const NEUTRAL_RGB: Rgb = { r: 0x88, g: 0x88, b: 0x88 };

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type GradientColorMode = "truecolor" | "256color";

// xterm palette, identical to pi-tui's `colors.js` so 256-colour output matches
// what pi itself would produce for the same RGB value.
const BASIC_16: Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 128, g: 0, b: 0 },
  { r: 0, g: 128, b: 0 },
  { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 128 },
  { r: 0, g: 128, b: 128 },
  { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

/** The 6×6×6 colour cube channel values (xterm 16..231). */
const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;

/** The 24-step grey ramp (xterm 232..255). */
const GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

const TRUE_COLOR_FG_RE = /^\x1b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})(?:;[\d;]*)?m$/;
const INDEXED_FG_RE = /^\x1b\[38;5;(\d{1,3})(?:;[\d;]*)?m$/;

function indexedToRgb(index: number): Rgb {
  if (index < 16) return { ...BASIC_16[index]! };
  if (index < 232) {
    const cubeIndex = index - 16;
    return {
      r: CUBE_VALUES[Math.floor(cubeIndex / 36)]!,
      g: CUBE_VALUES[Math.floor((cubeIndex % 36) / 6)]!,
      b: CUBE_VALUES[cubeIndex % 6]!,
    };
  }
  const gray = 8 + (index - 232) * 10;
  return { r: gray, g: gray, b: gray };
}

/**
 * Parse a foreground SGR sequence into RGB.
 *
 * Accepts what pi's theme emits: `\x1b[38;2;r;g;bm` in truecolor mode and
 * `\x1b[38;5;Nm` in 256-colour mode. Anything else — including `\x1b[39m`
 * (terminal default), background colours and malformed values — returns
 * `undefined`, which the caller turns into `NEUTRAL_RGB`.
 */
export function parseAnsiFg(ansi: string): Rgb | undefined {
  const trueColor = TRUE_COLOR_FG_RE.exec(ansi);
  if (trueColor) {
    const [r, g, b] = [Number(trueColor[1]), Number(trueColor[2]), Number(trueColor[3])];
    if (r > 255 || g > 255 || b > 255) return undefined;
    return { r, g, b };
  }

  const indexed = INDEXED_FG_RE.exec(ansi);
  if (indexed) {
    const index = Number(indexed[1]);
    if (index > 255) return undefined;
    return indexedToRgb(index);
  }

  return undefined;
}

function findClosest(values: readonly number[], target: number): number {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < values.length; index++) {
    const distance = Math.abs(target - values[index]!);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }
  return closestIndex;
}

/** Perceptual-ish distance (green dominates), same weights as pi-tui. */
function colorDistance(first: Rgb, second: Rgb): number {
  const dr = first.r - second.r;
  const dg = first.g - second.g;
  const db = first.b - second.b;
  return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/**
 * Quantise RGB to an xterm-256 index, matching pi-tui's `colors.js` exactly:
 * nearest cube entry per channel plus the grey ramp, then pick the grey only for
 * near-neutral colours (channel spread < 10) that it represents more closely.
 */
export function rgbToAnsi256(rgb: Rgb): number {
  const rIndex = findClosest(CUBE_VALUES, rgb.r);
  const gIndex = findClosest(CUBE_VALUES, rgb.g);
  const bIndex = findClosest(CUBE_VALUES, rgb.b);
  const cubeColor: Rgb = { r: CUBE_VALUES[rIndex]!, g: CUBE_VALUES[gIndex]!, b: CUBE_VALUES[bIndex]! };
  const cubeIndex = 16 + 36 * rIndex + 6 * gIndex + bIndex;

  const gray = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
  const grayOffset = findClosest(GRAY_VALUES, gray);
  const grayValue = GRAY_VALUES[grayOffset]!;
  const spread = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);

  if (spread < 10 && colorDistance(rgb, { r: grayValue, g: grayValue, b: grayValue }) < colorDistance(rgb, cubeColor)) {
    return 232 + grayOffset;
  }
  return cubeIndex;
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0; // also catches NaN
  if (value >= 1) return 1;
  return value;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

function mixChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t);
}

/**
 * Colour at position `u` on the anchor ring, as an ANSI foreground sequence.
 *
 * `u` is a cycle position: `floor(u)` selects the lap, the fraction selects the
 * spot, so `0`, `1` and `-1` are the same colour and any value (including a
 * negative phase or a non-finite number) is safe. The interpolation parameter is
 * clamped internally; `NaN`/`±Infinity` are treated as the start of the cycle.
 *
 * `anchors` may be any non-empty length; the editor passes six theme colours.
 */
export function ansiAtCyclePosition(u: number, anchors: Rgb[], mode: GradientColorMode): string {
  const ring = anchors.length > 0 ? anchors : [NEUTRAL_RGB];
  const position = Number.isFinite(u) ? u - Math.floor(u) : 0;

  const scaled = position * ring.length;
  const index = Math.floor(scaled) % ring.length;
  const t = smoothstep(clamp01(scaled - Math.floor(scaled)));

  const from = ring[index]!;
  const to = ring[(index + 1) % ring.length]!;
  const rgb: Rgb = {
    r: mixChannel(from.r, to.r, t),
    g: mixChannel(from.g, to.g, t),
    b: mixChannel(from.b, to.b, t),
  };

  return mode === "truecolor"
    ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
    : `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
}

export interface PaintContext {
  /** Line width in columns (border lines are one character per column). */
  width: number;
  /** Cycle position; 0 in phase 2 (static), `(now / CYCLE_MS) % 1` in phase 3. */
  phase: number;
  /** Anchor colours in cycle order. */
  anchors: Rgb[];
  mode: GradientColorMode;
  /** Colour for every non-dash character (scroll hint text, blanks). */
  labelAnsi: string;
  /** Colour stops per line; defaults to `DEFAULT_GRADIENT_STOPS`, clamped to `[1, width]`. */
  stops?: number;
}

/**
 * Colour a plain (uncoloured) border line.
 *
 * Only foreground colours are emitted: dashes take the gradient colour of their
 * stop, everything else takes `labelAnsi`, adjacent characters sharing a colour
 * are merged into one run, and the line ends with `\x1b[39m` so the terminal's
 * foreground colour does not leak into whatever the TUI writes next.
 *
 * Implementation assumption: border lines contain single-column characters only
 * (dashes, blanks, `↑`/`↓`, ASCII hint text), so the character index equals the
 * column. If a future version seeds the border with wide characters (CJK/emoji),
 * columns must be accumulated with `visibleWidth` instead of counting characters.
 */
export function paintBorderLine(plain: string, paint: PaintContext): string {
  if (plain.length === 0) return "";

  const width = Math.max(1, Math.floor(paint.width) || 1);
  const requestedStops = Number.isFinite(paint.stops) ? Math.floor(paint.stops as number) : DEFAULT_GRADIENT_STOPS;
  const stops = Math.min(Math.max(1, requestedStops), width);

  // One colour lookup per stop, reused by every column inside that stop.
  const stopColors: Array<string | undefined> = new Array(stops);
  const colorForColumn = (column: number): string => {
    const stop = Math.min(stops - 1, Math.floor((column * stops) / width));
    let ansi = stopColors[stop];
    if (ansi === undefined) {
      ansi = ansiAtCyclePosition((stop + 0.5) / stops + paint.phase, paint.anchors, paint.mode);
      stopColors[stop] = ansi;
    }
    return ansi;
  };

  let out = "";
  let runColor: string | undefined;
  let runText = "";
  let column = 0;

  for (const ch of plain) {
    const color = ch === BORDER_DASH ? colorForColumn(column) : paint.labelAnsi;
    if (color !== runColor) {
      if (runText.length > 0 && runColor !== undefined) out += `${runColor}${runText}`;
      runColor = color;
      runText = "";
    }
    runText += ch;
    column += 1;
  }
  if (runText.length > 0 && runColor !== undefined) out += `${runColor}${runText}`;

  return `${out}\x1b[39m`;
}
