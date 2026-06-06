import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listTeams,
  readTeam,
  writeTeam,
  deleteTeam,
  getTeamsDir,
} from "./store";
import type { TeamDefinition } from "./definition";

describe("TeamStore", () => {
  let tmpDir: string;
  const testTeam: TeamDefinition = {
    name: "test-team",
    description: "A test team",
    defaults: { model: "anthropic/claude-sonnet-4" },
    members: [
      { name: "worker", label: "Worker", systemPrompt: "Do work" },
    ],
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "team-store-test-"));
    mkdirSync(join(tmpDir, "teams"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getTeamsDir", () => {
    it("returns the teams directory", () => {
      const dir = join(tmpDir, "teams");
      expect(dir).toBe(join(tmpDir, "teams"));
    });
  });

  describe("writeTeam", () => {
    it("creates a YAML file for the team", () => {
      writeTeam(testTeam, tmpDir);
      const filePath = join(tmpDir, "teams", "test-team.yaml");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("name: test-team");
      expect(content).toContain("description: A test team");
      expect(content).toContain("worker");
    });
  });

  describe("readTeam", () => {
    it("reads a team definition from file", () => {
      writeTeam(testTeam, tmpDir);
      const loaded = readTeam("test-team", tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe("test-team");
      expect(loaded!.members).toHaveLength(1);
      expect(loaded!.members[0].name).toBe("worker");
    });

    it("returns null for a non-existent team", () => {
      const loaded = readTeam("nonexistent", tmpDir);
      expect(loaded).toBeNull();
    });
  });

  describe("listTeams", () => {
    it("returns empty array when no teams exist", () => {
      const teams = listTeams(tmpDir);
      expect(teams).toEqual([]);
    });

    it("lists all team names", () => {
      const team2: TeamDefinition = {
        name: "another-team",
        description: "Another team",
        members: [{ name: "helper", systemPrompt: "Help" }],
      };
      writeTeam(testTeam, tmpDir);
      writeTeam(team2, tmpDir);

      const teams = listTeams(tmpDir);
      expect(teams).toHaveLength(2);
      expect(teams).toContain("test-team");
      expect(teams).toContain("another-team");
    });

    it("only lists .yaml files", () => {
      writeTeam(testTeam, tmpDir);
      // create a non-yaml file
      writeFileSync(join(tmpDir, "teams", "README.txt"), "hello");
      const teams = listTeams(tmpDir);
      expect(teams).toEqual(["test-team"]);
    });
  });

  describe("deleteTeam", () => {
    it("deletes an existing team file", () => {
      writeTeam(testTeam, tmpDir);
      expect(existsSync(join(tmpDir, "teams", "test-team.yaml"))).toBe(true);

      const deleted = deleteTeam("test-team", tmpDir);
      expect(deleted).toBe(true);
      expect(existsSync(join(tmpDir, "teams", "test-team.yaml"))).toBe(false);
    });

    it("returns false for non-existent team", () => {
      const deleted = deleteTeam("nonexistent", tmpDir);
      expect(deleted).toBe(false);
    });
  });
});
