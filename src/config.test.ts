import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ENV = { ...process.env };

describe("getRootDir", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.TOP_NOTCH_TEAM_ROOT;
  });

  it("should return custom path when TOP_NOTCH_TEAM_ROOT is set", async () => {
    process.env.TOP_NOTCH_TEAM_ROOT = "/custom/team/root";
    const { getRootDir } = await import("./config");
    expect(getRootDir()).toBe("/custom/team/root");
  });

  it("should fall back to homedir() when TOP_NOTCH_TEAM_ROOT is not set", async () => {
    const { getRootDir } = await import("./config");
    expect(getRootDir()).toBe(join(homedir(), ".pi", "top-notch-team"));
  });

  it("should return empty string path when env var is set to empty string", async () => {
    process.env.TOP_NOTCH_TEAM_ROOT = "";
    const { getRootDir } = await import("./config");
    // Empty string is still truthy-ish, so it's used as-is
    expect(getRootDir()).toBe("");
  });
});
