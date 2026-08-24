import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type TeamSettings } from "./settings";
import {
  DEFAULT_WAIT_TIMEOUT_MINUTES,
  resolveWaitTimeoutMinutes,
  describeWaitTimeoutSetting,
} from "./resolve-wait-timeout";

function makeSettings(partial?: Partial<TeamSettings>): TeamSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...partial };
}

describe("resolveWaitTimeoutMinutes", () => {
  it("defaults to 15 minutes when settings are absent", () => {
    expect(resolveWaitTimeoutMinutes(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_MINUTES);
  });

  it("defaults when the field is unset", () => {
    expect(resolveWaitTimeoutMinutes(makeSettings())).toBe(DEFAULT_WAIT_TIMEOUT_MINUTES);
  });

  it("respects an explicit value", () => {
    expect(resolveWaitTimeoutMinutes(makeSettings({ waitTimeoutMinutes: 30 }))).toBe(30);
  });

  it("keeps 0 as unlimited (0 is meaningful — original never-timeout semantics)", () => {
    expect(resolveWaitTimeoutMinutes(makeSettings({ waitTimeoutMinutes: 0 }))).toBe(0);
  });

  it("clamps negative values to 0 (unlimited) instead of blocking forever", () => {
    expect(resolveWaitTimeoutMinutes(makeSettings({ waitTimeoutMinutes: -5 }))).toBe(0);
  });
});

describe("describeWaitTimeoutSetting", () => {
  it("renders minutes", () => {
    expect(describeWaitTimeoutSetting(makeSettings({ waitTimeoutMinutes: 20 }))).toBe("20 分钟");
  });

  it("renders unlimited (0)", () => {
    expect(describeWaitTimeoutSetting(makeSettings({ waitTimeoutMinutes: 0 }))).toBe("不限");
  });
});
