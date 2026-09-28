import { describe, it, expect } from "vitest";

// ── 阶段 2：输入行渲染纯函数 buildInputBoxLine ──────────────
//
// NOTE: this file deliberately does NOT mock @earendil-works/pi-tui — the
// width contract (visibleWidth(result) === width, CJK/emoji window never
// splitting a grapheme) needs the real visibleWidth. The mocked state test
// files cannot validate widths (visibleWidth = text.length there).
//
// Output contract (§7.4): the returned line is exactly `width` visible
// columns wide, structured as `> ` + window-before + cursorMarker + `▌` +
// window-after + space padding. The component wraps it as
// `│ ✎ <line> │`, so the outer fallback truncate/pad never fires — this is
// the fix for the old long-input defect where the fallback ellipsis ate the
// cursor glyph.

import { visibleWidth } from "@earendil-works/pi-tui";
import { buildInputBoxLine } from "./member-inspector-state";

const FAMILY = "👨‍👩‍👧"; // ZWJ family: 8 UTF-16 units, 2 visible columns

/** Every grapheme of `text` (for "window never splits a character" checks). */
function graphemes(text: string): string[] {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return [...seg.segment(text)].map((p) => p.segment);
}

describe("buildInputBoxLine — width contract", () => {
  it("结果可见宽度恒等于 width（空/短/长/CJK/emoji × 光标头/中/尾）", () => {
    const buffers = [
      "",
      "a",
      "abcd",
      "你好世界",
      FAMILY + "🇨🇳",
      "x".repeat(200),
      "汉字".repeat(80),
      FAMILY.repeat(20),
      "\u{1F3FD}abc", // 孤立肤色修饰符：跨边界宽度不可加（重要 1）
    ];
    for (const width of [16, 40, 74]) {
      for (const buffer of buffers) {
        for (const cursor of [0, Math.floor(buffer.length / 2), buffer.length]) {
          const line = buildInputBoxLine(buffer, cursor, width);
          expect(visibleWidth(line), `w=${width} buf=${JSON.stringify(buffer)} cur=${cursor}`).toBe(width);
        }
      }
    }
  });

  it("极窄窗口（0..4 列）不抛错且宽度精确", () => {
    for (const width of [0, 1, 2, 3, 4]) {
      const line = buildInputBoxLine("abc", 1, width);
      expect(visibleWidth(line), `w=${width}`).toBe(width);
    }
    expect(buildInputBoxLine("abc", 1, 0)).toBe("");
    expect(buildInputBoxLine("abc", 1, 1)).toBe(">");
    expect(buildInputBoxLine("abc", 1, 2)).toBe("> ");
    expect(buildInputBoxLine("abc", 1, 3)).toBe("> ▌");
  });

  it("空内容 → `> ▌` + 补齐；短内容全量显示、光标在真实位置", () => {
    expect(buildInputBoxLine("", 0, 8)).toBe("> ▌" + " ".repeat(5));
    expect(buildInputBoxLine("abcd", 4, 10)).toBe("> abcd▌" + " ".repeat(3));
    // 光标中段：ab|cd → `> ab▌cd`（光标画在真实位置，不是行尾）
    expect(buildInputBoxLine("abcd", 2, 10)).toBe("> ab▌cd" + " ".repeat(3));
  });

  it("正文恰好装满一行时不滚动（窗口起点 0）", () => {
    // width 8 → A=6, 正文预算 5：`abcde` 恰好装满
    expect(buildInputBoxLine("abcde", 5, 8)).toBe("> abcde▌");
    // 多一个字符 → 滚动，尾部贴边
    expect(buildInputBoxLine("abcdef", 6, 8)).toBe("> bcdef▌");
  });
});

describe("buildInputBoxLine — 长输入横向窗口（既有缺陷修复）", () => {
  it("光标在末尾 → 显示尾部窗口，▌ 在行内（旧缺陷：被省略号顶掉）", () => {
    expect(buildInputBoxLine("x".repeat(40), 40, 16)).toBe("> " + "x".repeat(13) + "▌");
  });

  it("光标在开头 → 显示头部窗口，▌ 紧跟提示符", () => {
    expect(buildInputBoxLine("x".repeat(40), 0, 16)).toBe("> ▌" + "x".repeat(13));
  });

  it("光标在中段 → 窗口居中，光标前后都能看到内容", () => {
    const buffer = "0123456789".repeat(4); // 40 chars
    expect(buildInputBoxLine(buffer, 20, 16)).toBe("> 456789▌0123456");
  });

  it("中文长输入：窗口不切半个汉字、行宽精确", () => {
    const buffer = "汉字".repeat(40); // 80 chars = 160 cols
    // 末尾：从 col 148 起取 6 个完整汉字（12 列）+ ▌ + 1 列补齐
    // （char 74 是偶数下标 → "汉"）
    const tail = buildInputBoxLine(buffer, buffer.length, 16);
    expect(tail).toBe("> " + "汉字汉字汉字" + "▌" + " ");
    expect(visibleWidth(tail)).toBe(16);
    // 中段：窗口两侧都是完整汉字（UTF-16 下标 40 = 第 20 个字符，列 80）
    const mid = buildInputBoxLine(buffer, 40, 16);
    expect(mid).toBe("> 字汉字▌汉字汉" + " ");
    expect(visibleWidth(mid)).toBe(16);
  });

  it("emoji ZWJ 家族长输入：窗口只含完整家族（绝不切半个）", () => {
    const buffer = FAMILY.repeat(20);
    const end = buildInputBoxLine(buffer, buffer.length, 16);
    expect(end).toBe("> " + FAMILY.repeat(6) + "▌" + " ");
    beEveryGraphemeIsFamily(end);

    const mid = buildInputBoxLine(buffer, FAMILY.length * 5, 16);
    expect(mid).toBe("> " + FAMILY.repeat(3) + "▌" + FAMILY.repeat(3) + " ");
    beEveryGraphemeIsFamily(mid);
  });
});

