import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLD_PERCENT,
  DEFAULT_TIMEOUT_MINUTES,
  DEFAULT_BATCH_MAX_WAIT_MINUTES,
  resolveAutoCompact,
  shouldCompact,
  describeAutoCompactSetting,
} from "./resolve-auto-compact";
import { DEFAULT_SETTINGS, type TeamSettings } from "./settings";

function makeSettings(autoCompact?: Partial<TeamSettings["autoCompact"]>): TeamSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    autoCompact: { ...structuredClone(DEFAULT_SETTINGS.autoCompact), ...autoCompact },
  };
}

describe("resolveAutoCompact", () => {
  it("defaults to enabled with default percent threshold", () => {
    const r = resolveAutoCompact(structuredClone(DEFAULT_SETTINGS));
    expect(r.enabled).toBe(true);
    expect(r.thresholdPercent).toBe(DEFAULT_THRESHOLD_PERCENT);
    expect(r.thresholdTokens).toBeUndefined();
    expect(r.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(r.batchMaxWaitMinutes).toBe(DEFAULT_BATCH_MAX_WAIT_MINUTES);
    expect(r.percentIsDefaultFallback).toBe(false);
  });

  it("respects explicitly configured thresholds", () => {
    const r = resolveAutoCompact(
      makeSettings({ thresholdPercent: 70, thresholdTokens: 150_000, timeoutMinutes: 15 })
    );
    expect(r.thresholdPercent).toBe(70);
    expect(r.thresholdTokens).toBe(150_000);
    expect(r.timeoutMinutes).toBe(15);
    expect(r.percentIsDefaultFallback).toBe(false);
  });

  it("allows tokens-only configuration (percent unrestricted)", () => {
    const r = resolveAutoCompact(
      makeSettings({ thresholdPercent: undefined, thresholdTokens: 150_000 })
    );
    expect(r.thresholdPercent).toBeUndefined();
    expect(r.thresholdTokens).toBe(150_000);
    expect(r.percentIsDefaultFallback).toBe(false);
  });

  it("falls back to default percent when enabled but no threshold configured", () => {
    const r = resolveAutoCompact(
      makeSettings({ thresholdPercent: undefined, thresholdTokens: undefined })
    );
    expect(r.thresholdPercent).toBe(DEFAULT_THRESHOLD_PERCENT);
    expect(r.thresholdTokens).toBeUndefined();
    expect(r.percentIsDefaultFallback).toBe(true);
  });

  it("does not apply default fallback when disabled", () => {
    const r = resolveAutoCompact(
      makeSettings({ enabled: false, thresholdPercent: undefined, thresholdTokens: undefined })
    );
    expect(r.enabled).toBe(false);
    expect(r.thresholdPercent).toBeUndefined();
    expect(r.percentIsDefaultFallback).toBe(false);
  });

  it("clamps timeoutMinutes to a sane minimum", () => {
    const r = resolveAutoCompact(makeSettings({ timeoutMinutes: 0 }));
    expect(r.timeoutMinutes).toBe(1);
  });

  it("keeps batchMaxWaitMinutes = 0 as unlimited (0 is meaningful)", () => {
    const r = resolveAutoCompact(makeSettings({ batchMaxWaitMinutes: 0 }));
    expect(r.batchMaxWaitMinutes).toBe(0);
  });

  it("falls back to the default batch budget when unset", () => {
    const r = resolveAutoCompact(makeSettings({ batchMaxWaitMinutes: undefined }));
    expect(r.batchMaxWaitMinutes).toBe(DEFAULT_BATCH_MAX_WAIT_MINUTES);
  });

  it("clamps negative batch budgets to 0 (unlimited) instead of blocking forever", () => {
    const r = resolveAutoCompact(makeSettings({ batchMaxWaitMinutes: -5 }));
    expect(r.batchMaxWaitMinutes).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("returns false when disabled", () => {
    const r = resolveAutoCompact(makeSettings({ enabled: false }));
    expect(shouldCompact({ percent: 99, tokens: 999_999 }, r)).toBe(false);
  });

  it("triggers on percent threshold", () => {
    const r = resolveAutoCompact(makeSettings({ thresholdPercent: 80 }));
    expect(shouldCompact({ percent: 80, tokens: 1000 }, r)).toBe(true);
    expect(shouldCompact({ percent: 79.9, tokens: 1000 }, r)).toBe(false);
  });

  it("triggers on tokens threshold", () => {
    const r = resolveAutoCompact(
      makeSettings({ thresholdPercent: undefined, thresholdTokens: 150_000 })
    );
    expect(shouldCompact({ percent: 10, tokens: 150_000 }, r)).toBe(true);
    expect(shouldCompact({ percent: 10, tokens: 149_999 }, r)).toBe(false);
  });

  it("triggers when either threshold is met (OR semantics)", () => {
    const r = resolveAutoCompact(makeSettings({ thresholdPercent: 80, thresholdTokens: 150_000 }));
    expect(shouldCompact({ percent: 90, tokens: 1000 }, r)).toBe(true);
    expect(shouldCompact({ percent: 10, tokens: 200_000 }, r)).toBe(true);
    expect(shouldCompact({ percent: 50, tokens: 100_000 }, r)).toBe(false);
  });
});

describe("describeAutoCompactSetting", () => {
  it("describes disabled state", () => {
    expect(describeAutoCompactSetting(makeSettings({ enabled: false }))).toContain("关闭");
  });

  it("describes percent-only config", () => {
    const d = describeAutoCompactSetting(makeSettings({ thresholdPercent: 70, timeoutMinutes: 10 }));
    expect(d).toContain("70%");
    expect(d).toContain("10 分钟");
  });

  it("describes dual thresholds with OR", () => {
    const d = describeAutoCompactSetting(
      makeSettings({ thresholdPercent: 70, thresholdTokens: 150_000 })
    );
    expect(d).toContain("70%");
    expect(d).toContain("150K");
    expect(d).toContain("或");
  });

  it("marks default fallback explicitly", () => {
    const d = describeAutoCompactSetting(
      makeSettings({ thresholdPercent: undefined, thresholdTokens: undefined })
    );
    expect(d).toContain("默认");
    expect(d).toContain(`${DEFAULT_THRESHOLD_PERCENT}%`);
  });

  it("describes the batch budget when enabled", () => {
    const d = describeAutoCompactSetting(makeSettings({ batchMaxWaitMinutes: 20 }));
    expect(d).toContain("20 分钟");
  });

  it("describes unlimited batch budget (0)", () => {
    const d = describeAutoCompactSetting(makeSettings({ batchMaxWaitMinutes: 0 }));
    expect(d).toContain("不限");
  });
});
