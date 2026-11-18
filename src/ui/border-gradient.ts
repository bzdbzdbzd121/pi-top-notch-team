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
 * The colour pattern is **spatial**: one full lap of the anchors spans a fixed
 * `CYCLE_CHARS` columns, independent of the terminal width, so a character only
 * ever sees a small slice of the palette and neighbouring characters differ (the
 * login-screen look). The `phase` input shifts that pattern along the line; the
 * editor feeds it from the clock, so the picture flows without any state here.
 *
 * Anchors are processed before use (see `prepareAnchors`): converted to OKLCH,
 * sorted by hue and de-duplicated, so the ring is a monotone hue ramp with no
 * revisit and no flat span (the built-in themes ship `accent` and `syntaxType` in
 * the same colour; without de-duplication that produces a dead, desaturated
 * stretch). Interpolation then runs in OKLCH and is mapped back to sRGB, keeping
 * lightness and hue and only reducing chroma when the colour leaves the gamut.
 */

/** Border glyph the editor draws its horizontal lines with. */
export const BORDER_DASH = "─";

/**
 * Columns per full lap of the anchor palette — the spatial period of the
 * gradient.
 *
 * 48, not 16: pi's brand shimmer builds a 16-character cycle (`provider-brand.js`
 * in the 1.5.x release: four logo colours × `CHARS_PER_COLOR = 4` characters) but
 * paints a ~16-character *label*, i.e. one lap per label. A border is 120–200
 * columns wide, so a 16-character cycle would repeat the whole palette 7.5–12
 * times per line (~15 hue turns) and read as confetti. 48 columns keeps it at
 * ~2.5 hue turns on a 120-column line while still giving every character a small
 * step (≈7.5° of hue), which is what makes the band look continuous.
 *
 * The period is a fixed number of characters, not a fraction of the width: the
 * pattern looks the same on 96 and 200 columns. The time rate that moves it lives
 * in `border-animator.ts` (`CHARS_PER_SECOND`, `CYCLE_MS` = 48 / 10 s = 4.8 s per lap).
 */
export const CYCLE_CHARS = 48;

/**
 * Two anchors closer than this in OKLab (Euclidean ΔE; ~1 JND) are treated as the
 * same colour and collapsed. Perceptual distance, not hue: a dark red and a bright
 * red share a hue but are plainly different colours and must both survive.
 */
export const MIN_ANCHOR_DELTA_E = 0.02;

/**
 * Below this many anchors the ring cannot show a gradient (a single-colour theme
 * would paint a flat border), so `prepareAnchors` swaps in an evenly spaced hue
 * ring derived from the anchors' average lightness/chroma/hue.
 */
export const MIN_RING_ANCHORS = 3;

/** Size of the fallback ring used when fewer than `MIN_RING_ANCHORS` survive. */
export const FALLBACK_RING_SIZE = 6;

/** Anchor used when a theme token cannot be parsed (e.g. set to the terminal default). */
export const NEUTRAL_RGB: Rgb = { r: 0x88, g: 0x88, b: 0x88 };

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type GradientColorMode = "truecolor" | "256color";

// xterm palette, identical to pi-tui 1.5.x's `colors.js` so 256-colour output matches
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
 * Quantise RGB to an xterm-256 index, matching pi-tui 1.5.x's `colors.js` exactly:
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

