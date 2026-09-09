import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { resolveMessageCoalescing } from "./resolve-message-coalescing";
import { MEMBER_THINKING_LEVELS } from "./resolve-thinking";
import { resolvePeerMessaging } from "./resolve-peer-messaging";

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

  it("round-trips a fixed object through save/load (幂等)", () => {
    saveSettings(
      {
        ...structuredClone(DEFAULT_SETTINGS),
        memberThinkingLevel: { mode: "fixed", level: "high" },
      },
      tmpDir
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.memberThinkingLevel).toEqual({ mode: "fixed", level: "high" });
  });

  it("round-trips a follow object through save/load (幂等)", () => {
    saveSettings(
      {
        ...structuredClone(DEFAULT_SETTINGS),
        memberThinkingLevel: { mode: "follow" },
      },
      tmpDir
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.memberThinkingLevel).toEqual({ mode: "follow" });
  });

  it("migrates the legacy string form to a fixed object (原始 YAML 值守卫)", () => {
    // 守卫必须读原始 YAML 值：settings 克隆恒带新形态缺省（undefined），若用克隆值
    // 判断（isMemberThinkingLevel(undefined) = false）则永不迁移 → 本测试红
    // （决策 #34 batchMaxWaitMinutes 教训）。
    writeFileSync(getSettingsPath(tmpDir), "memberThinkingLevel: high\n", "utf-8");
    expect(loadSettings(tmpDir).memberThinkingLevel).toEqual({
      mode: "fixed",
      level: "high",
    });
  });

  it("migrates all seven legacy levels on load", () => {
    for (const level of MEMBER_THINKING_LEVELS) {
      writeFileSync(getSettingsPath(tmpDir), `memberThinkingLevel: ${level}\n`, "utf-8");
      expect(loadSettings(tmpDir).memberThinkingLevel).toEqual({ mode: "fixed", level });
    }
  });

  it("accepts a legacy 'follow' string (defensive) → follow object", () => {
    writeFileSync(getSettingsPath(tmpDir), "memberThinkingLevel: follow\n", "utf-8");
    expect(loadSettings(tmpDir).memberThinkingLevel).toEqual({ mode: "follow" });
  });

  it("accepts the new object form on load (idempotent)", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      "memberThinkingLevel:\n  mode: fixed\n  level: xhigh\n",
      "utf-8"
    );
    expect(loadSettings(tmpDir).memberThinkingLevel).toEqual({
      mode: "fixed",
      level: "xhigh",
    });
  });

  it("drops invalid values from the settings file (fall back to undefined)", () => {
    for (const raw of [
      "memberModel:\n  mode: follow\nmemberThinkingLevel: ultra\n",
      "memberThinkingLevel: 3\n",
      "memberThinkingLevel:\n  mode: bogus\n",
      "memberThinkingLevel:\n  mode: fixed\n  level: ultra\n",
    ]) {
      writeFileSync(getSettingsPath(tmpDir), raw, "utf-8");
      expect(loadSettings(tmpDir).memberThinkingLevel).toBeUndefined();
    }
  });
});

