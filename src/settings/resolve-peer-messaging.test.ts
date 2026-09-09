import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type TeamSettings } from "./settings";
import {
  resolvePeerMessaging,
  describePeerMessagingSetting,
  type PeerMessagingMode,
} from "./resolve-peer-messaging";

function makeSettings(partial?: Partial<TeamSettings>): TeamSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...partial };
}

describe("resolvePeerMessaging", () => {
  it("defaults to allowed when the field is unset", () => {
    expect(resolvePeerMessaging(makeSettings())).toBe("allowed");
  });

  it("explicit true → allowed", () => {
    expect(resolvePeerMessaging(makeSettings({ allowPeerMessaging: true }))).toBe("allowed");
  });

  it("explicit false → tl-only", () => {
    expect(
      resolvePeerMessaging(makeSettings({ allowPeerMessaging: false }))
    ).toBe<PeerMessagingMode>("tl-only");
  });

  it("fails open to allowed when reading settings throws", () => {
    // fail-open 显式取舍：禁令缺失（读取异常）时保持现状可用性——resolver 异常绝不禁发。
    const throwing = {
      ...structuredClone(DEFAULT_SETTINGS),
      get allowPeerMessaging(): boolean {
        throw new Error("boom");
      },
    } as unknown as TeamSettings;
    expect(resolvePeerMessaging(throwing)).toBe("allowed");
  });

  it("fails open to allowed when settings itself is unusable (null/undefined)", () => {
    expect(resolvePeerMessaging(undefined as unknown as TeamSettings)).toBe("allowed");
    expect(resolvePeerMessaging(null as unknown as TeamSettings)).toBe("allowed");
  });
});

describe("describePeerMessagingSetting", () => {
  it("renders the allowed state", () => {
    expect(describePeerMessagingSetting(makeSettings({ allowPeerMessaging: true }))).toBe("允许");
  });

  it("renders the disabled (tl-only) state", () => {
    expect(describePeerMessagingSetting(makeSettings({ allowPeerMessaging: false }))).toBe(
      "仅限回复 TL"
    );
  });

  it("unset field shows the default label (允许)", () => {
    expect(describePeerMessagingSetting(makeSettings())).toBe("允许");
  });
});
