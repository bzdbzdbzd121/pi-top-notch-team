import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  describeMemberModelSetting,
  getSettingsPath,
} from "./settings";

describe("settings store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-settings-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns DEFAULT_SETTINGS when settings file does not exist", () => {
    const settings = loadSettings(tmpDir);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.memberModel.mode).toBe("follow");
  });

  it("round-trips settings through save/load", () => {
    saveSettings(
      { ...structuredClone(DEFAULT_SETTINGS), memberModel: { mode: "fixed", model: "anthropic/claude-sonnet-4-5" } },
      tmpDir
    );
    expect(existsSync(getSettingsPath(tmpDir))).toBe(true);

    const loaded = loadSettings(tmpDir);
    expect(loaded.memberModel.mode).toBe("fixed");
    expect(loaded.memberModel.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("creates the root directory when saving", () => {
    const nested = join(tmpDir, "a", "b");
    saveSettings({ ...structuredClone(DEFAULT_SETTINGS), memberModel: { mode: "follow" } }, nested);
    expect(existsSync(getSettingsPath(nested))).toBe(true);
  });

  it("back-fills defaults for partial settings files", () => {
    writeFileSync(getSettingsPath(tmpDir), "memberModel:\n  mode: follow\n", "utf-8");
    const loaded = loadSettings(tmpDir);
    expect(loaded.memberModel.mode).toBe("follow");
    expect(loaded.memberModel.model).toBeUndefined();
  });

  it("falls back to follow when fixed mode has no model", () => {
    writeFileSync(getSettingsPath(tmpDir), "memberModel:\n  mode: fixed\n", "utf-8");
    const loaded = loadSettings(tmpDir);
    expect(loaded.memberModel.mode).toBe("follow");
  });

  it("returns DEFAULT_SETTINGS for corrupted YAML", () => {
    writeFileSync(getSettingsPath(tmpDir), "memberModel: [broken: {", "utf-8");
    const loaded = loadSettings(tmpDir);
    expect(loaded).toEqual(DEFAULT_SETTINGS);
  });

  it("returns DEFAULT_SETTINGS for non-object YAML", () => {
    writeFileSync(getSettingsPath(tmpDir), "- just\n- a\n- list\n", "utf-8");
    const loaded = loadSettings(tmpDir);
    expect(loaded).toEqual(DEFAULT_SETTINGS);
  });

  it("ignores invalid mode values", () => {
    writeFileSync(getSettingsPath(tmpDir), "memberModel:\n  mode: bogus\n", "utf-8");
    const loaded = loadSettings(tmpDir);
    expect(loaded.memberModel.mode).toBe("follow");
  });

  // ── autoCompact parsing ─────────────────────────────────

  it("back-fills autoCompact defaults for old settings files without the key", () => {
    writeFileSync(getSettingsPath(tmpDir), "memberModel:\n  mode: follow\n", "utf-8");
    const loaded = loadSettings(tmpDir);
    expect(loaded.autoCompact).toEqual(DEFAULT_SETTINGS.autoCompact);
  });

  it("round-trips autoCompact settings", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autoCompact = {
      enabled: false,
      thresholdPercent: 70,
      thresholdTokens: 150_000,
      timeoutMinutes: 15,
    };
    saveSettings(settings, tmpDir);
    const loaded = loadSettings(tmpDir);
    expect(loaded.autoCompact).toEqual({
      enabled: false,
      thresholdPercent: 70,
      thresholdTokens: 150_000,
      timeoutMinutes: 15,
    });
  });

  it("round-trips the top-level waitTimeoutMinutes", () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), waitTimeoutMinutes: 0 };
    saveSettings(settings, tmpDir);
    expect(loadSettings(tmpDir).waitTimeoutMinutes).toBe(0);
  });

  it("parses waitTimeoutMinutes: explicit value, unlimited (0), and invalid → default", () => {
    // Explicit value
    writeFileSync(getSettingsPath(tmpDir), "waitTimeoutMinutes: 30\n", "utf-8");
    expect(loadSettings(tmpDir).waitTimeoutMinutes).toBe(30);

    // 0 = unlimited (meaningful value, must survive)
    writeFileSync(getSettingsPath(tmpDir), "waitTimeoutMinutes: 0\n", "utf-8");
    expect(loadSettings(tmpDir).waitTimeoutMinutes).toBe(0);

    // Negative / non-integer → dropped, default applies
    writeFileSync(getSettingsPath(tmpDir), "waitTimeoutMinutes: -3\n", "utf-8");
    expect(loadSettings(tmpDir).waitTimeoutMinutes).toBe(DEFAULT_SETTINGS.waitTimeoutMinutes);

    // Old settings file without the key → default back-filled
    writeFileSync(
      getSettingsPath(tmpDir),
      "autoCompact:\n  enabled: true\n  timeoutMinutes: 10\n",
      "utf-8"
    );
    expect(loadSettings(tmpDir).waitTimeoutMinutes).toBe(DEFAULT_SETTINGS.waitTimeoutMinutes);
  });

  it("migrates legacy autoCompact.batchMaxWaitMinutes to the top-level waitTimeoutMinutes", () => {
    // Files written before the rename: the budget lived inside autoCompact.
    // It must be carried over to the new top-level key (and never read back
    // from the old slot).
    writeFileSync(
      getSettingsPath(tmpDir),
      "autoCompact:\n  enabled: true\n  timeoutMinutes: 10\n  batchMaxWaitMinutes: 30\n",
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.waitTimeoutMinutes).toBe(30);
    expect("batchMaxWaitMinutes" in loaded.autoCompact).toBe(false);

    // Legacy 0 (unlimited) also survives the migration.
    writeFileSync(
      getSettingsPath(tmpDir),
      "autoCompact:\n  enabled: true\n  timeoutMinutes: 10\n  batchMaxWaitMinutes: 0\n",
      "utf-8"
    );
    expect(loadSettings(tmpDir).waitTimeoutMinutes).toBe(0);
  });

  it("preserves explicitly cleared thresholds (null → undefined, no default back-fill)", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      "autoCompact:\n  enabled: true\n  thresholdPercent: null\n  timeoutMinutes: 10\n",
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.autoCompact.enabled).toBe(true);
    expect(loaded.autoCompact.thresholdPercent).toBeUndefined();
    expect(loaded.autoCompact.thresholdTokens).toBeUndefined();
  });

  it("drops invalid threshold values (out-of-range percent, non-positive tokens)", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      "autoCompact:\n  enabled: true\n  thresholdPercent: 150\n  thresholdTokens: -5\n  timeoutMinutes: 0\n",
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.autoCompact.thresholdPercent).toBeUndefined();
    expect(loaded.autoCompact.thresholdTokens).toBeUndefined();
    expect(loaded.autoCompact.timeoutMinutes).toBe(DEFAULT_SETTINGS.autoCompact.timeoutMinutes);
  });

  it("save→load does not mutate DEFAULT_SETTINGS", () => {
    saveSettings({ ...structuredClone(DEFAULT_SETTINGS), memberModel: { mode: "fixed", model: "openai/gpt-5" } }, tmpDir);
    loadSettings(tmpDir);
    expect(DEFAULT_SETTINGS.memberModel.mode).toBe("follow");
    expect(DEFAULT_SETTINGS.memberModel.model).toBeUndefined();
  });
});

