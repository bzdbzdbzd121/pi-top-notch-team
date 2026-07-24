import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockContext } from "../../test/fixtures/mock-extension-api";
import { handleSetting } from "./setting-handler";
import { loadSettings } from "../../settings/settings";

const MODEL_A = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as any;
const MODEL_B = { provider: "openai", id: "gpt-5", name: "GPT-5" } as any;

function createCtx(options?: {
  selectImpl?: (title: string, options: string[]) => Promise<string | undefined>;
  /** Mock for ctx.ui.custom (scrollSelect). Resolve with the picker's return value,
   *  or invoke the factory to inspect the component. */
  customImpl?: (factory: any, opts?: any) => Promise<any>;
  availableModels?: Array<typeof MODEL_A>;
  currentModel?: typeof MODEL_A;
}) {
  return createMockContext({
    modelRegistry: {
      getAvailable: vi.fn().mockReturnValue(options?.availableModels ?? [MODEL_A, MODEL_B]),
    } as any,
    model: options?.currentModel ?? MODEL_A,
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
  });

  afterEach(() => {
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

  it("sets follow mode via the menu", async () => {
    const ctx = createCtx({
      selectImpl: pickContaining("成员默认模型", "跟随当前配置"),
    });
    await handleSetting(ctx as any);

    expect(loadSettings(tmpDir).memberModel).toEqual({ mode: "follow" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("跟随当前配置"),
      "info"
    );
  });

  it("sets a fixed model picked from available models", async () => {
    const ctx = createCtx({
      selectImpl: pickContaining("成员默认模型", "指定模型"),
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

  it("keeps settings unchanged when the user cancels the model picker", async () => {
    const ctx = createCtx({
      selectImpl: pickContaining("成员默认模型", "指定模型"),
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
