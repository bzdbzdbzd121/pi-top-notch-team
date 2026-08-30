import { describe, it, expect } from "vitest";
import {
  MEMBER_THINKING_LEVELS,
  isMemberThinkingLevel,
  getSupportedThinkingLevelsFor,
  resolveMemberThinking,
  describeMemberThinkingSetting,
} from "./resolve-thinking";

describe("getSupportedThinkingLevelsFor（复刻 pi-ai 语义）", () => {
  it("非 reasoning 模型仅支持 off", () => {
    expect(getSupportedThinkingLevelsFor({ reasoning: false })).toEqual(["off"]);
    expect(getSupportedThinkingLevelsFor({})).toEqual(["off"]);
  });

  it("reasoning 模型且无 thinkingLevelMap：支持除 xhigh/max 外的全部级别", () => {
    expect(getSupportedThinkingLevelsFor({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("thinkingLevelMap 条目为 null 的级别被排除（即使 off/minimal/low/medium/high）", () => {
    expect(
      getSupportedThinkingLevelsFor({
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null },
      })
    ).toEqual(["low", "medium", "high"]);
  });

  it("thinkingLevelMap 含 xhigh/max 条目时这两个级别被纳入", () => {
    expect(
      getSupportedThinkingLevelsFor({
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: null },
      })
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("thinkingLevelMap 中 xhigh/max 值为 null 时不纳入", () => {
    expect(
      getSupportedThinkingLevelsFor({
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: "max" },
      })
    ).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
  });
});

describe("isMemberThinkingLevel", () => {
  it("接受全部 7 个级别", () => {
    for (const level of MEMBER_THINKING_LEVELS) {
      expect(isMemberThinkingLevel(level)).toBe(true);
    }
  });

  it("拒绝非法值", () => {
    expect(isMemberThinkingLevel("ultra")).toBe(false);
    expect(isMemberThinkingLevel(3)).toBe(false);
    expect(isMemberThinkingLevel(undefined)).toBe(false);
  });
});

describe("resolveMemberThinking", () => {
  it("未配置级别 → undefined（保持现状）", () => {
    expect(resolveMemberThinking(undefined, ["off", "high"])).toBeUndefined();
  });

  it("模型支持该级别 → 原样返回", () => {
    expect(resolveMemberThinking("high", ["off", "low", "high"])).toBe("high");
    expect(resolveMemberThinking("off", ["off"])).toBe("off");
  });

  it("模型不支持该级别 → undefined（保持 pi 默认，不做就近 clamp）", () => {
    // xhigh 不在支持集（部分支持模型）→ 不传 flag
    expect(resolveMemberThinking("xhigh", ["off", "low", "medium", "high"])).toBeUndefined();
    // 非 reasoning 模型请求任何思考 → 不传 flag
    expect(resolveMemberThinking("medium", ["off"])).toBeUndefined();
  });

  it("支持集未知（fail-open）→ undefined", () => {
    expect(resolveMemberThinking("high", undefined)).toBeUndefined();
  });
});

describe("describeMemberThinkingSetting", () => {
  it("未配置 → 默认标签", () => {
    expect(describeMemberThinkingSetting({})).toBe("默认（不指定）");
  });

  it("已配置 → 指定级别标签", () => {
    expect(describeMemberThinkingSetting({ memberThinkingLevel: "high" })).toBe(
      "指定级别：high"
    );
  });
});
