import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockContext } from "../../test/fixtures/mock-extension-api";
import { handleSetting } from "./setting-handler";
import { loadSettings } from "../../settings/settings";
import { endSession } from "../../session/state";
import {
  getSessionSettings,
  setSessionSetting,
  clearAllSessionSettings,
  setActiveSessionDir,
  resetSessionSettingsState,
  resolveEffectiveSettings,
} from "../../settings/session-settings";

const MODEL_A = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as any;
const MODEL_B = { provider: "openai", id: "gpt-5", name: "GPT-5" } as any;

function createCtx(options?: {
  selectImpl?: (title: string, options: string[]) => Promise<string | undefined>;
  /** Mock for ctx.ui.custom (scrollSelect). Resolve with the picker's return value,
   *  or invoke the factory to inspect the component. */
  customImpl?: (factory: any, opts?: any) => Promise<any>;
  availableModels?: Array<typeof MODEL_A>;
  currentModel?: typeof MODEL_A;
  /** Current pi sessionId. Absent → sessionManager 不可用（临时入口禁用，fail-open）。 */
  sessionId?: string;
}) {
  return createMockContext({
    modelRegistry: {
      getAvailable: vi.fn().mockReturnValue(options?.availableModels ?? [MODEL_A, MODEL_B]),
    } as any,
    model: options?.currentModel ?? MODEL_A,
    ...(options?.sessionId !== undefined
      ? {
          sessionManager: {
            getEntries: vi.fn().mockReturnValue([]),
            getSessionId: vi.fn().mockReturnValue(options.sessionId),
          } as any,
        }
      : {}),
    ui: {
      ...createMockContext().ui,
      select: vi.fn(options?.selectImpl ?? (() => Promise.resolve(undefined))),
      custom: vi.fn(options?.customImpl ?? (() => Promise.resolve(undefined))),
    } as any,
  });
}

/** Select impl helpers: pick the option containing `text` at each step. */
function pickContaining(...texts: Array<string | undefined>) {
  let i = 0;
  return (_title: string, options: string[]): Promise<string | undefined> => {
    const text = texts[i++];
    if (text === undefined) return Promise.resolve(undefined);
    const hit = options.find((o) => o.includes(text));
    return Promise.resolve(hit);
  };
}

