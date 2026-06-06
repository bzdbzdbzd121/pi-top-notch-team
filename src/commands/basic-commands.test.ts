import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import { registerListCommand } from "./list";
import { registerShowCommand } from "./show";
import { registerDeleteCommand } from "./delete";
import type { TeamDefinition } from "../team/definition";

describe("team list command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-list-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a command named 'team-list'", () => {
    const pi = createMockExtensionAPI();
    registerListCommand(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "team-list",
      expect.objectContaining({ description: expect.any(String) })
    );
  });

  it("notifies when no teams exist", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => {
      handler = opts.handler;
    });
    registerListCommand(pi);

    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("没有"),
      "info"
    );
  });
});

describe("team show command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-show-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a command named 'team-show'", () => {
    const pi = createMockExtensionAPI();
    registerShowCommand(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "team-show",
      expect.objectContaining({ description: expect.any(String) })
    );
  });

  it("notifies when team not found", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => {
      handler = opts.handler;
    });
    registerShowCommand(pi);

    await handler("nonexistent", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("不存在"),
      "warning"
    );
  });
});

describe("team delete command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-delete-test-"));
    mkdirSync(join(tmpDir, "teams"), { recursive: true });
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a command named 'team-delete'", () => {
    const pi = createMockExtensionAPI();
    registerDeleteCommand(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "team-delete",
      expect.objectContaining({ description: expect.any(String) })
    );
  });

  it("deletes a team after user confirmation", async () => {
    // Create a team file
    const team: TeamDefinition = {
      name: "to-delete",
      description: "Will be deleted",
      members: [{ name: "x", systemPrompt: "x" }],
    };
    const yaml = stringifyYaml(team);
    writeFileSync(join(tmpDir, "teams", "to-delete.yaml"), yaml, "utf-8");

    const pi = createMockExtensionAPI();
    const ctx = createMockContext({
      cwd: tmpDir,
      ui: {
        ...createMockContext().ui,
        confirm: vi.fn().mockResolvedValue(true),
      },
    });

    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => {
      handler = opts.handler;
    });
    registerDeleteCommand(pi);

    await handler("to-delete", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalled();
    // File should be deleted
    expect(existsSync(join(tmpDir, "teams", "to-delete.yaml"))).toBe(false);
  });

  it("does not delete without user confirmation", async () => {
    const team: TeamDefinition = {
      name: "keep-me",
      description: "Will not be deleted",
      members: [{ name: "x", systemPrompt: "x" }],
    };
    const yaml = stringifyYaml(team);
    writeFileSync(join(tmpDir, "teams", "keep-me.yaml"), yaml, "utf-8");

    const pi = createMockExtensionAPI();
    const ctx = createMockContext({
      cwd: tmpDir,
      ui: {
        ...createMockContext().ui,
        confirm: vi.fn().mockResolvedValue(false),
      },
    });

    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => {
      handler = opts.handler;
    });
    registerDeleteCommand(pi);

    await handler("keep-me", ctx);
    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(existsSync(join(tmpDir, "teams", "keep-me.yaml"))).toBe(true);
  });
});
