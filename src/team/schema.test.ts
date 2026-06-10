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

  // --- Workflow validation tests ---

  describe("workflow validation", () => {
    const baseMembers = [
      { name: "architect", systemPrompt: "do" },
      { name: "coder", systemPrompt: "do" },
      { name: "reviewer", systemPrompt: "do" },
    ];

    function validDef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const base = {
        name: "test",
        description: "test",
        members: baseMembers,
        workflow: {
          strictness: "reference" as const,
          stages: [
            { member: "architect", name: "analyze", description: "Analyze" },
            { member: "coder", name: "implement", description: "Implement" },
          ],
        },
      };
      if (!overrides.workflow) return { ...base, ...overrides };
      const merged = { ...base, ...overrides };
      merged.workflow = { ...base.workflow, ...(overrides.workflow as Record<string, unknown>) };
      return merged;
    }

    it("validates a standard workflow", () => {
      const result = validateTeamDefinition(validDef());
      expect(result.valid).toBe(true);
    });

    it("validates strict mode workflow", () => {
      const result = validateTeamDefinition(
        validDef({ workflow: { strictness: "strict", stages: [{ member: "architect", name: "a", description: "b" }] } })
      );
      expect(result.valid).toBe(true);
    });

    it("accepts team without workflow (backward compat)", () => {
      const result = validateTeamDefinition({
        name: "test",
        description: "test",
        members: baseMembers,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects workflow with invalid strictness", () => {
      const result = validateTeamDefinition(
        validDef({ workflow: { strictness: "forbidden" as any, stages: [{ member: "architect", name: "a", description: "b" }] } })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("strictness") && e.includes("strict"))).toBe(true);
    });

    it("rejects workflow with empty stages", () => {
      const result = validateTeamDefinition(validDef({ workflow: { stages: [] as any[] } }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("stages") && e.includes("empty"))).toBe(true);
    });

    it("rejects stage with non-existent member", () => {
      const result = validateTeamDefinition(
        validDef({ workflow: { stages: [{ member: "ghost", name: "s1", description: "task" }] } })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("ghost"))).toBe(true);
    });

    it("rejects duplicate stage names in main flow", () => {
      const result = validateTeamDefinition(
        validDef({
          workflow: {
            stages: [
              { member: "architect", name: "analyze", description: "First" },
              { member: "coder", name: "analyze", description: "Duplicate" },
            ],
          },
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("duplicate") || e.includes("unique"))).toBe(true);
    });

    it("rejects stage with empty description", () => {
      const result = validateTeamDefinition(
        validDef({ workflow: { stages: [{ member: "architect", name: "s1", description: "" }] } })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("description"))).toBe(true);
    });

    it("rejects workflow with non-object onFailure string", () => {
      const result = validateTeamDefinition(
        validDef({
          workflow: {
            stages: [{ member: "architect", name: "s1", description: "task", onFailure: "stop" }],
          },
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("onFailure"))).toBe(true);
    });

    it("accepts workflow with valid onFailure object", () => {
      const result = validateTeamDefinition(
        validDef({
          workflow: {
            stages: [
              { member: "architect", name: "s1", description: "task", onFailure: { returnToStage: "s1", condition: "failed" } },
            ],
          },
        })
      );
      expect(result.valid).toBe(true);
    });

    it("rejects onFailure with empty condition", () => {
      const result = validateTeamDefinition(
        validDef({
          workflow: {
            stages: [
              { member: "architect", name: "s1", description: "task", onFailure: { returnToStage: "s1", condition: "" } },
            ],
          },
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("condition"))).toBe(true);
    });

  it("rejects onFailure with returnToStage referencing non-existent stage name", () => {
    const result = validateTeamDefinition({
      name: "test",
      description: "test",
      members: [{ name: "architect", systemPrompt: "architect" }],
      workflow: {
        strictness: "reference",
        stages: [
          { member: "architect", name: "s1", description: "task", onFailure: { returnToStage: "ghost", condition: "failed" } },
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("does not match any main flow stage name");
  });

    describe("loops validation"
, () => {
      const loopDef = {
        stages: [
          { member: "architect", name: "analyze", description: "Analyze" },
          { member: "coder", name: "implement", description: "Implement" },
          { member: "reviewer", name: "review", description: "Review" },
        ],
      };

      it("validates workflow with loops", () => {
        const result = validateTeamDefinition(
          validDef({
            workflow: {
              ...loopDef,
              loops: [{ condition: "Review failed", stages: ["implement", "review"] }],
            },
          })
        );
        expect(result.valid).toBe(true);
      });

      it("rejects loop with empty condition", () => {
        const result = validateTeamDefinition(
          validDef({
            workflow: {
              ...loopDef,
              loops: [{ condition: "", stages: ["analyze"] }],
            },
          })
        );
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("condition"))).toBe(true);
      });

      it("rejects loop with stages array referencing non-existent stage name", () => {
        const result = validateTeamDefinition(
          validDef({
            workflow: {
              ...loopDef,
              loops: [{ condition: "loop", stages: ["nobody"] }],
            },
          })
        );
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("nobody"))).toBe(true);
      });

      it("rejects loop with empty stages array", () => {
        const result = validateTeamDefinition(
          validDef({
            workflow: {
              ...loopDef,
              loops: [{ condition: "loop", stages: [] }],
            },
          })
        );
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("stages") && e.includes("empty"))).toBe(true);
      });

      it("rejects loop with stages as non-array", () => {
        const result = validateTeamDefinition(
          validDef({
            workflow: {
              ...loopDef,
              loops: [{ condition: "loop", stages: "analyze" as any }],
            },
          })
        );
        expect(result.valid).toBe(false);
      });
    });

    it("validates workflow with optional fields (input, output, constraints)", () => {
      const result = validateTeamDefinition(
        validDef({
          workflow: {
            stages: [
              {
                member: "architect",
                name: "analyze",
                description: "Analyze requirements",
                input: "Requirements doc",
                output: "Design doc",
                constraints: "Must use approved patterns",
              },
            ],
          },
        })
      );
      expect(result.valid).toBe(true);
    });

    it("rejects workflow where workflow is not an object", () => {
      const result = validateTeamDefinition({
        name: "test",
        description: "test",
        members: baseMembers,
        workflow: "not-an-object",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("workflow") && e.includes("object"))).toBe(true);
    });
  });
});

  it("accepts workflow stage with member \"tl\"", () => {
    const result = validateTeamDefinition({
      name: "test",
      description: "test",
      members: [{ name: "coder", systemPrompt: "write code" }],
      workflow: {
        strictness: "reference",
        stages: [
          { member: "tl", name: "plan", description: "plan the work" },
          { member: "coder", name: "code", description: "write the code" },
        ],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });


