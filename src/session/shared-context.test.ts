import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSharedContextPath, ensureSharedContextFile } from "./shared-context";
import type { TeamDefinition } from "../team/definition";

function createTeam(overrides?: Partial<TeamDefinition>): TeamDefinition {
  return {
    name: "test-team",
    description: "A test team",
    members: [
      { name: "analyzer", label: "分析员", systemPrompt: "你是一个分析专家" },
      { name: "worker", systemPrompt: "你是一个编码专家" },
    ],
    ...overrides,
  };
}

describe("getSharedContextPath", () => {
  let tmpDir: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shared-context-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  });

  it("should nest under sessions/<team>/<sessionId>/ when sessionId is provided", () => {
    const p = getSharedContextPath("test-team", "abc123");
    expect(p).toBe(join(tmpDir, "sessions", "test-team", "abc123", ".shared-context.md"));
  });

  it("should fall back to flat path when sessionId is null", () => {
    const p = getSharedContextPath("test-team", null);
    expect(p).toBe(join(tmpDir, "sessions", "test-team", ".shared-context.md"));
  });
});

describe("ensureSharedContextFile", () => {
  let tmpDir: string;
  const originalRoot = process.env.TOP_NOTCH_TEAM_ROOT;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shared-context-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalRoot) {
      process.env.TOP_NOTCH_TEAM_ROOT = originalRoot;
    } else {
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  });

  it("should create a stub file (with parent dirs) when missing and return its path", () => {
    const team = createTeam();
    const p = ensureSharedContextFile(team, "abc123");

    expect(p).toBe(join(tmpDir, "sessions", "test-team", "abc123", ".shared-context.md"));
    expect(existsSync(p)).toBe(true);

    const content = readFileSync(p, "utf-8");
    expect(content).toContain("test-team");
    expect(content).toContain("analyzer");
    expect(content).toContain("worker");
    // member without label falls back to name only
    expect(content).toContain("分析员");
  });

  it("should handle a team with zero members (dynamic mode design phase)", () => {
    const team = createTeam({ name: "_dynamic_123", members: [] });
    const p = ensureSharedContextFile(team, "sid");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("_dynamic_123");
  });

  it("should NOT overwrite an existing shared context file", () => {
    const team = createTeam();
    const dir = join(tmpDir, "sessions", "test-team", "abc123");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, ".shared-context.md");
    writeFileSync(p, "# 已有的共享上下文\n重要内容", "utf-8");

    const result = ensureSharedContextFile(team, "abc123");
    expect(result).toBe(p);
    expect(readFileSync(p, "utf-8")).toBe("# 已有的共享上下文\n重要内容");
  });
});
