import { describe, it, expect } from "vitest";
import {
  TEAM_NAME_MAX_WIDTH,
  UNNAMED_TEAM_DISPLAY,
  describeTeamNameRules,
  isSyntheticTeamName,
  normalizeTeamName,
} from "./team-name";

describe("constants", () => {
  it("team name width limit is 20 display columns", () => {
    expect(TEAM_NAME_MAX_WIDTH).toBe(20);
  });

  it("unnamed placeholder is the agreed display text", () => {
    expect(UNNAMED_TEAM_DISPLAY).toBe("未命名团队");
  });
});

describe("normalizeTeamName — 合法名字", () => {
  it.each([
    ["登录重构", "登录重构"],
    ["auth-refactor", "auth-refactor"],
    ["v2 订单并发", "v2-订单并发"],
    ["a_b", "a_b"],
    ["团队-2", "团队-2"],
  ])("接受 %s → %s", (raw, expected) => {
    const result = normalizeTeamName(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe(expected);
  });

  it("marks adjusted when whitespace was folded", () => {
    const result = normalizeTeamName("v2 订单并发");
    expect(result.ok && result.name).toBe("v2-订单并发");
    expect(result.ok && result.adjusted).toBe(true);
  });

  it("does not mark adjusted for an already-normalized name", () => {
    const result = normalizeTeamName("登录重构");
    expect(result.ok && result.adjusted).toBe(false);
  });

  it("folds consecutive whitespace runs into a single hyphen", () => {
    const result = normalizeTeamName("v2   订单");
    expect(result.ok && result.name).toBe("v2-订单");
  });

  it("folds the ideographic space used by CJK input methods", () => {
    const result = normalizeTeamName("v2\u3000订单");
    expect(result.ok && result.name).toBe("v2-订单");
  });

  it("trims surrounding whitespace and reports the adjustment", () => {
    const result = normalizeTeamName("  登录重构  ");
    expect(result.ok && result.name).toBe("登录重构");
    expect(result.ok && result.adjusted).toBe(true);
  });

  it("applies NFC so decomposed combining sequences become single letters", () => {
    const result = normalizeTeamName("cafe\u0301");
    expect(result.ok && result.name).toBe("café");
    expect(result.ok && result.adjusted).toBe(true);
  });

  it("never applies NFKC (fullwidth digits stay as typed)", () => {
    const result = normalizeTeamName("１号");
    expect(result.ok && result.name).toBe("１号");
    expect(result.ok && result.adjusted).toBe(false);
  });

  it("accepts other-language letters and Hangul", () => {
    for (const raw of ["café", "日本語", "한글", "Ωmega"]) {
      expect(normalizeTeamName(raw).ok).toBe(true);
    }
  });

  it("accepts names that are exactly TEAM_NAME_MAX_WIDTH columns", () => {
    const ascii20 = "a".repeat(TEAM_NAME_MAX_WIDTH);
    const cjk10 = "一二三四五六七八九十"; // 10 CJK characters = 20 columns
    const mixed20 = "登录重构" + "a".repeat(12); // 8 + 12 = 20 columns
    for (const raw of [ascii20, cjk10, mixed20]) {
      const result = normalizeTeamName(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.name).toBe(raw);
    }
  });
});

describe("normalizeTeamName — 拒绝矩阵", () => {
  it.each([
    ["", "不能为空"],
    ["   ", "不能为空"],
    ["\t \u3000", "不能为空"],
    ["a/b", "不允许的字符"],
    ["a\\b", "不允许的字符"],
    ["..", "不允许的字符"],
    [".", "不允许的字符"],
    ["a.b", "不允许的字符"],
    ["a\nb", "不允许的字符"],
    ["a\rb", "不允许的字符"],
    ["a\tb", "不允许的字符"],
    ["a\u0000b", "不允许的字符"],
    ["a\u0007b", "不允许的字符"],
    ["🚀team", "不允许的字符"],
    ["team🚀", "不允许的字符"],
    ["第①批", "不允许的字符"],
    ["-abc", "必须以字母或数字开头并结尾"],
    ["abc-", "必须以字母或数字开头并结尾"],
    ["_abc", "必须以字母或数字开头并结尾"],
    ["abc_", "必须以字母或数字开头并结尾"],
    ["a".repeat(TEAM_NAME_MAX_WIDTH + 1), "上限 20 列"],
    ["一二三四五六七八九十百", "上限 20 列"],
  ])("拒绝 %j（原因含 %s）", (raw, expectedReason) => {
    const result = normalizeTeamName(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(expectedReason);
    expect(result.reason).toContain(describeTeamNameRules());
  });

  it.each([["CON"], ["con"], ["PrN"], ["AUX"], ["NUL"], ["COM1"], ["com1"], ["COM9"], ["LPT1"], ["lpt9"]])(
    "拒绝 Windows 预留设备名 %s",
    (raw) => {
      const result = normalizeTeamName(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("Windows 预留设备名");
      expect(result.reason).toContain(describeTeamNameRules());
    },
  );

  it.each([["CONSOLE"], ["COM10"], ["NULL"], ["LPT"]])("不误伤看起来相似的普通名字 %s", (raw) => {
    expect(normalizeTeamName(raw).ok).toBe(true);
  });

  it.each([[null], [undefined], [42], [{}], [[]], [true]])("拒绝非文本输入 %j", (raw) => {
    const result = normalizeTeamName(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("必须是文本");
  });

  it("names the offending character in the rejection reason", () => {
    const circled = normalizeTeamName("第①批");
    expect(circled.ok).toBe(false);
    if (!circled.ok) expect(circled.reason).toContain("①");

    const tooLong = normalizeTeamName("一二三四五六七八九十百");
    expect(tooLong.ok).toBe(false);
    // 11 CJK characters = 22 display columns — the reason states the real width.
    if (!tooLong.ok) expect(tooLong.reason).toContain("22 显示列");
  });

  it("escapes control characters in the rejection reason", () => {
    const result = normalizeTeamName("a\nb");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("U+000A");
      expect(result.reason).not.toContain("\n\n");
    }
  });
});

describe("isSyntheticTeamName", () => {
  it.each([["_dynamic_1789456123456"], ["_dynamic_"], ["_dynamic_mw6pqfb4"]])("系统兜底名 %s → true", (name) => {
    expect(isSyntheticTeamName(name)).toBe(true);
  });

  it.each([["登录重构"], ["dynamic"], ["_dynamo_x"], ["dynamic_1"], ["_dynamic"], [""]])("%j 不是兜底名", (name) => {
    expect(isSyntheticTeamName(name)).toBe(false);
  });

  it("every accepted user name is structurally not synthetic", () => {
    const accepted = ["登录重构", "auth-refactor", "v2-订单并发", "a_b", "团队-2", "a".repeat(20), "１号"];
    for (const raw of accepted) {
      const result = normalizeTeamName(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(isSyntheticTeamName(result.name)).toBe(false);
    }
    // Users cannot produce the reserved namespace: it starts with a symbol.
    expect(normalizeTeamName("_dynamic_1789456123456").ok).toBe(false);
  });
});

describe("describeTeamNameRules", () => {
  it("interpolates the width limit from the constant", () => {
    expect(describeTeamNameRules()).toContain(String(TEAM_NAME_MAX_WIDTH));
  });

  it("states the allowed characters, edge rule, reserved names and space folding", () => {
    const rules = describeTeamNameRules();
    expect(rules).toContain("字母");
    expect(rules).toContain("数字");
    expect(rules).toContain("下划线");
    expect(rules).toContain("Windows");
    expect(rules).toContain("空格");
  });
});