describe("/team setting", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-setting-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    resetSessionSettingsState();
  });

  afterEach(() => {
    endSession();
    resetSessionSettingsState();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when the user cancels the top-level menu", async () => {
    const ctx = createCtx({ selectImpl: () => Promise.resolve(undefined) });
    await handleSetting(ctx as any);
    // Settings file never written; defaults still apply
    expect(loadSettings(tmpDir).memberModel.mode).toBe("follow");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("sets follow mode via the menu (global scope)", async () => {
    const ctx = createCtx({
      selectImpl: pickContaining("设置作用域", "成员默认模型", "跟随当前配置"),
    });
    await handleSetting(ctx as any);

    expect(loadSettings(tmpDir).memberModel).toEqual({ mode: "follow" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("跟随当前配置"),
      "info"
    );
  });

  it("sets a fixed model picked from available models (global scope)", async () => {
    const ctx = createCtx({
      selectImpl: pickContaining("设置作用域", "成员默认模型", "指定模型"),
      // scrollSelect resolves with the picked model ref
      customImpl: () => Promise.resolve("openai/gpt-5"),
    });
    await handleSetting(ctx as any);

    const saved = loadSettings(tmpDir);
    expect(saved.memberModel.mode).toBe("fixed");
    expect(saved.memberModel.model).toBe("openai/gpt-5");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("openai/gpt-5"),
      "info"
    );
  });

  it("warns when no logged-in models are available", async () => {
    const ctx = createCtx({
      availableModels: [],
      selectImpl: pickContaining("成员默认模型", "指定模型"),
    });
    await handleSetting(ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("没有可用的已登录模型"),
      "warning"
    );
    expect(loadSettings(tmpDir).memberModel.mode).toBe("follow");
  });

  it("keeps settings unchanged when the user cancels the model picker (global scope)", async () => {
    const ctx = createCtx({
      selectImpl: pickContaining("设置作用域", "成员默认模型", "指定模型"),
      customImpl: () => Promise.resolve(undefined), // Esc in scroll picker
    });
    await handleSetting(ctx as any);

    expect(loadSettings(tmpDir).memberModel.mode).toBe("follow");
  });

  it("marks the current fixed model with ● in the model picker", async () => {
    // Pre-seed a fixed setting
    const seeded = createCtx({
      selectImpl: pickContaining("成员默认模型", "指定模型"),
      customImpl: () => Promise.resolve("anthropic/claude-sonnet-4-5"),
    });
    await handleSetting(seeded as any);

    const identityTheme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    };
    let renderedLines: string[] = [];
    const seenOptions: string[][] = [];
    const ctx = createCtx({
      selectImpl: (_title, options) => {
        seenOptions.push(options);
        return Promise.resolve(
          options.find((o) => o.includes("成员默认模型") || o.includes("指定模型"))
        );
      },
      customImpl: async (factory: any) => {
        // Invoke the real ScrollSelectComponent factory and inspect its render
        const component = await factory(
          { requestRender: vi.fn() },
          identityTheme,
          {},
          () => {}
        );
        renderedLines = component.render(120);
        return undefined; // cancel
      },
    });
    await handleSetting(ctx as any);

    // The fixed model line carries the ● marker
    expect(
      renderedLines.some((l) => l.includes("● anthropic/claude-sonnet-4-5"))
    ).toBe(true);
    // The other model has no marker
    expect(renderedLines.some((l) => l.includes("● openai/gpt-5"))).toBe(false);
    // Top-level menu shows the fixed model as current
    expect(
      seenOptions[0]?.some((o) => o.includes("指定模型：anthropic/claude-sonnet-4-5"))
    ).toBe(true);
  });

  it("shows the TL current model in follow-mode description", async () => {
    const seenTitles: string[] = [];
    const ctx = createCtx({
      currentModel: MODEL_B,
      selectImpl: (title, options) => {
        seenTitles.push(title);
        return Promise.resolve(options.find((o) => o.includes("跟随当前配置")) ?? options[0]);
      },
    });
    await handleSetting(ctx as any);

    // Mode picker step lists the follow option annotated with the TL model
    const selectMock = ctx.ui.select as ReturnType<typeof vi.fn>;
    const modePickerOptions = selectMock.mock.calls[1]?.[1] as string[];
    expect(modePickerOptions?.some((o) => o.includes("openai/gpt-5"))).toBe(true);
  });
});