/** Split on `▌`/padding and assert every content grapheme is a whole family. */
function beEveryGraphemeIsFamily(line: string) {
  const body = line.slice(2).split("▌")[0]; // before the cursor glyph
  for (const g of graphemes(body)) {
    expect(g).toBe(FAMILY);
  }
}

describe("buildInputBoxLine — 防御性光标钳制", () => {
  it("越界光标值被钳制到 0..length", () => {
    expect(buildInputBoxLine("abc", 99, 10)).toBe(buildInputBoxLine("abc", 3, 10));
    expect(buildInputBoxLine("abc", -5, 10)).toBe(buildInputBoxLine("abc", 0, 10));
  });

  it("落在簇内部的光标吸附到可见字符边界（不切半个组合字符）", () => {
    const buffer = "e\u0301x"; // é (2 units, 1 visible col) + x
    expect(buildInputBoxLine(buffer, 1, 10)).toBe(buildInputBoxLine(buffer, 2, 10));
    expect(buildInputBoxLine(buffer, 1, 10)).toBe("> " + "e\u0301" + "▌x" + " ".repeat(5));
  });
});

// 孤立肤色修饰符（U+1F3FB–1F3FF）跨边界宽度不可加：单独量 2 列，紧跟提示符
// 空格或光标符号后按 0 计——pad 必须按装配结果实测，不能由逐簇宽度求和推导
// （重要 1 回归）。
const ORPHAN_TONE = "\u{1F3FD}";

describe("buildInputBoxLine — 孤立肤色修饰符（重要 1 回归）", () => {
  it("首簇为孤立肤色修饰符时宽度仍精确（光标头/中/尾）", () => {
    const buffer = ORPHAN_TONE + "abc";
    // 装配结果 "> 🏽ab▌c" 实测 6 列 → 补 4 列空（旧实现按簇求和只补 2 列）
    expect(buildInputBoxLine(buffer, 4, 10)).toBe("> " + ORPHAN_TONE + "ab▌c" + " ".repeat(4));
    expect(buildInputBoxLine(buffer, 0, 10)).toBe("> ▌" + ORPHAN_TONE + "abc" + " ".repeat(4));
    expect(buildInputBoxLine(buffer, buffer.length, 10)).toBe(
      "> " + ORPHAN_TONE + "abc▌" + " ".repeat(4)
    );
    for (const cursor of [0, 2, 4, buffer.length]) {
      expect(visibleWidth(buildInputBoxLine(buffer, cursor, 10)), `cursor=${cursor}`).toBe(10);
    }
  });

  it("长窗口（孤立修饰符重复）宽度精确且 ▌ 可见", () => {
    const buffer = ORPHAN_TONE.repeat(20);
    for (const cursor of [0, Math.floor(buffer.length / 2), buffer.length]) {
      const line = buildInputBoxLine(buffer, cursor, 16);
      expect(visibleWidth(line), `cursor=${cursor}`).toBe(16);
      expect(line).toContain("▌");
    }
  });
});

describe("buildInputBoxLine — cursorMarker 参数（阶段 3 预留契约）", () => {
  it("零宽标记插在 ▌ 之前且不改变宽度（与默认空串一致）", () => {
    const marker = "\x1b[0m"; // 零宽 ANSI 占位标记
    const plain = buildInputBoxLine("abcd", 2, 10);
    const withMarker = buildInputBoxLine("abcd", 2, 10, marker);
    expect(plain).toBe("> ab▌cd" + " ".repeat(3));
    expect(withMarker).toBe("> ab" + marker + "▌cd" + " ".repeat(3));
    expect(visibleWidth(withMarker)).toBe(10);
    expect(withMarker.indexOf(marker)).toBe(withMarker.indexOf("▌") - marker.length);
    expect(buildInputBoxLine("abcd", 2, 10, "")).toBe(plain); // 显式空串 = 默认
  });

  it("非零宽标记（调用方错误）也被宽度契约兜住：从尾部整簇回退", () => {
    // "MM" 有 2 列宽：装配 8 列 > width 6 → 光标后为空 → 从光标前回退整簇
    expect(buildInputBoxLine("abc", 3, 6, "MM")).toBe("> aMM▌");
    expect(visibleWidth(buildInputBoxLine("abc", 3, 6, "MM"))).toBe(6);
  });
});
