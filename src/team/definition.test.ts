import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { TeamDefinition, TeamMember, TeamDefaults } from "./definition";

describe("TeamDefinition types", () => {
  it("parses a valid YAML file into TeamDefinition", () => {
    const filePath = resolve(__dirname, "../test/fixtures/valid-team.yaml");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw) as TeamDefinition;

    expect(parsed.name).toBe("refactoring");
    expect(parsed.description).toBe("负责大型代码重构任务");

    // defaults
    expect(parsed.defaults).toBeDefined();
    expect(parsed.defaults!.model).toBe("anthropic/claude-sonnet-4");

    // members
    expect(parsed.members).toHaveLength(3);

    const analyzer = parsed.members[0];
    expect(analyzer.name).toBe("analyzer");
    expect(analyzer.label).toBe("代码分析员");
    expect(analyzer.systemPrompt).toContain("代码分析专家");
    expect(analyzer.model).toBeUndefined();

    const mover = parsed.members[1];
    expect(mover.name).toBe("mover");
    expect(mover.label).toBe("代码迁移员");
    expect(mover.model).toBe("anthropic/claude-sonnet-4");

    const verifier = parsed.members[2];
    expect(verifier.name).toBe("verifier");
    expect(verifier.label).toBe("验证员");
  });

  it("parses a minimal team definition", () => {
    const raw = `
name: "minimal"
description: "A minimal team"
members:
  - name: "worker"
    systemPrompt: "Do work"
`.trim();
    const parsed = parseYaml(raw) as TeamDefinition;

    expect(parsed.name).toBe("minimal");
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0].name).toBe("worker");
    expect(parsed.members[0].label).toBeUndefined();
    expect(parsed.defaults).toBeUndefined();
  });
});
