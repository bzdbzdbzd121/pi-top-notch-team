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
      { memberModel: { mode: "fixed", model: "anthropic/claude-sonnet-4-5" } },
      tmpDir
    );
    expect(existsSync(getSettingsPath(tmpDir))).toBe(true);

    const loaded = loadSettings(tmpDir);
    expect(loaded.memberModel.mode).toBe("fixed");
    expect(loaded.memberModel.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("creates the root directory when saving", () => {
    const nested = join(tmpDir, "a", "b");
    saveSettings({ memberModel: { mode: "follow" } }, nested);
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

  it("save→load does not mutate DEFAULT_SETTINGS", () => {
    saveSettings({ memberModel: { mode: "fixed", model: "openai/gpt-5" } }, tmpDir);
    loadSettings(tmpDir);
    expect(DEFAULT_SETTINGS.memberModel.mode).toBe("follow");
    expect(DEFAULT_SETTINGS.memberModel.model).toBeUndefined();
  });
});

describe("describeMemberModelSetting", () => {
  it("describes fixed mode", () => {
    const text = describeMemberModelSetting({
      memberModel: { mode: "fixed", model: "anthropic/claude-sonnet-4-5" },
    });
    expect(text).toContain("anthropic/claude-sonnet-4-5");
  });

  it("describes follow mode with the TL current model", () => {
    const text = describeMemberModelSetting(
      { memberModel: { mode: "follow" } },
      "openai/gpt-5"
    );
    expect(text).toContain("跟随当前配置");
    expect(text).toContain("openai/gpt-5");
  });

  it("describes follow mode without a TL current model", () => {
    const text = describeMemberModelSetting({ memberModel: { mode: "follow" } });
    expect(text).toBe("跟随当前配置");
  });
});
