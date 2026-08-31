import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_SETTINGS,
  type TeamSettings,
} from "./settings";
import {
  getSessionSettings,
  setSessionSetting,
  clearSessionSetting,
  clearAllSessionSettings,
  clearSessionSettingsMemory,
  reconcileSessionSettings,
  resolveEffectiveSettings,
  saveSessionSettingsSnapshot,
  loadSessionSettingsSnapshot,
  getSessionSettingsSnapshotPath,
  resetSessionSettingsState,
  setActiveSessionDir,
  type DeepPartial,
} from "./session-settings";

/** Fresh full settings (a deep clone of DEFAULT_SETTINGS with a few custom values). */
function makeGlobal(): TeamSettings {
  return {
    memberModel: { mode: "follow", model: undefined },
    autoCompact: { enabled: true, thresholdPercent: 80, thresholdTokens: undefined, timeoutMinutes: 10 },
    waitTimeoutMinutes: 15,
    memberThinkingLevel: undefined,
    messageCoalescing: { enabled: true, maxBatchSize: 5, maxBatchChars: 4000 },
  };
}

describe("resolveEffectiveSettings — 深字段级 merge（纯函数）", () => {
  it("empty overlay is the identity: deep-equal to global, no shared references", () => {
    const global = makeGlobal();
    const result = resolveEffectiveSettings(global, {});
    expect(result).toEqual(global);
    expect(result).not.toBe(global);
    // 修改结果不得影响 global（clone 隔离）
    result.autoCompact.thresholdPercent = 99;
    result.memberModel.mode = "fixed";
    expect(global.autoCompact.thresholdPercent).toBe(80);
    expect(global.memberModel.mode).toBe("follow");
  });

  it("overrides top-level scalar fields (waitTimeoutMinutes, memberThinkingLevel)", () => {
    const result = resolveEffectiveSettings(makeGlobal(), {
      waitTimeoutMinutes: 0,
      memberThinkingLevel: "high",
    });
    expect(result.waitTimeoutMinutes).toBe(0);
    expect(result.memberThinkingLevel).toBe("high");
    // 未覆盖字段保持 global
    expect(result.autoCompact.enabled).toBe(true);
  });

  it("merges autoCompact field-by-field (only thresholdPercent overridden)", () => {
    const global = makeGlobal();
    const result = resolveEffectiveSettings(global, {
      autoCompact: { enabled: false, thresholdPercent: 55, timeoutMinutes: 30 },
    });
    expect(result.autoCompact.enabled).toBe(false);
    expect(result.autoCompact.thresholdPercent).toBe(55);
    expect(result.autoCompact.timeoutMinutes).toBe(30);
    // overlay 未提及的字段保持 global
    expect(result.autoCompact.thresholdTokens).toBeUndefined();
    // 内部字段深合并：enabled 来自 overlay、thresholdTokens 来自 global
    expect(result.autoCompact).toEqual({
      enabled: false,
      thresholdPercent: 55,
      thresholdTokens: undefined,
      timeoutMinutes: 30,
    });
  });

  it("merges messageCoalescing field-by-field", () => {
    const result = resolveEffectiveSettings(makeGlobal(), {
      messageCoalescing: { enabled: false },
    });
    expect(result.messageCoalescing?.enabled).toBe(false);
    expect(result.messageCoalescing?.maxBatchSize).toBe(5);
    expect(result.messageCoalescing?.maxBatchChars).toBe(4000);
  });

  it("merges memberModel field-by-field", () => {
    const global = makeGlobal();
    const result = resolveEffectiveSettings(global, { memberModel: { mode: "fixed", model: "openai/gpt-5" } });
    expect(result.memberModel).toEqual({ mode: "fixed", model: "openai/gpt-5" });

    // 只覆盖 mode：model 保持 global 的 undefined（不引入幽灵 model）
    const result2 = resolveEffectiveSettings(global, { memberModel: { mode: "fixed" } });
    expect(result2.memberModel.mode).toBe("fixed");
    expect(result2.memberModel.model).toBeUndefined();
  });

  it("treats top-level undefined overlay fields as 'not overridden'", () => {
    const global = makeGlobal();
    const result = resolveEffectiveSettings(global, {
      waitTimeoutMinutes: undefined,
      memberThinkingLevel: undefined,
    });
    expect(result.waitTimeoutMinutes).toBe(15);
    expect(result.memberThinkingLevel).toBeUndefined();
    expect(result).toEqual(global);
  });

  it("treats undefined nested overlay fields as 'not overridden'", () => {
    const global = makeGlobal();
    const result = resolveEffectiveSettings(global, {
      autoCompact: { thresholdPercent: undefined, enabled: false },
      messageCoalescing: { maxBatchChars: undefined },
    });
    // undefined 字段不覆盖：thresholdPercent / maxBatchChars 保持 global
    expect(result.autoCompact.enabled).toBe(false);
    expect(result.autoCompact.thresholdPercent).toBe(80);
    expect(result.messageCoalescing?.maxBatchChars).toBe(4000);
  });

  it("does not mutate either input", () => {
    const global = makeGlobal();
    const overlay: DeepPartial<TeamSettings> = {
      autoCompact: { enabled: false, thresholdPercent: 30 },
      memberModel: { mode: "fixed", model: "openai/gpt-5" },
    };
    resolveEffectiveSettings(global, overlay);
    expect(global).toEqual(makeGlobal());
    expect(overlay).toEqual({
      autoCompact: { enabled: false, thresholdPercent: 30 },
      memberModel: { mode: "fixed", model: "openai/gpt-5" },
    });
  });

  it("clones nested values — mutating the result never leaks back to global or overlay", () => {
    const global = makeGlobal();
    const overlay: DeepPartial<TeamSettings> = { autoCompact: { thresholdPercent: 30 } };
    const result = resolveEffectiveSettings(global, overlay);
    result.autoCompact.thresholdPercent = 70;
    result.messageCoalescing!.maxBatchSize = 2;
    expect(global.autoCompact.thresholdPercent).toBe(80);
    expect(overlay.autoCompact?.thresholdPercent).toBe(30);
    expect(global.messageCoalescing?.maxBatchSize).toBe(5);
  });
});

