import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { TeamDefinition, TeamMember, TeamDefaults, WorkflowStage, WorkflowLoop, TeamWorkflow } from "./definition";

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

  it("parses a team definition with workflow", () => {
    const raw = [
      "name: \"dev-team\"",
      "description: \"Standard dev team with workflow\"",
      "defaults:",
      "  model: \"anthropic/claude-sonnet-4\"",
      "members:",
      "  - name: \"architect\"",
      "    label: \"架构师\"",
      "    systemPrompt: \"You are an architect.\"",
      "  - name: \"coder\"",
      "    label: \"编码员\"",
      "    systemPrompt: \"You are a coder.\"",
      "  - name: \"reviewer\"",
      "    label: \"审查员\"",
      "    systemPrompt: \"You are a reviewer.\"",
      "workflow:",
      "  strictness: \"reference\"",
      "  description: \"Standard dev workflow\"",
      "  stages:",
      "    - member: \"architect\"",
      "      name: \"analyze\"",
      "      description: \"Analyze requirements and design\"",
      "      output: \"Design document\"",
      "    - member: \"coder\"",
      "      name: \"implement\"",
      "      description: \"Implement code based on design\"",
      "      input: \"Architect's design\"",
      "      onFailure:",
      "        returnToStage: \"analyze\"",
      "        condition: \"design not approved\"",
      "    - member: \"reviewer\"",
      "      name: \"review\"",
      "      description: \"Review code implementation\"",
      "  loops:",
      "    - condition: \"Review failed, need rework\"",
      "      stages:",
      "        - \"implement\"",
      "        - \"review\"",
    ].join("\n");
    const parsed = parseYaml(raw) as TeamDefinition;

    expect(parsed.name).toBe("dev-team");
    expect(parsed.workflow).toBeDefined();
    expect(parsed.workflow!.strictness).toBe("reference");
    expect(parsed.workflow!.description).toBe("Standard dev workflow");
    expect(parsed.workflow!.stages).toHaveLength(3);

    const stage1 = parsed.workflow!.stages[0];
    expect(stage1.member).toBe("architect");
    expect(stage1.name).toBe("analyze");
    expect(stage1.description).toBe("Analyze requirements and design");
    expect(stage1.output).toBe("Design document");
    expect(stage1.input).toBeUndefined();
    expect(stage1.onFailure).toBeUndefined();

    const stage2 = parsed.workflow!.stages[1];
    expect(stage2.member).toBe("coder");
    expect(stage2.name).toBe("implement");
    expect(stage2.input).toBe("Architect's design");
    expect(stage2.onFailure).toBeDefined();
    expect(stage2.onFailure!.returnToStage).toBe("analyze");
    expect(stage2.onFailure!.condition).toBe("design not approved");

    expect(parsed.workflow!.loops).toHaveLength(1);
    const loop = parsed.workflow!.loops![0];
    expect(loop.condition).toBe("Review failed, need rework");
    expect(loop.stages).toEqual(["implement", "review"]);
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
