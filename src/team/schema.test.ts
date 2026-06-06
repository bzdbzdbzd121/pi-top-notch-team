import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateTeamDefinition, type ValidationResult } from "./schema";

function parseYamlFile(filename: string): unknown {
  const filePath = resolve(__dirname, "../test/fixtures", filename);
  return parseYaml(readFileSync(filePath, "utf-8"));
}

describe("validateTeamDefinition", () => {
  it("passes a valid team definition", () => {
    const data = parseYamlFile("valid-team.yaml");
    const result: ValidationResult = validateTeamDefinition(data);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects a team with empty name", () => {
    const data = parseYamlFile("invalid-team.yaml");
    const result: ValidationResult = validateTeamDefinition(data);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects non-object input", () => {
    const result = validateTeamDefinition(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Team definition must be an object");
  });

  it("rejects missing name", () => {
    const result = validateTeamDefinition({
      description: "test",
      members: [{ name: "a", systemPrompt: "do" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects empty members array", () => {
    const result = validateTeamDefinition({
      name: "test",
      description: "test",
      members: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one member"))).toBe(true);
  });

  it("rejects member with missing systemPrompt", () => {
    const result = validateTeamDefinition({
      name: "test",
      description: "test",
      members: [{ name: "worker" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("systemPrompt"))).toBe(true);
  });

  it("rejects duplicate member names", () => {
    const result = validateTeamDefinition({
      name: "test",
      description: "test",
      members: [
        { name: "worker", systemPrompt: "do" },
        { name: "worker", systemPrompt: "also do" },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate") || e.includes("unique"))).toBe(true);
  });

  it("rejects invalid member name characters", () => {
    const result = validateTeamDefinition({
      name: "test",
      description: "test",
      members: [{ name: "Worker 1!", systemPrompt: "do" }],
    });
    expect(result.valid).toBe(false);
  });
});
