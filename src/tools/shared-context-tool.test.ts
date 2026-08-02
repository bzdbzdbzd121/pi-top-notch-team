import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerSharedContextTool, SHARED_CONTEXT_TOOL_NAME } from "./shared-context-tool";
import { startSession, endSession, getSessionState } from "../session/state";
import { getSharedContextPath } from "../session/shared-context";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function createMockPi(): ExtensionAPI {
  const tools: any[] = [];
  return {
    registerTool: vi.fn((def: any) => {
      tools.push(def);
    }),
    getAllTools: vi.fn().mockReturnValue(tools),
    getActiveTools: vi.fn().mockReturnValue(tools.map((t: any) => t.name)),
    setActiveTools: vi.fn(),
  } as any;
}

describe("write_shared_context tool", () => {
  let pi: ExtensionAPI;
  let toolDef: any;
  let executeFn: Function;
  let tmpDir: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    pi = createMockPi();
    toolDef = null;
    executeFn = () => {};
    pi.registerTool = vi.fn((def: any) => {
      if (def.name === SHARED_CONTEXT_TOOL_NAME) {
        toolDef = def;
        executeFn = def.execute;
      }
    });
    registerSharedContextTool(pi);

    tmpDir = mkdtempSync(join(tmpdir(), "shared-context-tool-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
    endSession();
  });

  function startActiveSession() {
    startSession({
      name: "test-team",
      description: "Test",
      members: [{ name: "worker", systemPrompt: "do work" }],
    });
  }

  it("registers the tool with required content parameter", () => {
    expect(toolDef).not.toBeNull();
    expect(toolDef.name).toBe("write_shared_context");
    expect(toolDef.parameters.required).toContain("content");
    expect(toolDef.parameters.properties.content.type).toBe("string");
  });

  it("returns error outside an active session", async () => {
    endSession();
    const result = await executeFn("call-1", { content: "# doc" });
    expect(result.content[0].text).toContain("活跃的团队会话");
  });

  it("writes content to the session shared-context path and marks it written", async () => {
    startActiveSession();
    const session = getSessionState();
    expect(session.sharedContextWritten).toBe(false);

    const content = "# Shared Context — test-team\n\n## 目标\n完成迁移";
    const result = await executeFn("call-2", { content });

    // File written at the session-scoped path
    const expectedPath = getSharedContextPath("test-team", session.sessionId);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toBe(content);

    // Flag lifted → start_member gate opens
    expect(getSessionState().sharedContextWritten).toBe(true);

    // Result mentions the path and the next step
    expect(result.content[0].text).toContain("已写入");
    expect(result.content[0].text).toContain(expectedPath);
    expect(result.content[0].text).toContain("start_member");
    expect(result.details.path).toBe(expectedPath);
  });

  it("overwrites previous content on repeated calls", async () => {
    startActiveSession();
    await executeFn("call-1", { content: "# v1" });
    const result = await executeFn("call-2", { content: "# v2\nupdated" });

    const session = getSessionState();
    const p = getSharedContextPath("test-team", session.sessionId);
    expect(readFileSync(p, "utf-8")).toBe("# v2\nupdated");
    expect(result.details.chars).toBe("# v2\nupdated".length);
    expect(getSessionState().sharedContextWritten).toBe(true);
  });

  it("does NOT mark written when the fs write fails (gate stays closed)", async () => {
    startActiveSession();
    const session = getSessionState();
    // Make the target path unwritable: create a directory where the file should be
    const p = getSharedContextPath("test-team", session.sessionId);
    mkdirSync(p, { recursive: true }); // directory at file path → writeFileSync throws EISDIR

    const result = await executeFn("call-3", { content: "# doc" });

    expect(result.content[0].text).toContain("写入共享上下文失败");
    expect(getSessionState().sharedContextWritten).toBe(false);
  });

  it("does not mark written when there is no team definition", async () => {
    startSession(null as any); // active but teamDefinition null (defensive path)
    const result = await executeFn("call-4", { content: "# doc" });
    expect(result.content[0].text).toContain("没有团队定义");
    expect(getSessionState().sharedContextWritten).toBe(false);
  });
});