describe("messageCoalescing (消息合并设置)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-settings-coalesce-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to enabled with standard limits when unset", () => {
    const settings = loadSettings(tmpDir);
    expect(settings.messageCoalescing).toEqual({
      enabled: true,
      maxBatchSize: 5,
      maxBatchChars: 4000,
    });
  });

  it("round-trips messageCoalescing settings", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.messageCoalescing = { enabled: true, maxBatchSize: 3, maxBatchChars: 2000 };
    saveSettings(settings, tmpDir);
    const loaded = loadSettings(tmpDir);
    expect(loaded.messageCoalescing).toEqual({
      enabled: true,
      maxBatchSize: 3,
      maxBatchChars: 2000,
    });
  });

  it("parses explicit disabled", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      `messageCoalescing:\n  enabled: false\n`,
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.messageCoalescing?.enabled).toBe(false);
    // 未配置的字段在 load 层清空、由 resolve 层补默认
    expect(loaded.messageCoalescing?.maxBatchSize).toBeUndefined();
    expect(resolveMessageCoalescing(loaded).maxBatchSize).toBe(5);
  });

  it("drops invalid limit values (fall back to defaults at resolve time)", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      `messageCoalescing:\n  enabled: true\n  maxBatchSize: 0\n  maxBatchChars: -5\n`,
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.messageCoalescing?.enabled).toBe(true);
    const r = resolveMessageCoalescing(loaded);
    expect(r.maxBatchSize).toBe(5);
    expect(r.maxBatchChars).toBe(4000);
  });

  it("drops non-integer limit values", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      `messageCoalescing:\n  enabled: true\n  maxBatchSize: "3"\n  maxBatchChars: 1.5\n`,
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    const r = resolveMessageCoalescing(loaded);
    expect(r.maxBatchSize).toBe(5);
    expect(r.maxBatchChars).toBe(4000);
  });

  it("clears limits with explicit null (defaults applied at resolve time)", () => {
    writeFileSync(
      getSettingsPath(tmpDir),
      `messageCoalescing:\n  enabled: true\n  maxBatchSize: null\n  maxBatchChars: null\n`,
      "utf-8"
    );
    const loaded = loadSettings(tmpDir);
    expect(loaded.messageCoalescing?.maxBatchSize).toBeUndefined();
    expect(loaded.messageCoalescing?.maxBatchChars).toBeUndefined();
    const r = resolveMessageCoalescing(loaded);
    expect(r.maxBatchSize).toBe(5);
    expect(r.maxBatchChars).toBe(4000);
  });
});

describe("allowPeerMessaging (成员互发开关)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-settings-peer-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to true (allow) when unset — DEFAULT_SETTINGS 显式入列", () => {
    expect(DEFAULT_SETTINGS.allowPeerMessaging).toBe(true);
    const settings = loadSettings(tmpDir);
    expect(settings.allowPeerMessaging).toBe(true);
    // resolver 联动：缺省即允许（现状全互连拓扑）
    expect(resolvePeerMessaging(settings)).toBe("allowed");
  });

  it("round-trips explicit false and true through save/load", () => {
    saveSettings(
      { ...structuredClone(DEFAULT_SETTINGS), allowPeerMessaging: false },
      tmpDir
    );
    expect(loadSettings(tmpDir).allowPeerMessaging).toBe(false);

    saveSettings(
      { ...structuredClone(DEFAULT_SETTINGS), allowPeerMessaging: true },
      tmpDir
    );
    expect(loadSettings(tmpDir).allowPeerMessaging).toBe(true);
  });

  it("drops non-boolean values (严格姿态，其余丢弃回退默认 true)", () => {
    for (const raw of [
      'allowPeerMessaging: "false"\n', // string
      "allowPeerMessaging: 0\n", // number
      "allowPeerMessaging: null\n", // null
    ]) {
      writeFileSync(getSettingsPath(tmpDir), raw, "utf-8");
      expect(loadSettings(tmpDir).allowPeerMessaging).toBe(true);
    }
  });

  it("P2 建议采纳：近似意图非法值 console.warn 一次（防禁用意图被静默吞掉）", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(getSettingsPath(tmpDir), 'allowPeerMessaging: "false"\n', "utf-8");
      // 严格姿态不变：仍回退默认 true（warn 只补信号，不改行为）
      expect(loadSettings(tmpDir).allowPeerMessaging).toBe(true);
      const warns = () =>
        warnSpy.mock.calls.filter((c) => String(c[0]).includes(tmpDir));
      expect(warns()).toHaveLength(1);
      expect(String(warns()[0][0])).toContain("allowPeerMessaging");
      // loadSettings 每 dispatch 高频调用 → 同文件路径只 warn 一次，防刷屏
      loadSettings(tmpDir);
      loadSettings(tmpDir);
      expect(warns()).toHaveLength(1);

      // 键缺失（旧文件）不 warn —— 只有显式写了非法值才有信号
      const tmpDir2 = mkdtempSync(join(tmpdir(), "team-settings-peer-test-2-"));
      try {
        writeFileSync(getSettingsPath(tmpDir2), "memberModel:\n  mode: follow\n", "utf-8");
        loadSettings(tmpDir2);
        expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes(tmpDir2))).toHaveLength(0);
      } finally {
        rmSync(tmpDir2, { recursive: true, force: true });
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});