describe("/team setting — 临时设置作用域 (阶段 4)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-setting-temp-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    resetSessionSettingsState();
  });

  afterEach(() => {
    endSession();
    resetSessionSettingsState();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("default scope is 临时 — writes go to the overlay, settings.yaml untouched (文件内容断言)", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await import("../../settings/settings");
    // 全局已有固定模型（≠ 菜单要设置的 follow），使字段级 diff 产生 pin
    const g = structuredClone(DEFAULT_SETTINGS);
    g.memberModel = { mode: "fixed", model: "openai/gpt-5" };
    saveSettings(g, tmpDir);

    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("成员默认模型", "跟随当前配置"),
    });
    await handleSetting(ctx as any);

    // 内存 overlay 生效（字段级 pin：只写变更的 mode）
    expect(getSessionSettings().memberModel).toEqual({ mode: "follow" });
    // 全局文件零污染
    expect(loadSettings(tmpDir).memberModel.mode).toBe("fixed");
    // merge 生效值 = follow（字段级 pin：mode 覆盖，全局 model 字段随 merge 存活）
    expect(
      resolveEffectiveSettings(loadSettings(tmpDir), getSessionSettings()).memberModel
    ).toMatchObject({ mode: "follow" });
    // 通知含临时语义（会话外：重启后失效）
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("仅当前 pi 会话生效"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("重启后失效"),
      "info"
    );
  });

  it("scope switch flips to 全局 — subsequent writes go to settings.yaml", async () => {
    const seen: string[][] = [];
    let pass = 0;
    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: (_title, options) => {
        seen.push(options);
        pass++;
        if (pass === 1) return Promise.resolve(options.find((o) => o.includes("设置作用域")));
        if (pass === 2) return Promise.resolve(options.find((o) => o.includes("成员默认模型")));
        return Promise.resolve(options.find((o) => o.includes("跟随当前配置")));
      },
    });
    await handleSetting(ctx as any);

    // 第一次菜单：默认临时作用域（● 在临时侧）
    expect(seen[0]?.[0]).toContain("●仅当前会话（临时）");
    // 切换后重新显示：● 移到全局侧
    expect(seen[1]?.[0]).toContain("●全局");
    // 写入全局文件，overlay 保持为空
    expect(existsSync(join(tmpDir, "settings.yaml"))).toBe(true);
    expect(loadSettings(tmpDir).memberModel).toEqual({ mode: "follow" });
    expect(getSessionSettings()).toEqual({});
  });

  it("[临时] badges appear only on covered keys; ⑦ appears only when overlay non-empty", async () => {
    setSessionSetting("autoCompact", { enabled: true, thresholdPercent: 55 });
    setSessionSetting("waitTimeoutMinutes", 3);
    const seen: string[][] = [];
    const ctx = createCtx({
      selectImpl: (_title, options) => {
        seen.push(options);
        return Promise.resolve(undefined); // Esc
      },
    });
    await handleSetting(ctx as any);

    const top = seen[0] ?? [];
    const waitItem = top.find((o) => o.includes("等待上限"))!;
    expect(waitItem).toContain("[临时]");
    const acItem = top.find((o) => o.includes("自动压缩"))!;
    expect(acItem).toContain("[临时]");
    // 未覆盖的键无徽标
    const modelItem = top.find((o) => o.includes("成员默认模型"))!;
    expect(modelItem).not.toContain("[临时]");
    // 生效值显示 = merge 后（overlay 的 55% / 3 分钟）
    expect(acItem).toContain("55%");
    expect(waitItem).toContain("3 分钟");
    // ⑦ 存在
    expect(top.some((o) => o.includes("清除全部临时设置"))).toBe(true);

    // 清空后 ⑦ 消失
    clearAllSessionSettings();
    const seen2: string[][] = [];
    const ctx2 = createCtx({
      selectImpl: (_title, options) => {
        seen2.push(options);
        return Promise.resolve(undefined);
      },
    });
    await handleSetting(ctx2 as any);
    expect(seen2[0]?.some((o) => o.includes("清除全部临时设置"))).toBe(false);
    expect(seen2[0]?.find((o) => o.includes("等待上限"))).not.toContain("[临时]");
  });

  it("temp-scope submenu edits the overlay only — 字段级 pin（global file untouched）", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await import("../../settings/settings");
    saveSettings(structuredClone(DEFAULT_SETTINGS), tmpDir);
    // 覆盖层只 pin thresholdPercent
    setSessionSetting("autoCompact", { thresholdPercent: 55 });

    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("自动压缩", "开关切换"),
    });
    await handleSetting(ctx as any);

    // overlay：只 pin 变更字段——enabled 翻转 + 已 pin 的 55%；全局的
    // timeoutMinutes(10) 不烘焙进 overlay（跟随全局）
    expect(getSessionSettings().autoCompact).toEqual({
      enabled: false,
      thresholdPercent: 55,
    });
    // 全局文件内容不变
    expect(loadSettings(tmpDir).autoCompact.enabled).toBe(true);
  });

  it("⑦ clears the overlay AND the bound snapshot (S7); settings.yaml untouched", async () => {
    const sessionDir = join(tmpDir, "sessions", "team-a", "sid-1");
    setActiveSessionDir(sessionDir);
    setSessionSetting("waitTimeoutMinutes", 5);
    expect(existsSync(join(sessionDir, "session-settings.yaml"))).toBe(true);

    const ctx = createCtx({
      selectImpl: pickContaining("清除全部临时设置"),
    });
    await handleSetting(ctx as any);

    expect(getSessionSettings()).toEqual({});
    expect(existsSync(join(sessionDir, "session-settings.yaml"))).toBe(false);
    expect(existsSync(join(tmpDir, "settings.yaml"))).toBe(false);
  });

  it("fail-open: sessionId unavailable → temp entry disabled with notify, writes go to global", async () => {
    // 默认 mock context 的 sessionManager 无 getSessionId → 临时不可用
    const seen: string[][] = [];
    let pass = 0;
    const ctx = createCtx({
      selectImpl: (_title, options) => {
        seen.push(options);
        pass++;
        if (pass === 1) return Promise.resolve(options.find((o) => o.includes("设置作用域")));
        if (pass === 2) return Promise.resolve(options.find((o) => o.includes("成员默认模型")));
        return Promise.resolve(options.find((o) => o.includes("跟随当前配置")));
      },
    });
    await handleSetting(ctx as any);

    expect(seen[0]?.[0]).toContain("临时设置不可用");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("临时设置不可用"),
      "warning"
    );
    // 写入全局，overlay 为空
    expect(existsSync(join(tmpDir, "settings.yaml"))).toBe(true);
    expect(loadSettings(tmpDir).memberModel.mode).toBe("follow");
    expect(getSessionSettings()).toEqual({});
  });

  it("model item notes when the team YAML specifies a model (此设置不生效)", async () => {
    const { startSession } = await import("../../session/state");
    startSession({
      name: "team-a",
      description: "",
      defaults: { model: "anthropic/claude-sonnet-4-5" },
      members: [],
    } as any);
    const seen: string[][] = [];
    const ctx = createCtx({
      selectImpl: (_title, options) => {
        seen.push(options);
        return Promise.resolve(undefined);
      },
    });
    await handleSetting(ctx as any);

    const modelItem = seen[0]?.find((o) => o.includes("成员默认模型"))!;
    expect(modelItem).toContain("团队 YAML 指定了 model");
  });

  it("active team session → notify mentions resume recovery", async () => {
    const { startSession } = await import("../../session/state");
    startSession({ name: "team-a", description: "", members: [] } as any);
    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("成员默认模型", "跟随当前配置"),
    });
    await handleSetting(ctx as any);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/team resume 本团队会话时将恢复"),
      "info"
    );
  });
});

