import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isMemberThinkingLevel, type MemberThinkingLevel } from "./resolve-thinking";

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

/** 成员消息合并（S1 coalescer）设置：member→member 消息在接收方回合边界合并为单条 prompt。 */
export interface MessageCoalescingSetting {
  /** Master toggle. Default: true (缺省即开启；关闭则完全走原逐条路径). */
  enabled: boolean;
  /** 合并包最多条数（>=1）。Undefined = 默认 5. */
  maxBatchSize?: number;
  /** 合并包总字符软上限（>=1）。Undefined = 默认 4000. 硬守卫 MAX_COMMAND_SIZE 恒不超。 */
  maxBatchChars?: number;
}

/** Global top-notch-team settings (apply to all team sessions). */
export interface TeamSettings {
  memberModel: MemberModelSetting;
  autoCompact: AutoCompactSetting;
  /**
   * Unified wait budget for team wait operations, in minutes.
   * 0 = unlimited (never time out). Default: 15.
   *
   * Shared by (and fully independent of auto-compaction):
   *  - the all-idle deadline of wait_and_get_member_status /
   *    team_send_and_wait (defense in depth: a member stuck in
   *    working/compacting must not block the wait tools forever), and
   *  - the batch alignment barrier budget (maxWait: when exhausted,
   *    not-yet-started compactions are skipped and the batch dispatches).
   */
  waitTimeoutMinutes?: number;
  /**
   * 成员默认思考强度。undefined = 不指定（member pi 使用该模型的默认思考级别）。
   * 配置后：若成员生效模型支持该级别 → 以 `--thinking <level>` 传给 member 进程；
   * 不支持（或无法判定支持集）→ 不传 flag，保持现状。
   * 仅影响之后启动的成员。支持集语义见 src/settings/resolve-thinking.ts。
   */
  memberThinkingLevel?: MemberThinkingLevel;
  /** 消息合并（S1，阶段 2）。缺省 = 开启（默认 5 条 / 4000 字符）。 */
  messageCoalescing?: MessageCoalescingSetting;
}

export const DEFAULT_SETTINGS: TeamSettings = {
  memberModel: { mode: "follow" },
  autoCompact: { enabled: true, thresholdPercent: 80, timeoutMinutes: 10 },
  waitTimeoutMinutes: 15,
  messageCoalescing: { enabled: true, maxBatchSize: 5, maxBatchChars: 4000 },
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

    // waitTimeoutMinutes (top-level, generic wait budget): 0 = unlimited is
    // meaningful; negative / non-integer values are dropped (default applies).
    const rawData = data as Record<string, unknown>;
    const wt = rawData.waitTimeoutMinutes;
    if (typeof wt === "number" && Number.isInteger(wt) && wt >= 0) {
      settings.waitTimeoutMinutes = wt;
    }

    // memberThinkingLevel (top-level): members' preferred thinking level.
    // Invalid values are dropped (undefined = use each model's pi default).
    const mtl = rawData.memberThinkingLevel;
    if (isMemberThinkingLevel(mtl)) {
      settings.memberThinkingLevel = mtl;
    }

    // messageCoalescing (top-level): member→member message batching. Invalid
    // values are dropped (fall back to defaults); explicit null clears a
    // field (default applies at resolve time).
    const mc = rawData.messageCoalescing;
    if (typeof mc === "object" && mc !== null) {
      const mcObj = mc as Record<string, unknown>;
      if (typeof mcObj.enabled === "boolean") {
        settings.messageCoalescing!.enabled = mcObj.enabled;
      }
      if (mcObj.maxBatchSize === null || mcObj.maxBatchSize === undefined) {
        settings.messageCoalescing!.maxBatchSize = undefined;
      } else if (
        typeof mcObj.maxBatchSize === "number" &&
        Number.isInteger(mcObj.maxBatchSize) &&
        mcObj.maxBatchSize >= 1
      ) {
        settings.messageCoalescing!.maxBatchSize = mcObj.maxBatchSize;
      } else {
        settings.messageCoalescing!.maxBatchSize = undefined;
      }
      if (mcObj.maxBatchChars === null || mcObj.maxBatchChars === undefined) {
        settings.messageCoalescing!.maxBatchChars = undefined;
      } else if (
        typeof mcObj.maxBatchChars === "number" &&
        Number.isInteger(mcObj.maxBatchChars) &&
        mcObj.maxBatchChars >= 1
      ) {
        settings.messageCoalescing!.maxBatchChars = mcObj.maxBatchChars;
      } else {
        settings.messageCoalescing!.maxBatchChars = undefined;
      }
    }

    // Migration (legacy key): batchMaxWaitMinutes used to live inside
    // autoCompact but is actually independent of auto-compaction. Carry the
    // old value over to the top-level waitTimeoutMinutes once when the file
    // has no top-level key (the settings clone always carries the default,
    // so the guard must check the raw file value, not the resolved object).
    const legacyAc = rawData.autoCompact;
    const legacyBatch = (legacyAc as Record<string, unknown> | null)
      ? ((legacyAc as Record<string, unknown>).batchMaxWaitMinutes as unknown)
      : undefined;
    if (
      wt === undefined &&
      typeof legacyBatch === "number" &&
      Number.isInteger(legacyBatch) &&
      legacyBatch >= 0
    ) {
      settings.waitTimeoutMinutes = legacyBatch;
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
