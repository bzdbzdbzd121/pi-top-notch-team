import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** How the default model for team members is chosen. */
export type MemberModelMode = "follow" | "fixed";

export interface MemberModelSetting {
  /**
   * "follow" — members use the TL's current model at spawn time.
   * "fixed"  — members always use `model` regardless of the TL's model.
   */
  mode: MemberModelMode;
  /** Only meaningful when mode === "fixed". Format: "provider/modelId". */
  model?: string;
}

/** Global top-notch-team settings (apply to all team sessions). */
export interface TeamSettings {
  memberModel: MemberModelSetting;
}

export const DEFAULT_SETTINGS: TeamSettings = {
  memberModel: { mode: "follow" },
};

const SETTINGS_FILE = "settings.yaml";

export function getSettingsPath(rootDir: string): string {
  return join(rootDir, SETTINGS_FILE);
}

/**
 * Load global settings from <rootDir>/settings.yaml.
 * Returns DEFAULT_SETTINGS when the file is missing or invalid,
 * and back-fills missing fields with defaults.
 */
export function loadSettings(rootDir: string): TeamSettings {
  const filePath = getSettingsPath(rootDir);
  if (!existsSync(filePath)) {
    return structuredClone(DEFAULT_SETTINGS);
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = parseYaml(raw);
    if (typeof data !== "object" || data === null) {
      return structuredClone(DEFAULT_SETTINGS);
    }

    const settings: TeamSettings = structuredClone(DEFAULT_SETTINGS);
    const mm = (data as Record<string, unknown>).memberModel;
    if (typeof mm === "object" && mm !== null) {
      const mmObj = mm as Record<string, unknown>;
      if (mmObj.mode === "follow" || mmObj.mode === "fixed") {
        settings.memberModel.mode = mmObj.mode;
      }
      if (typeof mmObj.model === "string" && mmObj.model.length > 0) {
        settings.memberModel.model = mmObj.model;
      }
    }
    // A "fixed" mode without a model is meaningless — fall back to follow.
    if (settings.memberModel.mode === "fixed" && !settings.memberModel.model) {
      settings.memberModel.mode = "follow";
    }
    return settings;
  } catch (err) {
    console.warn(
      `[top-notch-team] Failed to read settings file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** Persist global settings to <rootDir>/settings.yaml. Creates the directory if needed. */
export function saveSettings(settings: TeamSettings, rootDir: string): void {
  if (!existsSync(rootDir)) {
    mkdirSync(rootDir, { recursive: true });
  }
  const yaml = stringifyYaml(settings, { lineWidth: 120 });
  writeFileSync(getSettingsPath(rootDir), yaml, "utf-8");
}

/** Human-readable label for the member-model setting (used in menus and notices). */
export function describeMemberModelSetting(
  settings: TeamSettings,
  tlCurrentModel?: string
): string {
  if (settings.memberModel.mode === "fixed" && settings.memberModel.model) {
    return `指定模型：${settings.memberModel.model}`;
  }
  return `跟随当前配置${tlCurrentModel ? `（当前：${tlCurrentModel}）` : ""}`;
}