describe("session settings overlay — set/clear/clearAll", () => {
  beforeEach(() => {
    resetSessionSettingsState();
  });

  it("starts empty", () => {
    expect(getSessionSettings()).toEqual({});
  });

  it("set then get reflects the value (structuredClone isolation)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);

    // 返回副本：修改返回值不影响内部状态
    const copy = getSessionSettings() as DeepPartial<TeamSettings>;
    copy.waitTimeoutMinutes = 99;
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("set stores a clone — later mutation of the input does not leak into state", () => {
    const patch: DeepPartial<TeamSettings> = { autoCompact: { enabled: false, thresholdPercent: 30 } };
    setSessionSetting("autoCompact", patch.autoCompact!);
    patch.autoCompact!.thresholdPercent = 99;
    expect(getSessionSettings().autoCompact).toEqual({
      enabled: false,
      thresholdPercent: 30,
    });
  });

  it("set with undefined value is a no-op (undefined = 不覆盖)", () => {
    setSessionSetting("waitTimeoutMinutes", undefined);
    expect(getSessionSettings()).toEqual({});
  });

  it("clearSessionSetting removes a single key", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "low");
    clearSessionSetting("waitTimeoutMinutes");
    expect(getSessionSettings()).toEqual({ memberThinkingLevel: "low" });
  });

  it("clearAllSessionSettings empties everything", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "low");
    clearAllSessionSettings();
    expect(getSessionSettings()).toEqual({});
  });

  it("clearSessionSettingsMemory empties memory only (session_shutdown 补充通道)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    clearSessionSettingsMemory();
    expect(getSessionSettings()).toEqual({});
  });
});

