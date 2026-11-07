import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type TeamSettings } from "./settings";
import {
  resolveTlSelfWorkGuard,
  describeTlSelfWorkGuardSetting,
  DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD,
  MIN_TL_SELF_WORK_GUARD_THRESHOLD,
  type ResolvedTlSelfWorkGuard,
} from "./resolve-tl-self-work-guard";

function makeSettings(partial?: Partial<TeamSettings>): TeamSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...partial };
}

describe("constants", () => {
  it("defaults to 3 and enforces the lower bound 2", () => {
    // 缺省即现状（每回合 3 次）。
    expect(DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD).toBe(3);
    // 下限 2：提示词保证「需求对齐阶段允许读取 1-2 个文件」，上限 < 2 会让该例外失效。
    expect(MIN_TL_SELF_WORK_GUARD_THRESHOLD).toBe(2);
  });

  it("DEFAULT_SETTINGS carries the enabled + 3 shape", () => {
    expect(DEFAULT_SETTINGS.tlSelfWorkGuard).toEqual({ enabled: true, threshold: 3 });
  });
});

describe("resolveTlSelfWorkGuard", () => {
  it("defaults to {enabled:true, threshold:3} when the field is unset", () => {
    expect(resolveTlSelfWorkGuard(makeSettings())).toEqual<ResolvedTlSelfWorkGuard>({
      enabled: true,
      threshold: DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD,
    });
    expect(resolveTlSelfWorkGuard(makeSettings({ tlSelfWorkGuard: undefined }))).toEqual({
      enabled: true,
      threshold: 3,
    });
  });

  it("returns the default for an empty object", () => {
    expect(resolveTlSelfWorkGuard(makeSettings({ tlSelfWorkGuard: {} as never }))).toEqual({
      enabled: true,
      threshold: 3,
    });
  });

  it("honours an explicit disable", () => {
    expect(resolveTlSelfWorkGuard(makeSettings({ tlSelfWorkGuard: { enabled: false } }))).toEqual({
      enabled: false,
      threshold: 3,
    });
  });

  it("honours a custom threshold", () => {
    expect(
      resolveTlSelfWorkGuard(makeSettings({ tlSelfWorkGuard: { enabled: true, threshold: 5 } }))
    ).toEqual({ enabled: true, threshold: 5 });
  });

  it("accepts the lower bound exactly (2) and larger integers", () => {
    expect(
      resolveTlSelfWorkGuard(makeSettings({ tlSelfWorkGuard: { enabled: true, threshold: 2 } }))
        .threshold
    ).toBe(2);
    expect(
      resolveTlSelfWorkGuard(makeSettings({ tlSelfWorkGuard: { enabled: true, threshold: 100 } }))
        .threshold
    ).toBe(100);
  });

  it("falls back to the default threshold for out-of-range / non-integer / non-number values", () => {
    for (const threshold of [1, 0, -1, 3.5, Number.NaN, "5", null, true, {}]) {
      expect(
        resolveTlSelfWorkGuard(
          makeSettings({ tlSelfWorkGuard: { enabled: true, threshold } as never })
        ).threshold
      ).toBe(DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD);
    }
  });

  it("treats any enabled value other than literal false as enabled (fail-safe: keep the constraint)", () => {
    for (const enabled of [null, undefined, "false", 0, 1]) {
      expect(
        resolveTlSelfWorkGuard(makeSettings({ tlSelfWorkGuard: { enabled } as never })).enabled
      ).toBe(true);
    }
  });

  it("keeps the constraint (default) when reading settings throws", () => {
    // 与 allowPeerMessaging / allowAgentInitiatedSessions 的 fail-open（放宽）相反：
    // 误放宽是静默的角色漂移，误拦是响亮的且可当场修正（方案 4.6）。
    const throwing = {
      ...structuredClone(DEFAULT_SETTINGS),
      get tlSelfWorkGuard(): never {
        throw new Error("boom");
      },
    } as unknown as TeamSettings;
    expect(resolveTlSelfWorkGuard(throwing)).toEqual({ enabled: true, threshold: 3 });
  });

  it("keeps the constraint when settings itself is unusable (null/undefined)", () => {
    expect(resolveTlSelfWorkGuard(undefined)).toEqual({ enabled: true, threshold: 3 });
    expect(resolveTlSelfWorkGuard(null as unknown as TeamSettings)).toEqual({
      enabled: true,
      threshold: 3,
    });
  });
});

describe("describeTlSelfWorkGuardSetting", () => {
  it("renders the enabled state with the threshold", () => {
    expect(describeTlSelfWorkGuardSetting(makeSettings())).toBe("开启 · 每回合 3 次");
    expect(
      describeTlSelfWorkGuardSetting(
        makeSettings({ tlSelfWorkGuard: { enabled: true, threshold: 7 } })
      )
    ).toBe("开启 · 每回合 7 次");
  });

  it("renders the disabled state without any threshold (no self-contradicting label)", () => {
    const label = describeTlSelfWorkGuardSetting(
      makeSettings({ tlSelfWorkGuard: { enabled: false, threshold: 5 } })
    );
    expect(label).toBe("关闭");
    expect(label).not.toContain("次");
  });
});
