import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { rgbToAnsi256 } from "./border-gradient.js";
import {
  FALLBACK_16, FALLBACK_RGB, OP_CLASSES, OP_TOKEN, resolveAnsi, type OpClass, type PaletteSource,
} from "./member-overview-palette.js";

const source = (mode: PaletteSource["mode"], ansi: PaletteSource["ansi"]): PaletteSource => ({ mode, ansi });

describe("member overview palette", () => {
  it("uses the theme token verbatim when the theme provides it", () => {
    for (const cls of OP_CLASSES) {
      const ansi = (token: string) => token === OP_TOKEN[cls] ? `\x1b[38;2;1;2;3m|${token}|` : undefined;
      expect(resolveAnsi(cls, source("truecolor", ansi))).toBe(`\x1b[38;2;1;2;3m|${OP_TOKEN[cls]}|`);
      expect(resolveAnsi(cls, source("256color", ansi))).toBe(`\x1b[38;2;1;2;3m|${OP_TOKEN[cls]}|`);
    }
  });

  it("falls back to the fixed RGB palette when the token is missing, empty, or throws", () => {
    expect(resolveAnsi("thinking", source("truecolor", () => undefined))).toBe("\x1b[38;2;95;135;175m");
    expect(resolveAnsi("thinking", source("truecolor", () => ""))).toBe("\x1b[38;2;95;135;175m");
    expect(resolveAnsi("thinking", source("truecolor", () => { throw new Error("unknown token"); })))
      .toBe("\x1b[38;2;95;135;175m");
    // 256-color mode quantises the same fixed RGB (appendix A: #5f87af → 67).
    expect(rgbToAnsi256(FALLBACK_RGB.thinking)).toBe(67);
    expect(resolveAnsi("thinking", source("256color", () => undefined))).toBe("\x1b[38;5;67m");
  });

  it("emits nothing when colour is explicitly off, and the 16-colour table only for an unknown mode", () => {
    for (const cls of OP_CLASSES) {
      // "none" is the caller saying "no colour" — basic ANSI here would lie and cost bytes.
      expect(resolveAnsi(cls, source("none", () => "\x1b[38;2;9;9;9m"))).toBe("");
      expect(resolveAnsi(cls, source("bogus" as PaletteSource["mode"], () => undefined))).toBe(`\x1b[${FALLBACK_16[cls]}m`);
    }
  });

  it("degrades to 'no colour' instead of throwing when nothing is usable", () => {
    const unknown = "nope" as OpClass;
    expect(resolveAnsi(unknown, source("truecolor", () => undefined))).toBe("");
    expect(resolveAnsi(unknown, source("256color", () => { throw new Error("boom"); }))).toBe("");
    expect(resolveAnsi(unknown, source("none", () => undefined))).toBe("");
    expect(resolveAnsi(unknown, source("bogus" as PaletteSource["mode"], () => undefined))).toBe("");
    expect(visibleWidth(resolveAnsi("read", source("truecolor", () => undefined)))).toBe(0);
  });

  it("pins the appendix A token and 16-colour assignments", () => {
    expect(OP_TOKEN).toEqual({
      thinking: "thinkingLow", output: "text", read: "syntaxType", modify: "customMessageLabel",
      tool: "warning", failed: "error", compact: "warning", crash: "error", stop: "muted",
      complete: "dim", busySilent: "muted", unknown: "dim", idle: "muted",
    });
    expect(FALLBACK_16).toEqual({
      thinking: 94, output: 39, read: 96, modify: 95, tool: 93, failed: 91, compact: 93,
      crash: 91, stop: 90, complete: 90, busySilent: 90, unknown: 90, idle: 90,
    });
    // §A: the only deliberate deviations from the dark theme are tool (amber) and output (neutral).
    expect(FALLBACK_RGB.tool).toEqual({ r: 0xd7, g: 0xaf, b: 0x5f });
    expect(FALLBACK_RGB.output).toEqual({ r: 0xc8, g: 0xc8, b: 0xc8 });
  });

  it("keeps every fallback colour mid-luminance so it stays readable on dark and light themes", () => {
    for (const cls of OP_CLASSES) {
      const { r, g, b } = FALLBACK_RGB[cls];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      expect(luma).toBeGreaterThan(90);
      expect(luma).toBeLessThan(230);
    }
  });
});
