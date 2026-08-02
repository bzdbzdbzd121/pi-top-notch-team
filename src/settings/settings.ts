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

/** Auto-compaction setting: compact an idle member's context before dispatching a new task. */
export interface AutoCompactSetting {
  /** Master toggle. Default: true. */
  enabled: boolean;
  /** Percent of context window (1–100). Undefined = percent unrestricted. */
  thresholdPercent?: number;
  /** Absolute token threshold (positive integer). Undefined = tokens unrestricted. */
  thresholdTokens?: number;
  /** How long to wait for the compaction RPC before failing open (minutes, >=1). Default: 10. */
  timeoutMinutes: number;
}

/** Global top-notch-team settings (apply to all team sessions). */
export interface TeamSettings {
  memberModel: MemberModelSetting;
  autoCompact: AutoCompactSetting;
}

export const DEFAULT_SETTINGS: TeamSettings = {
  memberModel: { mode: "follow" },
  autoCompact: { enabled: true, thresholdPercent: 80, timeoutMinutes: 10 },
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

    const ac = (data as Record<string, unknown>).autoCompact;
    if (typeof ac === "object" && ac !== null) {
      const acObj = ac as Record<string, unknown>;
      if (typeof acObj.enabled === "boolean") {
        settings.autoCompact.enabled = acObj.enabled;
      }
      // Thresholds: absent/undefined = unrestricted. Invalid values are dropped
      // (fall back to unrestricted for that dimension).
      if (acObj.thresholdPercent === null || acObj.thresholdPercent === undefined) {
        settings.autoCompact.thresholdPercent = undefined;
      } else if (
        typeof acObj.thresholdPercent === "number" &&
        Number.isInteger(acObj.thresholdPercent) &&
        acObj.thresholdPercent >= 1 &&
        acObj.thresholdPercent <= 100
      ) {
        settings.autoCompact.thresholdPercent = acObj.thresholdPercent;
      } else {
        settings.autoCompact.thresholdPercent = undefined;
      }
      if (acObj.thresholdTokens === null || acObj.thresholdTokens === undefined) {
        settings.autoCompact.thresholdTokens = undefined;
      } else if (
        typeof acObj.thresholdTokens === "number" &&
        Number.isInteger(acObj.thresholdTokens) &&
        acObj.thresholdTokens > 0
      ) {
        settings.autoCompact.thresholdTokens = acObj.thresholdTokens;
      } else {
        settings.autoCompact.thresholdTokens = undefined;
      }
      if (
        typeof acObj.timeoutMinutes === "number" &&
        Number.isInteger(acObj.timeoutMinutes) &&
        acObj.timeoutMinutes >= 1
      ) {
        settings.autoCompact.timeoutMinutes = acObj.timeoutMinutes;
      }
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