describe("describeMemberModelSetting", () => {
  it("describes fixed mode", () => {
    const text = describeMemberModelSetting({
      ...structuredClone(DEFAULT_SETTINGS),
      memberModel: { mode: "fixed", model: "anthropic/claude-sonnet-4-5" },
    });
    expect(text).toContain("anthropic/claude-sonnet-4-5");
  });

  it("describes follow mode with the TL current model", () => {
    const text = describeMemberModelSetting(
      { ...structuredClone(DEFAULT_SETTINGS), memberModel: { mode: "follow" } },
      "openai/gpt-5"
    );
    expect(text).toContain("跟随当前配置");
    expect(text).toContain("openai/gpt-5");
  });

  it("describes follow mode without a TL current model", () => {
    const text = describeMemberModelSetting({ ...structuredClone(DEFAULT_SETTINGS), memberModel: { mode: "follow" } });
    expect(text).toBe("跟随当前配置");
  });
});

describe("memberThinkingLevel (成员思考强度)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-settings-thinking-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is undefined by default", () => {
    const settings = loadSettings(tmpDir);
    expect(settings.memberThinkingLevel).toBeUndefined();
  });

  it("round-trips a configured level through save/load", () => {
    saveSettings(
      { ...structuredClone(DEFAULT_SETTINGS), memberThinkingLevel: "high" },
      tmpDir
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.memberThinkingLevel).toBe("high");
  });

  it("drops invalid levels from the settings file (fall back to undefined)", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      "memberModel:\n  mode: follow\nmemberThinkingLevel: ultra\n",
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.memberThinkingLevel).toBeUndefined();
  });

  it("accepts all seven valid levels on load", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      writeFileSync(
        getSettingsPath(tmpDir),
        `memberThinkingLevel: ${level}\n`,
        "utf-8"
      );
      expect(loadSettings(tmpDir).memberThinkingLevel).toBe(level);
    }
  });
});