describe("/team setting — 临时作用域持久化分支 (阶段 4)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-setting-temp-persist-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    resetSessionSettingsState();
  });

  afterEach(() => {
    endSession();
    resetSessionSettingsState();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("temp scope「思考强度：默认（不指定）」removes the pin (undefined → clearSessionSetting, 恢复全局)", async () => {
    setSessionSetting("memberThinkingLevel", { mode: "fixed", level: "high" });
    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("成员思考强度", "默认（不指定"),
    });
    await handleSetting(ctx as any);

    expect(getSessionSettings().memberThinkingLevel).toBeUndefined();
    expect(existsSync(join(tmpDir, "settings.yaml"))).toBe(false);
    // 通知含临时语义后缀
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("仅当前 pi 会话生效"),
      "info"
    );
  });
});

describe("/team setting — 阶段 4 审查修复 (字段级 pin)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-setting-review-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    resetSessionSettingsState();
  });

  afterEach(() => {
    endSession();
    resetSessionSettingsState();
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("复现 A：未触及字段不烘焙进 overlay，全局后续变更可传播", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await import("../../settings/settings");
    // 全局 autoCompact{enabled:true, 80%, 10min}
    saveSettings(structuredClone(DEFAULT_SETTINGS), tmpDir);

    // 临时作用域关掉开关
    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("自动压缩", "开关切换"),
    });
    await handleSetting(ctx as any);

    // 只 pin 用户变更的 enabled——80%/10min 不得烘焙
    expect(getSessionSettings().autoCompact).toEqual({ enabled: false });

    // 模拟用户随后在全局把 timeoutMinutes 改 30
    const g = loadSettings(tmpDir);
    g.autoCompact.timeoutMinutes = 30;
    saveSettings(g, tmpDir);

    // 本会话生效值跟随全局（未被烘焙值冻结）
    const effective = resolveEffectiveSettings(loadSettings(tmpDir), getSessionSettings());
    expect(effective.autoCompact).toMatchObject({
      enabled: false,
      thresholdPercent: 80,
      timeoutMinutes: 30,
    });
  });

  it("复现 B：清除阈值 → patch 为空 → 解除 pin，无幻影徽标", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await import("../../settings/settings");
    saveSettings(structuredClone(DEFAULT_SETTINGS), tmpDir); // 全局 80%

    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("自动压缩", "清除百分比阈值"),
    });
    await handleSetting(ctx as any);

    // 有效值与全局一致 → 不 pin（无幻影 pin）
    expect(getSessionSettings().autoCompact).toBeUndefined();
    // 重新打开菜单：无 [临时] 徽标、无 ⑦
    const seen: string[][] = [];
    const ctx2 = createCtx({
      sessionId: "session-A",
      selectImpl: (_title, options) => {
        seen.push(options);
        return Promise.resolve(undefined);
      },
    });
    await handleSetting(ctx2 as any);
    const top = seen[0] ?? [];
    expect(top.find((o) => o.includes("自动压缩"))).not.toContain("[临时]");
    expect(top.some((o) => o.includes("清除全部临时设置"))).toBe(false);
  });

  it("标量键：与全局不同的值才 pin；相同值 → 解除 pin", async () => {
    const { saveSettings, DEFAULT_SETTINGS } = await import("../../settings/settings");
    const g = structuredClone(DEFAULT_SETTINGS);
    g.waitTimeoutMinutes = 15;
    saveSettings(g, tmpDir);

    // 临时设为 5（≠ 全局 15）→ pin
    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("等待上限"),
    });
    (ctx.ui.input as any).mockResolvedValue("5");
    await handleSetting(ctx as any);
    expect(getSessionSettings().waitTimeoutMinutes).toBe(5);

    // 临时设为与全局相同的 15 → 解除 pin
    const ctx2 = createCtx({
      sessionId: "session-A",
      selectImpl: pickContaining("等待上限"),
    });
    (ctx2.ui.input as any).mockResolvedValue("15");
    await handleSetting(ctx2 as any);
    expect(getSessionSettings().waitTimeoutMinutes).toBeUndefined();
  });

  it("顶层循环每轮重读 overlay：切换作用域重显时 badge/⑦ 反映最新 overlay", async () => {
    let pass = 0;
    const first: string[][] = [];
    const second: string[][] = [];
    const ctx = createCtx({
      sessionId: "session-A",
      selectImpl: (_title, options) => {
        pass++;
        if (pass === 1) {
          first.push(options);
          // 菜单显示期间外部写入 overlay（模拟其他通道/未来路径）
          setSessionSetting("waitTimeoutMinutes", 3);
          return Promise.resolve(options.find((o) => o.includes("设置作用域")));
        }
        second.push(options);
        return Promise.resolve(undefined);
      },
    });
    await handleSetting(ctx as any);

    // 第一轮菜单：overlay 尚空 → 无 ⑦
    expect(first[0]?.some((o) => o.includes("清除全部临时设置"))).toBe(false);
    // 第二轮（切换作用域后重显）：overlay 已非空 → ⑦ 出现 + [临时] 徽标
    expect(second[0]?.some((o) => o.includes("清除全部临时设置"))).toBe(true);
    expect(second[0]?.find((o) => o.includes("等待上限"))).toContain("[临时]");
  });
});
