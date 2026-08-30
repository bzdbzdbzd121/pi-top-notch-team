import { describe, it, expect } from "vitest";
import type { TeamSettings } from "./settings";
import {
  resolveMessageCoalescing,
  describeMessageCoalescingSetting,
} from "./resolve-message-coalescing";
import {
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_BATCH_CHARS,
} from "../channel/message-coalescer";

function settingsWith(mc?: TeamSettings["messageCoalescing"]): TeamSettings {
  return {
    memberModel: { mode: "follow" },
    autoCompact: { enabled: true, thresholdPercent: 80, timeoutMinutes: 10 },
    messageCoalescing: mc,
  } as TeamSettings;
}

describe("resolveMessageCoalescing", () => {
  it("defaults to enabled with the standard limits when unset", () => {
    const r = resolveMessageCoalescing(settingsWith(undefined));
    expect(r).toEqual({
      enabled: true,
      maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
      maxBatchChars: DEFAULT_MAX_BATCH_CHARS,
    });
  });

  it("respects explicit disabled", () => {
    const r = resolveMessageCoalescing(settingsWith({ enabled: false }));
    expect(r.enabled).toBe(false);
  });

  it("fills missing limit fields with defaults", () => {
    const r = resolveMessageCoalescing(settingsWith({ enabled: true }));
    expect(r.maxBatchSize).toBe(DEFAULT_MAX_BATCH_SIZE);
    expect(r.maxBatchChars).toBe(DEFAULT_MAX_BATCH_CHARS);
  });

  it("uses configured limits", () => {
    const r = resolveMessageCoalescing(
      settingsWith({ enabled: true, maxBatchSize: 3, maxBatchChars: 2000 })
    );
    expect(r).toEqual({ enabled: true, maxBatchSize: 3, maxBatchChars: 2000 });
  });
});

describe("describeMessageCoalescingSetting", () => {
  it("describes the disabled state", () => {
    expect(describeMessageCoalescingSetting(settingsWith({ enabled: false }))).toBe("关闭");
  });

  it("describes the enabled state with effective limits", () => {
    expect(describeMessageCoalescingSetting(settingsWith(undefined))).toBe(
      "开启 · 最多 5 条 · 4000 字符"
    );
    expect(
      describeMessageCoalescingSetting(settingsWith({ enabled: true, maxBatchSize: 2, maxBatchChars: 800 }))
    ).toBe("开启 · 最多 2 条 · 800 字符");
  });
});
