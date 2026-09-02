import { describe, it, expect } from "vitest";
import {
  MEMBER_THINKING_LEVELS,
  isMemberThinkingLevel,
  getSupportedThinkingLevelsFor,
  resolveMemberThinking,
  describeMemberThinkingSetting,
  parseMemberThinkingSetting,
  type MemberThinkingSetting,
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

  it("拒绝非法值（follow 是模式不是级别，绝不混入级别值域）", () => {
    expect(isMemberThinkingLevel("follow")).toBe(false);
    expect(isMemberThinkingLevel("ultra")).toBe(false);
    expect(isMemberThinkingLevel(3)).toBe(false);
    expect(isMemberThinkingLevel(undefined)).toBe(false);
  });
});

describe("parseMemberThinkingSetting（旧字符串迁移 + 新对象校验，原始 YAML 值守卫）", () => {
  it("旧字符串形态（合法 7 级别）→ fixed 对象", () => {
    for (const level of MEMBER_THINKING_LEVELS) {
      expect(parseMemberThinkingSetting(level)).toEqual({ mode: "fixed", level });
    }
  });

  it("字符串 follow（手写/未来形态）→ follow 对象", () => {
    expect(parseMemberThinkingSetting("follow")).toEqual({ mode: "follow" });
  });

  it("新形态对象原样通过（幂等）", () => {
    const follow: MemberThinkingSetting = { mode: "follow" };
    const fixed: MemberThinkingSetting = { mode: "fixed", level: "high" };
    const fixedNoLevel: MemberThinkingSetting = { mode: "fixed" };
    expect(parseMemberThinkingSetting(follow)).toEqual(follow);
    expect(parseMemberThinkingSetting(fixed)).toEqual(fixed);
    expect(parseMemberThinkingSetting(fixedNoLevel)).toEqual(fixedNoLevel);
  });

  it("follow 对象携带 level → 规范化丢弃 level（follow 模式 level 无意义）", () => {
    expect(parseMemberThinkingSetting({ mode: "follow", level: "high" })).toEqual({
      mode: "follow",
    });
  });

  it("fixed + 非法 level → 整体丢弃（fail-open）", () => {
    expect(parseMemberThinkingSetting({ mode: "fixed", level: "ultra" })).toBeUndefined();
    expect(parseMemberThinkingSetting({ mode: "fixed", level: 3 })).toBeUndefined();
  });

  it("未知 mode → 丢弃", () => {
    expect(parseMemberThinkingSetting({ mode: "bogus" })).toBeUndefined();
    // 三态 default 被否决：显式 default 是伪状态，undefined 已表达默认
    expect(parseMemberThinkingSetting({ mode: "default" })).toBeUndefined();
  });

  it("非法值（非字符串非对象）→ 丢弃", () => {
    expect(parseMemberThinkingSetting("ultra")).toBeUndefined();
    expect(parseMemberThinkingSetting(3)).toBeUndefined();
    expect(parseMemberThinkingSetting(null)).toBeUndefined();
    expect(parseMemberThinkingSetting(undefined)).toBeUndefined();
    expect(parseMemberThinkingSetting(["high"])).toBeUndefined();
    expect(parseMemberThinkingSetting(true)).toBeUndefined();
  });
});

describe("resolveMemberThinking（对象化设置 + TL 级别 + 支持集）", () => {
  it("未配置 → undefined（保持现状）", () => {
    expect(resolveMemberThinking(undefined, "high", ["off", "high"])).toBeUndefined();
  });

  it("fixed + 级别 + 模型支持 → 原样返回", () => {
    expect(
      resolveMemberThinking({ mode: "fixed", level: "high" }, undefined, ["off", "low", "high"])
    ).toBe("high");
    expect(resolveMemberThinking({ mode: "fixed", level: "off" }, undefined, ["off"])).toBe(
      "off"
    );
  });

  it("fixed + 模型不支持 → undefined（保持 pi 默认，不做就近 clamp）", () => {
    // xhigh 不在支持集（部分支持模型）→ 不传 flag
    expect(
      resolveMemberThinking({ mode: "fixed", level: "xhigh" }, undefined, [
        "off",
        "low",
        "medium",
        "high",
      ])
    ).toBeUndefined();
    // 非 reasoning 模型请求任何思考 → 不传 flag
    expect(resolveMemberThinking({ mode: "fixed", level: "medium" }, undefined, ["off"])).toBeUndefined();
  });

  it("fixed + 缺 level → undefined（视为默认，与 MemberModelSetting fixed 无 model 回退先例一致）", () => {
    expect(resolveMemberThinking({ mode: "fixed" }, undefined, ["off", "high"])).toBeUndefined();
  });

  it("follow + TL 级别 + 模型支持 → 返回 TL 级别", () => {
    expect(resolveMemberThinking({ mode: "follow" }, "high", ["off", "low", "high"])).toBe(
      "high"
    );
    expect(resolveMemberThinking({ mode: "follow" }, "off", ["off"])).toBe("off");
  });

  it("follow + TL 级别 + 模型不支持 → undefined（fail-open 不 clamp）", () => {
    // TL=xhigh、成员仅支持到 high → 不传 flag（成员侧 pi 也会 clamp，预检 fail-open 可预测性严格更优）
    expect(
      resolveMemberThinking({ mode: "follow" }, "xhigh", ["off", "low", "medium", "high"])
    ).toBeUndefined();
  });

  it("follow + TL 级别未知 → undefined（fail-open，spawn 早期竞态）", () => {
    expect(resolveMemberThinking({ mode: "follow" }, undefined, ["off", "high"])).toBeUndefined();
  });

  it("支持集未知 → undefined（fail-open，fixed 与 follow 同路径）", () => {
    expect(resolveMemberThinking({ mode: "fixed", level: "high" }, undefined, undefined)).toBeUndefined();
    expect(resolveMemberThinking({ mode: "follow" }, "high", undefined)).toBeUndefined();
  });
});

describe("describeMemberThinkingSetting", () => {
  it("未配置 → 默认标签", () => {
    expect(describeMemberThinkingSetting({})).toBe("默认（不指定）");
  });

  it("fixed + 级别 → 指定级别标签", () => {
    expect(
      describeMemberThinkingSetting({ memberThinkingLevel: { mode: "fixed", level: "high" } })
    ).toBe("指定级别：high");
  });

  it("fixed + 缺 level → 默认标签（视为默认）", () => {
    expect(describeMemberThinkingSetting({ memberThinkingLevel: { mode: "fixed" } })).toBe(
      "默认（不指定）"
    );
  });

  it("follow + 已知 TL 级别 → 跟随标签带当前值", () => {
    expect(
      describeMemberThinkingSetting({ memberThinkingLevel: { mode: "follow" } }, "high")
    ).toBe("跟随 TL（当前：high）");
  });

  it("follow + TL 级别未知 → 跟随标签明示未知", () => {
    expect(describeMemberThinkingSetting({ memberThinkingLevel: { mode: "follow" } })).toBe(
      "跟随 TL（TL 级别未知）"
    );
  });
});