// ── sRGB ↔ Oklab ↔ OKLCH ────────────────────────────────────────────────────
// Ottosson's matrices, the same ones pi-tui 1.5.x's `oklab.js` uses, so a colour takes
// the same path here as in pi's own renderer.
const LINEAR_SRGB_TO_LMS = [
  [0.4122214694707629, 0.5363325372617349, 0.0514459932675022],
  [0.2119034958178251, 0.6806995506452344, 0.1073969535369405],
  [0.0883024591900564, 0.2817188391361215, 0.6299787016738222],
] as const;
const LMS_TO_LAB = [
  [0.210454268309314, 0.793617774702305, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
] as const;
const LAB_TO_LMS = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
] as const;
const LMS_TO_LINEAR_SRGB = [
  [4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
  [-1.2684379732850315, 2.6097573492876882, -0.341319376002657],
  [-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
] as const;

type Triple = [number, number, number];

const multiply3 = (matrix: readonly (readonly number[])[], [x, y, z]: Triple): Triple => [
  matrix[0]![0]! * x + matrix[0]![1]! * y + matrix[0]![2]! * z,
  matrix[1]![0]! * x + matrix[1]![1]! * y + matrix[1]![2]! * z,
  matrix[2]![0]! * x + matrix[2]![1]! * y + matrix[2]![2]! * z,
];

const srgbToLinear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (value: number): number =>
  value > 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : 12.92 * value;

/** OKLCH: perceptual lightness, chroma, hue in degrees `[0, 360)`. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** sRGB (0–255) → OKLCH. */
export function rgbToOklch(rgb: Rgb): Oklch {
  const linear: Triple = [rgb.r / 255, rgb.g / 255, rgb.b / 255].map(srgbToLinear) as Triple;
  const lms = multiply3(LINEAR_SRGB_TO_LMS, linear).map((value) => Math.cbrt(value)) as Triple;
  const [l, a, b] = multiply3(LMS_TO_LAB, lms);
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinearSrgb({ l, c, h }: Oklch): Triple {
  const radians = (h * Math.PI) / 180;
  const lab: Triple = [l, c * Math.cos(radians), c * Math.sin(radians)];
  const lms = multiply3(LAB_TO_LMS, lab).map((value) => value * value * value) as Triple;
  return multiply3(LMS_TO_LINEAR_SRGB, lms);
}

const isInGamut = (linear: Triple): boolean => linear.every((value) => value >= -1e-4 && value <= 1 + 1e-4);

/**
 * OKLCH → sRGB (0–255), gamut-mapped.
 *
 * Lightness and hue are kept; if the colour leaves the sRGB gamut the chroma is
 * reduced by bisection until it fits (the achromatic colour always fits, so it
 * is the fallback). That keeps the lightness semantics of the theme tokens —
 * a light theme stays light even where the hue would otherwise clip.
 */
export function oklchToRgb(color: Oklch): Rgb {
  const l = clamp01(color.l);
  const chroma = Number.isFinite(color.c) ? Math.max(0, color.c) : 0;
  const h = Number.isFinite(color.h) ? ((color.h % 360) + 360) % 360 : 0;

  let linear = oklchToLinearSrgb({ l, c: chroma, h });
  if (!isInGamut(linear)) {
    // Four bisection steps resolve the chroma to within 1/16 of the requested
    // value — far below one 8-bit channel step. Twenty steps (the first version)
    // cost ~20× the paint time because roughly half of all ring positions need
    // this path.
    linear = oklchToLinearSrgb({ l, c: 0, h });
    let low = 0;
    let high = chroma;
    for (let step = 0; step < 4; step++) {
      const middle = (low + high) / 2;
      const candidate = oklchToLinearSrgb({ l, c: middle, h });
      if (isInGamut(candidate)) {
        low = middle;
        linear = candidate;
      } else {
        high = middle;
      }
    }
  }

  const [r, g, b] = linear.map((value) => Math.round(clamp01(linearToSrgb(value)) * 255)) as Triple;
  return { r, g, b };
}

/** Euclidean distance in OKLab — the perceptual yardstick used for de-duplication. */
export function anchorDeltaE(first: Oklch, second: Oklch): number {
  const toLab = (color: Oklch): Triple => {
    const radians = (color.h * Math.PI) / 180;
    return [color.l, color.c * Math.cos(radians), color.c * Math.sin(radians)];
  };
  const [l1, a1, b1] = toLab(first);
  const [l2, a2, b2] = toLab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * Evenly spaced hue ring with the given lightness/chroma — the degenerate-theme fallback.
 *
 * Sorted ascending because the ring is interpolated as-is: `(baseHue + k·60°) % 360`
 * wraps whenever the base hue is not a multiple of 60°, which would leave a low-hue
 * anchor at the end and make the ramp step backwards once per lap.
 */
function evenlySpacedRing(l: number, c: number, baseHue: number): Oklch[] {
  return Array.from({ length: FALLBACK_RING_SIZE }, (_, index) => ({
    l,
    c,
    h: (baseHue + (360 * index) / FALLBACK_RING_SIZE) % 360,
  })).sort((left, right) => left.h - right.h);
}

/** Chroma-weighted circular mean of the anchors' hues. */
function meanHue(anchors: Oklch[]): number {
  let x = 0;
  let y = 0;
  for (const anchor of anchors) {
    const radians = (anchor.h * Math.PI) / 180;
    const weight = Math.max(anchor.c, 1e-6);
    x += weight * Math.cos(radians);
    y += weight * Math.sin(radians);
  }
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Turn theme anchors into the ring the gradient walks: convert to OKLCH, sort by
 * hue, collapse anchors closer than `MIN_ANCHOR_DELTA_E` in OKLab (perceptually
 * the same colour), then guarantee at least `MIN_RING_ANCHORS`.
 *
 * - Sorting removes the back-and-forth a theme's token order can produce.
 * - De-duplication is by perceptual distance, not hue: a dark red and a bright
 *   red share a hue but stay distinct. When two anchors *are* the same colour the
 *   one with more chroma is kept (it is the more expressive of the two).
 * - The merge also runs across the wrap-around seam (359° and 1° are neighbours);
 *   the loop guard allows the ring to shrink to one anchor, which the fallback
 *   below then replaces.
 * - Fewer than `MIN_RING_ANCHORS` survivors means the theme has (almost) no colour
 *   variety; painting that would give a flat border, so an evenly spaced hue ring
 *   is derived from the anchors' average L/C/hue instead.
 */
export function prepareAnchors(anchors: Rgb[]): Oklch[] {
  const converted = anchors
    .map(rgbToOklch)
    .filter((anchor) => Number.isFinite(anchor.l) && Number.isFinite(anchor.c) && Number.isFinite(anchor.h));

  const sorted = [...converted].sort((left, right) => left.h - right.h);
  const ring: Oklch[] = [];
  for (const anchor of sorted) {
    const previous = ring[ring.length - 1];
    if (previous && anchorDeltaE(previous, anchor) < MIN_ANCHOR_DELTA_E) {
      if (anchor.c > previous.c) ring[ring.length - 1] = anchor;
      continue;
    }
    ring.push(anchor);
  }

  // The wrap segment is adjacent too, so the seam gets the same treatment: the
  // winner stays where it is and the loser is dropped. Moving the seam survivor
  // into slot 0 instead (`ring[0] = last`) would put a high-hue anchor in front of
  // low-hue ones and leave the ring unsorted, which breaks the "hues ascend, the
  // wrap adds 360°" premise the interpolation below relies on.
  while (ring.length > 1 && anchorDeltaE(ring[0]!, ring[ring.length - 1]!) < MIN_ANCHOR_DELTA_E) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (last.c > first.c) ring.shift();
    else ring.pop();
  }

  if (ring.length >= MIN_RING_ANCHORS) return ring;

  if (ring.length === 0) {
    const neutral = rgbToOklch(NEUTRAL_RGB);
    return evenlySpacedRing(neutral.l, neutral.c, neutral.h);
  }
  const lightness = ring.reduce((sum, anchor) => sum + anchor.l, 0) / ring.length;
  const chroma = ring.reduce((sum, anchor) => sum + anchor.c, 0) / ring.length;
  return evenlySpacedRing(lightness, chroma, meanHue(ring));
}

/**
 * Colour at position `u` on the prepared anchor ring, as an ANSI foreground
 * sequence.
 *
 * `u` is a cycle position: `floor(u)` selects the lap, the fraction selects the
 * spot, so `0`, `1` and `-1` are the same colour and any value (including a
 * negative phase or a non-finite number) is safe. Interpolation is **linear in
 * OKLCH** (not smoothstep, not per-channel sRGB): a long period makes smoothstep
 * dwell at the anchors and rush through the middle, and sRGB mixing dips through
 * grey on wide hue legs.
 *
 * Hue is monotone across the whole cycle: the ring is sorted by hue and the wrap
 * segment adds 360°, so the ramp never reverses. `NaN`/`±Infinity` are treated as
 * the start of the cycle.
 */
export function ansiAtCyclePosition(u: number, anchors: Oklch[], mode: GradientColorMode): string {
  const ring = anchors.length > 0 ? anchors : [rgbToOklch(NEUTRAL_RGB)];
  const position = Number.isFinite(u) ? u - Math.floor(u) : 0;

  const count = ring.length;
  const scaled = position * count;
  const index = Math.floor(scaled) % count;
  const t = clamp01(scaled - Math.floor(scaled));

  const from = ring[index]!;
  const to = ring[(index + 1) % count]!;
  // Sorted hues ascend; the wrap leg continues upwards by 360 instead of
  // running backwards, so the whole ramp is monotone.
  const toHue = count === 1 ? from.h : index === count - 1 ? to.h + 360 : to.h;

  const rgb = oklchToRgb({
    l: from.l + (to.l - from.l) * t,
    c: from.c + (to.c - from.c) * t,
    h: from.h + (toHue - from.h) * t,
  });

  return mode === "truecolor"
    ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
    : `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
}

export interface PaintContext {
  /** Pattern offset in laps (0 = static); the animator drives it from the clock. */
  phase: number;
  /** Prepared anchor ring (`prepareAnchors`): OKLCH, sorted by hue, de-duplicated. */
  anchors: Oklch[];
  mode: GradientColorMode;
  /** Colour for every non-dash character (scroll hint text, blanks). */
  labelAnsi: string;
}

/**
 * Colour a plain (uncoloured) border line.
 *
 * Every dash gets its own colour: column `c` sits at cycle position
 * `c / CYCLE_CHARS + phase`, so adjacent characters are `1/CYCLE_CHARS` of a lap
 * apart and no wide uniform block can appear. Everything else (scroll-hint text,
 * blanks) takes `labelAnsi`. Adjacent characters that resolve to the same colour
 * are still merged into one run — that matters in 256-colour mode, where the
 * quantiser regularly maps neighbouring tones onto the same palette entry.
 *
 * Only foreground colours are emitted, and the line ends with `\x1b[39m` so the
 * terminal's foreground colour does not leak into whatever the TUI writes next.
 *
 * Cost note: one SGR prefix per column (15–19 bytes in truecolor) is what "one
 * colour per character" costs; DESIGN.md §37.4 records the measured bytes per
 * frame. The heartbeat interval is not lowered to hide that.
 *
 * Implementation assumption: border lines contain single-column characters only
 * (dashes, blanks, `↑`/`↓`, ASCII hint text), so the character index equals the
 * column. If a future version seeds the border with wide characters (CJK/emoji),
 * columns must be accumulated with `visibleWidth` instead of counting characters.
 */
/**
 * Build a painter for one render: it caches the ANSI sequence of each of the
 * `CYCLE_CHARS` positions, so the top and bottom border of the same frame share
 * one computation per column residue.
 *
 * The colour is periodic in `CYCLE_CHARS`, so column c and c - CYCLE_CHARS are
 * *exactly* the same colour at a fixed phase: the cache is lossless, not an
 * approximation. A 120-column line needs 48 colour computations instead of 120,
 * 200 columns 48 instead of 200, and both borders together 48 instead of 96.
 */
export function createBorderPainter(paint: PaintContext): (plain: string) => string {
  const cachedColors: Array<string | undefined> = new Array(CYCLE_CHARS);
  const colorForColumn = (column: number): string => {
    const residue = column % CYCLE_CHARS;
    const cached = cachedColors[residue];
    if (cached !== undefined) return cached;
    const computed = ansiAtCyclePosition(column / CYCLE_CHARS + paint.phase, paint.anchors, paint.mode);
    cachedColors[residue] = computed;
    return computed;
  };

  return (plain: string): string => paintWith(plain, paint, colorForColumn);
}

/** Colour one line; thin wrapper over `createBorderPainter` for single-line callers. */
export function paintBorderLine(plain: string, paint: PaintContext): string {
  return createBorderPainter(paint)(plain);
}

function paintWith(plain: string, paint: PaintContext, colorForColumn: (column: number) => string): string {
  if (plain.length === 0) return "";

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
