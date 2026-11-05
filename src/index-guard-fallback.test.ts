import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMockContext } from "./test/fixtures/mock-extension-api";

// ── 阶段 2 审查修复：设置读取异常必须回落「开启 + 默认次数」──────────────
// 方案阶段 2 明写「异常回默认」。保留「上一次成功解析的配置」是偏离：上一次若是
// enabled:false，保留等于「异常期间约束保持关闭」，与 resolver 的「异常保持约束」
// 方向相反。本文件用可切换的抛错注入真实走一遍 index.ts 的回合边界 catch 分支。

const hoisted = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("./settings/session-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings/session-settings")>();
  return {
    ...actual,
    loadEffectiveSettings: (rootDir: string) => {
      if (hoisted.shouldThrow) {
        throw new Error("settings read exploded (test injection)");
      }
      return actual.loadEffectiveSettings(rootDir);
    },
  };
});

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: vi.fn((def: any) => {
      tools.push(def);
    }),
    registerCommand: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn(),
    getAllTools: vi.fn().mockReturnValue(tools),
    getActiveTools: vi.fn().mockReturnValue(tools.map((t: any) => t.name)),
    setActiveTools: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn().mockReturnValue(undefined),
    setLabel: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    getThinkingLevel: vi.fn().mockReturnValue("off"),
    setThinkingLevel: vi.fn(),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
    events: { on: vi.fn(), emit: vi.fn() } as any,
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
  } as any;
}

describe("agent_start settings-read failure falls back to enabled + default threshold", () => {
  let pi: ExtensionAPI;
  let tmpDir: string;

  beforeEach(async () => {
    hoisted.shouldThrow = false;
    vi.resetModules();
    delete process.env.TEAM_ROLE;
    tmpDir = mkdtempSync(join(tmpdir(), "tl-guard-fallback-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    pi = createMockPi();
    const mod = await import("../index");
    mod.default(pi);
  });

  afterEach(() => {
    hoisted.shouldThrow = false;
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getHandler(name: string): Function {
    const onCalls = (pi.on as ReturnType<typeof vi.fn>).mock.calls;
    return onCalls.find((c: any) => c[0] === name)![1];
  }

  async function startActiveSession() {
    const { startSession, endSession } = await import("./session/state");
    endSession();
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "do work" }],
    });
  }

  function writeSettings(yaml: string): void {
    writeFileSync(join(tmpDir, "settings.yaml"), yaml, "utf-8");
  }

  it("after a disabled turn, a throwing read re-arms the guard at enabled + 3", async () => {
    writeSettings("tlSelfWorkGuard:\n  enabled: false\n");
    await startActiveSession();
    const agentStart = getHandler("agent_start");
    const toolCall = getHandler("tool_call");
    const ctx = createMockContext();
    const ui = ctx.ui as unknown as { notify: ReturnType<typeof vi.fn> };

    // 对照：关闭生效（6 读全放行）
    agentStart({}, ctx);
    for (let i = 0; i < 6; i++) {
      expect(toolCall({ toolName: "read", input: { path: `src/a${i}.ts` } }, ctx)).toBeUndefined();
    }

    // 设置读取抛错 → 回合边界不得抛（否则 pi 会把工具调用全部阻断），且回默认
    hoisted.shouldThrow = true;
    expect(() => agentStart({}, ctx)).not.toThrow();
    for (const p of ["src/b0.ts", "src/b1.ts", "src/b2.ts"]) {
      expect(toolCall({ toolName: "read", input: { path: p } }, ctx)).toBeUndefined();
    }
    const blocked = toolCall({ toolName: "read", input: { path: "src/b3.ts" } }, ctx);
    expect(blocked).toEqual(expect.objectContaining({ block: true }));
    expect(blocked.reason).toContain("3 次/回合");
    // 用户可见通知同步恢复（证明不是静默的旧配置）
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("3 次/回合"), "warning");

    // 恢复读取后，下一回合仍按文件里的关闭配置（fallback 不是粘性状态）
    hoisted.shouldThrow = false;
    agentStart({}, ctx);
    for (let i = 0; i < 6; i++) {
      expect(toolCall({ toolName: "read", input: { path: `src/c${i}.ts` } }, ctx)).toBeUndefined();
    }
  });

  it("a throwing read on the very first team turn already falls back to enabled + 3", async () => {
    await startActiveSession();
    const agentStart = getHandler("agent_start");
    const toolCall = getHandler("tool_call");
    const ctx = createMockContext();
    hoisted.shouldThrow = true;

    expect(() => agentStart({}, ctx)).not.toThrow();
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      expect(toolCall({ toolName: "read", input: { path: p } }, ctx)).toBeUndefined();
    }
    expect(toolCall({ toolName: "read", input: { path: "src/d.ts" } }, ctx)).toEqual(
      expect.objectContaining({ block: true })
    );
  });
});
