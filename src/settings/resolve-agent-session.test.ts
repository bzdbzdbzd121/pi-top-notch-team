import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type TeamSettings } from "./settings";
import {
  resolveAgentSessionAllowed,
  describeAgentSessionSetting,
} from "./resolve-agent-session";

function makeSettings(partial?: Partial<TeamSettings>): TeamSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...partial };
}

describe("resolveAgentSessionAllowed", () => {
  it("defaults to allowed when the field is unset", () => {
    expect(resolveAgentSessionAllowed(makeSettings())).toBe(true);
  });

  it("explicit true → allowed", () => {
    expect(resolveAgentSessionAllowed(makeSettings({ allowAgentInitiatedSessions: true }))).toBe(
      true
    );
  });

  it("explicit false → disallowed", () => {
    expect(
      resolveAgentSessionAllowed(makeSettings({ allowAgentInitiatedSessions: false }))
    ).toBe(false);
  });

  it("fails open to allowed when reading settings throws", () => {
    // fail-open 显式取舍（不对称论证）：误允许可经 /team setting 修正；误禁止
    // 静默剥夺 agent 委派能力更难察觉——与 resolvePeerMessaging 同姿态。
    const throwing = {
      ...structuredClone(DEFAULT_SETTINGS),
      get allowAgentInitiatedSessions(): boolean {
        throw new Error("boom");
      },
    } as unknown as TeamSettings;
    expect(resolveAgentSessionAllowed(throwing)).toBe(true);
  });

  it("fails open to allowed when settings itself is unusable (null/undefined)", () => {
    expect(resolveAgentSessionAllowed(undefined as unknown as TeamSettings)).toBe(true);
    expect(resolveAgentSessionAllowed(null as unknown as TeamSettings)).toBe(true);
  });
});

describe("describeAgentSessionSetting", () => {
  it("renders the allowed state", () => {
    expect(describeAgentSessionSetting(makeSettings({ allowAgentInitiatedSessions: true }))).toBe(
      "允许"
    );
  });

  it("renders the disabled state", () => {
    expect(describeAgentSessionSetting(makeSettings({ allowAgentInitiatedSessions: false }))).toBe(
      "禁止"
    );
  });

  it("unset field shows the default label (允许)", () => {
    expect(describeAgentSessionSetting(makeSettings())).toBe("允许");
  });
});
