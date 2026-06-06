import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockExtensionAPI, createMockContext } from "../test/fixtures/mock-extension-api";
import { registerStatusCommand } from "./status";
import { startSession, endSession } from "../session/state";
import type { TeamDefinition } from "../team/definition";

const testTeam: TeamDefinition = {
  name: "test-team",
  description: "A test team",
  members: [
    { name: "worker", systemPrompt: "Do work" },
  ],
};

describe("team status command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-status-test-"));
    process.env.TOP_NOTCH_TEAM_ROOT = tmpDir;
    endSession(); // ensure clean state before each test
  });

  afterEach(() => {
    delete process.env.TOP_NOTCH_TEAM_ROOT;
    endSession();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers a command named 'team-status'", () => {
    const pi = createMockExtensionAPI();
    registerStatusCommand(pi);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "team-status",
      expect.objectContaining({ description: expect.any(String) })
    );
  });

  it("notifies when no active session", async () => {
    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => {
      handler = opts.handler;
    });
    registerStatusCommand(pi);

    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("无活跃"),
      "info"
    );
  });

  it("shows session info when active", async () => {
    startSession(testTeam);

    const pi = createMockExtensionAPI();
    const ctx = createMockContext();
    let handler: Function = () => {};
    pi.registerCommand = vi.fn((_name, opts) => {
      handler = opts.handler;
    });
    registerStatusCommand(pi);

    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("test-team"),
      "info"
    );
  });
});
