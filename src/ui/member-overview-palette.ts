import { rgbToAnsi256, type Rgb } from "./border-gradient";

/**
 * Colour class of one timeline cell (and of a status word, see
 * `statusClass()` in `member-overview-badge.ts`).
 *
 * The design lists eleven classes; this module adds two explicit ones:
 * `failed` (a tool that ended with an error — §3.4 requires the cell to show the
 * failure colour rather than the category colour) and `idle` (an observed but
 * empty cell — §E's blank glyph, which `paintLane()` must name explicitly to stay
 * total instead of returning `undefined`).
 */
export type OpClass =
  | "thinking" | "output" | "read" | "modify" | "tool" | "failed"
  | "compact" | "crash" | "stop" | "complete" | "busySilent" | "unknown" | "idle";

export const OP_CLASSES: readonly OpClass[] = Object.freeze([
  "thinking", "output", "read", "modify", "tool", "failed", "compact",
  "crash", "stop", "complete", "busySilent", "unknown", "idle",
]);

export type ColorMode = "truecolor" | "256color" | "none";

/** Everything the palette needs from the live theme; never throws outward. */
export interface PaletteSource {
  /** ANSI prefix for a theme token, or undefined when the token is unavailable. */
  ansi(token: string): string | undefined;
  mode: ColorMode;
}

/** Theme tokens (§A): the primary layer, so colours follow the user's theme. */
export const OP_TOKEN: Record<OpClass, string> = Object.freeze({
  thinking: "thinkingLow",
  output: "text",
  read: "syntaxType",
  modify: "customMessageLabel",
  tool: "warning",
  failed: "error",
  compact: "warning",
  crash: "error",
  stop: "muted",
  complete: "dim",
  busySilent: "muted",
  unknown: "dim",
  idle: "muted",
});

/** Fixed RGB fallback (§A, second layer) — used when a custom theme lacks a token. */
export const FALLBACK_RGB: Record<OpClass, Rgb> = Object.freeze({
  thinking: { r: 0x5f, g: 0x87, b: 0xaf },
  output: { r: 0xc8, g: 0xc8, b: 0xc8 },
  read: { r: 0x4e, g: 0xc9, b: 0xb0 },
  modify: { r: 0x95, g: 0x75, b: 0xcd },
  tool: { r: 0xd7, g: 0xaf, b: 0x5f },
  failed: { r: 0xcc, g: 0x66, b: 0x66 },
  compact: { r: 0xd7, g: 0xaf, b: 0x5f },
  crash: { r: 0xcc, g: 0x66, b: 0x66 },
  stop: { r: 0x80, g: 0x80, b: 0x80 },
  complete: { r: 0x66, g: 0x66, b: 0x66 },
  busySilent: { r: 0x80, g: 0x80, b: 0x80 },
  unknown: { r: 0x66, g: 0x66, b: 0x66 },
  idle: { r: 0x80, g: 0x80, b: 0x80 },
});

/** Basic SGR foregrounds (§A, third layer): only reached when no richer mode exists. */
export const FALLBACK_16: Record<OpClass, number> = Object.freeze({
  thinking: 94,
  output: 39,
  read: 96,
  modify: 95,
  tool: 93,
  failed: 91,
  compact: 93,
  crash: 91,
  stop: 90,
  complete: 90,
  busySilent: 90,
  unknown: 90,
  idle: 90,
});

/**
 * Three-layer colour resolution: theme token → fixed RGB (truecolor/256) →
 * basic 16-colour SGR. Any failure degrades instead of throwing — `theme.getFgAnsi`
 * throws for unknown tokens and pi's render loop has no boundary guard.
 *
 * `mode: "none"` means colour is explicitly off, so nothing is emitted: writing
 * basic ANSI anyway would contradict the caller and add bytes to every frame.
 * The 16-colour layer is only the fallback for a mode we cannot recognise.
 */
export function resolveAnsi(cls: OpClass, source: PaletteSource): string {
  const token = OP_TOKEN[cls];
  const mode = source.mode;
  if (mode === "truecolor" || mode === "256color") {
    if (token) {
      try {
        const direct = source.ansi(token);
        // An empty string carries no escape at all; treat it as unavailable.
        if (typeof direct === "string" && direct.length > 0) return direct;
      } catch {
        /* fall through to the fixed palette */
      }
    }
    const rgb = FALLBACK_RGB[cls];
    if (rgb) {
      return mode === "truecolor"
        ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`
        : `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
    }
  }
  if (mode === "none") return "";
  const basic = FALLBACK_16[cls];
  return Number.isSafeInteger(basic) ? `\x1b[${basic}m` : "";
}