describe("reconcileSessionSettings — pi 会话切换失效守卫", () => {
  beforeEach(() => {
    resetSessionSettingsState();
  });

  it("keeps the overlay when the recorded sessionId matches (same pi session)", () => {
    // 真实时序：session_start 先于任何用户设置（reconcile 记录当前会话）
    expect(reconcileSessionSettings("session-A")).toBe(false);
    setSessionSetting("waitTimeoutMinutes", 5);
    // 同 ID 重复 reconcile：保留，返回 false
    expect(reconcileSessionSettings("session-A")).toBe(false);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("clears on the first reconcile when the overlay predates any recorded session (session_start 未先行)", () => {
    // 极端时序（如扩展热重载后）：设置先于首次 reconcile → 无证据表明属于当前会话 → 清除
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(reconcileSessionSettings("session-A")).toBe(true);
    expect(getSessionSettings()).toEqual({});
  });

  it("clears the overlay when the sessionId changes (session_start 对比变化则清除)", () => {
    reconcileSessionSettings("session-A"); // 记录当前会话
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(reconcileSessionSettings("session-B")).toBe(true);
    expect(getSessionSettings()).toEqual({});
  });

  it("returns false and keeps state when the overlay is empty (nothing to clear)", () => {
    reconcileSessionSettings("session-A");
    expect(reconcileSessionSettings("session-B")).toBe(false);
  });

  it("does not clear when the sessionId is an empty string (fail-open, 会话标识不可用)", () => {
    reconcileSessionSettings("session-A");
    setSessionSetting("waitTimeoutMinutes", 5);
    // 空串：不清除、不改写记录 —— 之后同 ID reconcile 仍视为同一会话
    expect(reconcileSessionSettings("")).toBe(false);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
    expect(reconcileSessionSettings("session-A")).toBe(false);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("updates the recorded sessionId after a clear (later same-id reconcile keeps)", () => {
    reconcileSessionSettings("session-A");
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(reconcileSessionSettings("session-B")).toBe(true);
    // 已清除 + 记录更新为 B：再 reconcile(B) 无事发生
    expect(reconcileSessionSettings("session-B")).toBe(false);
    setSessionSetting("memberThinkingLevel", "high");
    expect(reconcileSessionSettings("session-B")).toBe(false);
    expect(getSessionSettings().memberThinkingLevel).toBe("high");
  });
});

describe("snapshot primitives — save/load/clearBinding（resume 恢复通道）", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    resetSessionSettingsState();
    tmpDir = mkdtempSync(join(tmpdir(), "team-session-settings-test-"));
    sessionDir = join(tmpDir, "sessions", "team-a", "sid-1");
  });

  afterEach(() => {
    resetSessionSettingsState();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save writes the overlay as YAML to <sessionDir>/session-settings.yaml and returns true", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "high");
    expect(saveSessionSettingsSnapshot(sessionDir)).toBe(true);
    const path = getSessionSettingsSnapshotPath(sessionDir);
    expect(existsSync(path)).toBe(true);
    const parsed = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(parsed.waitTimeoutMinutes).toBe(5);
    expect(parsed.memberThinkingLevel).toBe("high");
  });

  it("round-trips: save → memory cleared → load restores the same overlay", () => {
    setSessionSetting("autoCompact", { enabled: false, thresholdPercent: 30 });
    saveSessionSettingsSnapshot(sessionDir);
    // 模拟 /new 清内存（快照保留）
    clearSessionSettingsMemory();
    expect(getSessionSettings()).toEqual({});
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(true);
    expect(getSessionSettings()).toEqual({
      autoCompact: { enabled: false, thresholdPercent: 30 },
    });
  });

  it("save leaves no .tmp residue (atomic tmp+rename)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    saveSessionSettingsSnapshot(sessionDir);
    const tmpPath = `${getSessionSettingsSnapshotPath(sessionDir)}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("save is fail-open when the target directory cannot be created (fs failure)", () => {
    // 父路径是一个文件 → mkdirSync 必然失败
    const fileAsParent = join(tmpDir, "not-a-dir");
    writeFileSync(fileAsParent, "x", "utf-8");
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(() => saveSessionSettingsSnapshot(join(fileAsParent, "sub"))).not.toThrow();
    expect(saveSessionSettingsSnapshot(join(fileAsParent, "sub"))).toBe(false);
    // 内存照常生效（fail-open：仅 resume 恢复能力降级）
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("save cleans up .tmp residue on rename failure (原子写失败无残留, 审查 #3)", () => {
    // 目标路径已存在同名目录 → rename(file → dir) 必然失败（EISDIR）
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(getSessionSettingsSnapshotPath(sessionDir));
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(saveSessionSettingsSnapshot(sessionDir)).toBe(false);
    expect(existsSync(`${getSessionSettingsSnapshotPath(sessionDir)}.tmp`)).toBe(false);
    // 内存照常生效
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("load returns false without side effects when the file is missing", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    clearSessionSettingsMemory();
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(false);
    expect(getSessionSettings()).toEqual({});
    // recorded 未被改写：reconcile("session-B") 仍按旧记录对比（此处无记录 → 异 ID 亦无事）
    expect(reconcileSessionSettings("session-B")).toBe(false);
  });

  it("load returns false without side effects when the file is corrupted (parse failure, fail-open)", () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(getSessionSettingsSnapshotPath(sessionDir), "waitTimeoutMinutes: [broken: {", "utf-8");
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(false);
    expect(getSessionSettings()).toEqual({});
  });

  it("load returns false when the file is not an object (fail-open)", () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(getSessionSettingsSnapshotPath(sessionDir), "- just\n- a\n- list\n", "utf-8");
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(false);
    expect(getSessionSettings()).toEqual({});
  });

  it("load keeps memory when the overlay is non-empty (本会话显式设置优先, S5)", () => {
    setSessionSetting("waitTimeoutMinutes", 30);
    saveSessionSettingsSnapshot(sessionDir);
    // 内存非空 → 不加载快照
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(false);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(30);
  });

  it("load records the current pi sessionId (防 reload 误清)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    saveSessionSettingsSnapshot(sessionDir);
    clearSessionSettingsMemory();
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(true);
    // 同会话后续 reconcile 不清除
    expect(reconcileSessionSettings("session-B")).toBe(false);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
    // 会话切换 → 清除
    expect(reconcileSessionSettings("session-C")).toBe(true);
  });

  it("load binds to the sessionDir — later clears write back to the same snapshot (防复活)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "low");
    saveSessionSettingsSnapshot(sessionDir);
    clearSessionSettingsMemory();
    loadSessionSettingsSnapshot(sessionDir, "session-B");

    // 恢复后清除一个字段 → 快照同步移除该字段
    clearSessionSetting("memberThinkingLevel");
    const parsed = parseYaml(readFileSync(getSessionSettingsSnapshotPath(sessionDir), "utf-8")) as Record<string, unknown>;
    expect(parsed.memberThinkingLevel).toBeUndefined();
    expect(parsed.waitTimeoutMinutes).toBe(5);

    // 清除最后一个字段 → 快照文件删除（不复活）
    clearSessionSetting("waitTimeoutMinutes");
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(false);
  });

  it("load drops unknown top-level keys (only TeamSettings keys enter the overlay)", () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      getSessionSettingsSnapshotPath(sessionDir),
      "waitTimeoutMinutes: 5\nsneakyKey: 42\nmemberModel:\n  mode: fixed\n",
      "utf-8"
    );
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(true);
    const overlay = getSessionSettings() as Record<string, unknown>;
    expect(overlay.waitTimeoutMinutes).toBe(5);
    expect(overlay.memberModel).toEqual({ mode: "fixed" });
    expect("sneakyKey" in overlay).toBe(false);
  });

  it("load drops invalid field values (字段级类型校验镜像全局 loadSettings, 审查 #2)", () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      getSessionSettingsSnapshotPath(sessionDir),
      [
        "memberModel:",
        "  mode: bogus",
        "  model: 42",
        "autoCompact:",
        '  enabled: "yes"',
        "  thresholdPercent: 55",
        "  thresholdTokens: -1",
        "  timeoutMinutes: 0",
        "waitTimeoutMinutes: -3",
        "memberThinkingLevel: ultra",
        "messageCoalescing:",
        "  enabled: false",
        "  maxBatchSize: 0",
        "  maxBatchChars: 4000",
      ].join("\n"),
      "utf-8"
    );
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(true);
    const overlay = getSessionSettings();
    // 非法字段全部丢弃；合法字段逐个保留
    expect(overlay.memberModel).toBeUndefined();
    expect(overlay.autoCompact).toEqual({ thresholdPercent: 55 });
    expect(overlay.waitTimeoutMinutes).toBeUndefined();
    expect(overlay.memberThinkingLevel).toBeUndefined();
    expect(overlay.messageCoalescing).toEqual({ enabled: false, maxBatchChars: 4000 });
  });

  it("load keeps valid scalars (0 = unlimited wait budget survives; all seven thinking levels accepted)", () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      getSessionSettingsSnapshotPath(sessionDir),
      "waitTimeoutMinutes: 0\nmemberThinkingLevel: high\n",
      "utf-8"
    );
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(true);
    expect(getSessionSettings()).toEqual({ waitTimeoutMinutes: 0, memberThinkingLevel: "high" });
  });

  it("load drops explicit null values (overlay 类型无 null 魔法)", () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      getSessionSettingsSnapshotPath(sessionDir),
      "waitTimeoutMinutes: null\nautoCompact:\n  enabled: null\n",
      "utf-8"
    );
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(false);
    expect(getSessionSettings()).toEqual({});
  });

  it("load returns false when no field survives validation (无可恢复内容)", () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      getSessionSettingsSnapshotPath(sessionDir),
      "waitTimeoutMinutes: -3\nmemberThinkingLevel: ultra\n",
      "utf-8"
    );
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(false);
    expect(getSessionSettings()).toEqual({});
  });

  it("clearAllSessionSettings deletes the bound snapshot (S7: 清了不复活)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(saveSessionSettingsSnapshot(sessionDir)).toBe(true);
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);

    clearAllSessionSettings();
    expect(getSessionSettings()).toEqual({});
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(false);

    // 快照已删 → resume 无法恢复
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(false);
  });

  it("clearSessionSettingsMemory keeps the snapshot (session_shutdown 只清内存)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    saveSessionSettingsSnapshot(sessionDir);
    clearSessionSettingsMemory();
    expect(getSessionSettings()).toEqual({});
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);
    // 快照保留 → 跨进程 /team resume 可恢复
    expect(loadSessionSettingsSnapshot(sessionDir, "session-B")).toBe(true);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("clearSessionSetting rewrites the snapshot without the cleared field while bound", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "low");
    saveSessionSettingsSnapshot(sessionDir);

    clearSessionSetting("memberThinkingLevel");
    const parsed = parseYaml(readFileSync(getSessionSettingsSnapshotPath(sessionDir), "utf-8")) as Record<string, unknown>;
    expect(parsed.waitTimeoutMinutes).toBe(5);
    expect(parsed.memberThinkingLevel).toBeUndefined();
  });

  it("unbound clearSessionSetting only touches memory (no snapshot side effects)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    clearSessionSetting("waitTimeoutMinutes");
    expect(getSessionSettings()).toEqual({});
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(false);
  });

  it("session switch clears the binding — unrelated clearAll in the new session cannot delete the old snapshot (审查 #1 回归)", () => {
    // 团队会话 A（pi session X）活跃期：set + save → binding = dirA
    reconcileSessionSettings("session-X");
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(saveSessionSettingsSnapshot(sessionDir)).toBe(true);
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);

    // /new → session Y：reconcile 清内存 + 清 binding（不碰磁盘）
    expect(reconcileSessionSettings("session-Y")).toBe(true);
    expect(getSessionSettings()).toEqual({});

    // 会话 Y 中的无关清除动作不得删除旧会话快照
    clearAllSessionSettings();
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);

    // 旧会话快照仍可被 resume 恢复
    expect(loadSessionSettingsSnapshot(sessionDir, "session-Y")).toBe(true);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("session switch clears the binding even when the overlay is already empty (shutdown-then-start 时序)", () => {
    reconcileSessionSettings("session-X");
    setSessionSetting("waitTimeoutMinutes", 5);
    saveSessionSettingsSnapshot(sessionDir);
    // shutdown 补充通道：只清内存、binding 保留（设计内）
    clearSessionSettingsMemory();
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);
    // session_start(Y)：overlay 已空 → 不返回清除，但 binding 必须清（跨会话残留）
    expect(reconcileSessionSettings("session-Y")).toBe(false);
    // 无 binding → 空 overlay 的 clear 分支不触碰磁盘
    clearSessionSetting("waitTimeoutMinutes");
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);
  });

  it("same-session reconcile keeps the binding (clearAll still deletes the current snapshot, S7)", () => {
    reconcileSessionSettings("session-X");
    setSessionSetting("waitTimeoutMinutes", 5);
    saveSessionSettingsSnapshot(sessionDir);
    expect(reconcileSessionSettings("session-X")).toBe(false);
    clearAllSessionSettings();
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(false);
  });

  it("DEFAULT_SETTINGS is untouched by the overlay layer", () => {
    setSessionSetting("waitTimeoutMinutes", 0);
    clearAllSessionSettings();
    expect(DEFAULT_SETTINGS.waitTimeoutMinutes).toBe(15);
  });
});

describe("active-period snapshot write (阶段 3: 团队活跃期即时写盘)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    resetSessionSettingsState();
    tmpDir = mkdtempSync(join(tmpdir(), "team-session-settings-active-"));
    sessionDir = join(tmpDir, "sessions", "team-a", "sid-1");
  });

  afterEach(() => {
    resetSessionSettingsState();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("set during an active team session writes the snapshot immediately (文件内容断言)", () => {
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "high");
    const parsed = parseYaml(readFileSync(getSessionSettingsSnapshotPath(sessionDir), "utf-8")) as Record<string, unknown>;
    expect(parsed.waitTimeoutMinutes).toBe(5);
    expect(parsed.memberThinkingLevel).toBe("high");
  });

  it("set outside an active session is memory-only (不变量 2: 快照只在团队活跃期间写入)", () => {
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(false);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("setActiveSessionDir(null) stops snapshot writes (S6: stop 后变更纯内存, 已有快照不被改写)", () => {
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);

    // /team stop → onSessionEnd → 活跃目录置空
    setActiveSessionDir(null);
    setSessionSetting("memberThinkingLevel", "low");
    const parsed = parseYaml(readFileSync(getSessionSettingsSnapshotPath(sessionDir), "utf-8")) as Record<string, unknown>;
    // 快照仍为「最近活跃期状态」：waitTimeout=5，无 thinking
    expect(parsed.waitTimeoutMinutes).toBe(5);
    expect(parsed.memberThinkingLevel).toBeUndefined();
    expect(getSessionSettings().memberThinkingLevel).toBe("low");
  });

  it("set during an active session is fail-open when the snapshot cannot be written (fs 失败不阻塞设置)", () => {
    const fileAsParent = join(tmpDir, "not-a-dir");
    writeFileSync(fileAsParent, "x", "utf-8");
    setActiveSessionDir(join(fileAsParent, "sub"));
    expect(() => setSessionSetting("waitTimeoutMinutes", 5)).not.toThrow();
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("clear during an active session rewrites the snapshot; clearing the last key deletes it", () => {
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "low");
    clearSessionSetting("memberThinkingLevel");
    let parsed = parseYaml(readFileSync(getSessionSettingsSnapshotPath(sessionDir), "utf-8")) as Record<string, unknown>;
    expect(parsed.waitTimeoutMinutes).toBe(5);
    expect(parsed.memberThinkingLevel).toBeUndefined();

    clearSessionSetting("waitTimeoutMinutes");
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(false);
  });

  it("reconcile session change clears the active dir (跨会话残留防线)", () => {
    reconcileSessionSettings("session-X");
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);

    // /new → session Y：reconcile 清内存 + 清 active dir（防御层，正常由 onSessionEnd 处理）
    reconcileSessionSettings("session-Y");
    setSessionSetting("memberThinkingLevel", "low");
    // 无活跃目录 → 新 set 不写盘
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);
    const parsed = parseYaml(readFileSync(getSessionSettingsSnapshotPath(sessionDir), "utf-8")) as Record<string, unknown>;
    expect(parsed.memberThinkingLevel).toBeUndefined();
  });

  it("S8: multi-team snapshots are independent (按 sessionDir 隔离)", () => {
    const dirB = join(tmpDir, "sessions", "team-b", "sid-9");
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    clearSessionSettingsMemory();
    setActiveSessionDir(dirB);
    setSessionSetting("memberThinkingLevel", "low");

    // 各自 resume 恢复各自状态
    resetSessionSettingsState();
    expect(loadSessionSettingsSnapshot(sessionDir, "session-A")).toBe(true);
    expect(getSessionSettings()).toEqual({ waitTimeoutMinutes: 5 });
    clearSessionSettingsMemory();
    expect(loadSessionSettingsSnapshot(dirB, "session-A")).toBe(true);
    expect(getSessionSettings()).toEqual({ memberThinkingLevel: "low" });
  });
});

describe("binding 与团队会话生命周期联动（审查 #1 回归）", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    resetSessionSettingsState();
    tmpDir = mkdtempSync(join(tmpdir(), "team-session-settings-binding-"));
    sessionDir = join(tmpDir, "sessions", "team-a", "sid-1");
  });

  afterEach(() => {
    resetSessionSettingsState();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stop 后 clear 冻结快照（S6: clear 也纯内存，快照保持最近活跃期状态）", () => {
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    setSessionSetting("memberThinkingLevel", "low");
    // /team stop → onSessionEnd → active 与 binding 均置空
    setActiveSessionDir(null);

    clearSessionSetting("waitTimeoutMinutes");
    clearAllSessionSettings();
    expect(getSessionSettings()).toEqual({});

    // 快照冻结为最近活跃期状态（两字段都未被 stop 后的 clear 触及）
    const parsed = parseYaml(readFileSync(getSessionSettingsSnapshotPath(sessionDir), "utf-8")) as Record<string, unknown>;
    expect(parsed.waitTimeoutMinutes).toBe(5);
    expect(parsed.memberThinkingLevel).toBe("low");
    // stop→clear→resume 同一会话恢复 clear 前的值（S7 只约束活跃期 clear）
    expect(loadSessionSettingsSnapshot(sessionDir, "session-A")).toBe(true);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });

  it("跨会话 clear 不动旧会话快照（S8: binding 随 onSessionStart 更新）", () => {
    const dirB = join(tmpDir, "sessions", "team-b", "sid-9");
    // 会话 A 活跃：set → 快照 A 落盘
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);

    // stop A → start B：binding 联动到 B
    setActiveSessionDir(dirB);
    setSessionSetting("memberThinkingLevel", "low");
    expect(existsSync(getSessionSettingsSnapshotPath(dirB))).toBe(true);

    // B 中 clear 只作用于 B 的快照（清空 overlay → 删 B 快照），A 的快照不受影响
    clearSessionSetting("memberThinkingLevel");
    clearSessionSetting("waitTimeoutMinutes");
    expect(existsSync(getSessionSettingsSnapshotPath(dirB))).toBe(false);
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);

    // B 中 clearAll 同样不动 A
    setSessionSetting("memberThinkingLevel", "high");
    clearAllSessionSettings();
    expect(existsSync(getSessionSettingsSnapshotPath(sessionDir))).toBe(true);
    // A 的快照仍可被 A 的 resume 恢复
    expect(loadSessionSettingsSnapshot(sessionDir, "session-A")).toBe(true);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);
  });
});
