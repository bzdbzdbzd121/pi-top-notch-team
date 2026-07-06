import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock store/schema modules ──────────────────────────────

const mockReadTeam = vi.fn();
const mockWriteTeam = vi.fn();
const mockValidate = vi.fn();

vi.mock("../team/store", () => ({
  readTeam: (...args: any[]) => mockReadTeam(...args),
  writeTeam: (...args: any[]) => mockWriteTeam(...args),
}));

vi.mock("../team/schema", () => ({
  validateTeamDefinition: (...args: any[]) => mockValidate(...args),
}));

async function loadModule() {
  return await import("./save-team-definition");
}

describe("saveTeamDefinition — merge logic", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockValidate.mockReturnValue({ valid: true, errors: [] });
    mockWriteTeam.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should save a new team definition (isUpdate=false)", async () => {
    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "My test team",
        members: [
          { name: "analyzer", label: "分析员", systemPrompt: "你是一个分析专家" },
          { name: "worker", label: "编码员", systemPrompt: "你是一个编码专家" },
        ],
      },
      "/tmp/root",
      false
    );

    expect(result).toBeNull();
    expect(mockReadTeam).not.toHaveBeenCalled(); // No read for new team
    expect(mockValidate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "my-team",
        description: "My test team",
        members: expect.arrayContaining([
          expect.objectContaining({ name: "analyzer", systemPrompt: "你是一个分析专家" }),
          expect.objectContaining({ name: "worker", systemPrompt: "你是一个编码专家" }),
        ]),
      })
    );
    expect(mockWriteTeam).toHaveBeenCalled();
  });

  it("should fill in missing systemPrompt from existing team (update merge)", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing team",
      members: [
        { name: "analyzer", label: "分析员", systemPrompt: "你是一个分析专家" },
        { name: "reviewer", label: "审查员", systemPrompt: "你是一个审查专家" },
      ],
      defaults: { model: "gpt-4" },
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "Updated team",
        defaultModel: "claude-3",
        members: [
          { name: "analyzer" }, // no systemPrompt provided — should fill from existing
          { name: "reviewer", systemPrompt: "新的审查提示" }, // explicit override
        ],
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    // Read should have been called for update
    expect(mockReadTeam).toHaveBeenCalledWith("my-team", "/tmp/root");

    // Verify the written data
    const writtenData = mockWriteTeam.mock.calls[0][0];
    const analyzerMember = writtenData.members.find((m: any) => m.name === "analyzer");
    const reviewerMember = writtenData.members.find((m: any) => m.name === "reviewer");

    // analyzer has no systemPrompt in params — should be filled from existing
    expect(analyzerMember.systemPrompt).toBe("你是一个分析专家");
    // reviewer has explicit systemPrompt — should be used
    expect(reviewerMember.systemPrompt).toBe("新的审查提示");
    // defaults should use params.defaultModel (not existing)
    expect(writtenData.defaults).toEqual({ model: "claude-3" });
  });

  it("should preserve existing defaults when new defaults not provided", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing",
      members: [{ name: "analyzer", systemPrompt: "分析" }],
      defaults: { model: "gpt-4" },
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "Updated",
        // no defaultModel — should preserve from existing
        members: [{ name: "analyzer", systemPrompt: "新的分析" }],
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    expect(writtenData.defaults).toEqual({ model: "gpt-4" });
  });

  it("should preserve existing workflow when workflow not provided", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing",
      members: [{ name: "analyzer", systemPrompt: "分析" }],
      workflow: { strictness: "strict", stages: [{ member: "analyzer", name: "analyze", description: "分析代码" }] },
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "Updated",
        members: [{ name: "analyzer", systemPrompt: "分析" }],
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    expect(writtenData.workflow).toBeDefined();
    expect(writtenData.workflow.strictness).toBe("strict");
  });

  it("should use new workflow when provided in update", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing",
      members: [{ name: "analyzer", systemPrompt: "分析" }],
      workflow: { strictness: "strict", stages: [{ member: "analyzer", name: "analyze", description: "旧工作流" }] },
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "Updated",
        members: [{ name: "analyzer", systemPrompt: "分析" }],
        workflow: { strictness: "reference", stages: [{ member: "analyzer", name: "new-analyze", description: "新工作流" }] },
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    expect(writtenData.workflow.strictness).toBe("reference");
    expect(writtenData.workflow.stages[0].name).toBe("new-analyze");
  });

  it("should return validation error when data is invalid", async () => {
    mockValidate.mockReturnValue({
      valid: false,
      errors: ["名称不能为空", "至少需要一个成员"],
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "",
        description: "Bad",
        members: [],
      },
      "/tmp/root",
      false
    );

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain("校验失败");
    expect(result.content[0].text).toContain("名称不能为空");
    expect(mockWriteTeam).not.toHaveBeenCalled();
  });

  it("should handle delete of existing members (omitted from params)", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing",
      members: [
        { name: "analyzer", systemPrompt: "分析" },
        { name: "worker", systemPrompt: "编码" },
        { name: "reviewer", systemPrompt: "审查" },
      ],
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "Reduced team",
        members: [
          { name: "analyzer", systemPrompt: "分析" },
          // worker and reviewer omitted — effectively deleted
        ],
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    expect(writtenData.members).toHaveLength(1);
    expect(writtenData.members[0].name).toBe("analyzer");
  });

  it("should fill in missing label from existing team", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing",
      members: [
        { name: "analyzer", label: "分析员", systemPrompt: "分析" },
      ],
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "Updated",
        members: [
          { name: "analyzer" }, // no label, no systemPrompt
        ],
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    const analyzer = writtenData.members[0];
    expect(analyzer.label).toBe("分析员");
    expect(analyzer.systemPrompt).toBe("分析");
  });

  it("should preserve existing members when members not provided (workflow-only update)", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing team",
      members: [
        { name: "analyzer", label: "分析员", systemPrompt: "你是一个分析专家" },
        { name: "reviewer", label: "审查员", systemPrompt: "你是一个审查专家" },
      ],
      workflow: { strictness: "strict", stages: [{ member: "analyzer", name: "old-analyze", description: "旧工作流" }] },
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        // no description, no members — only workflow change
        workflow: { strictness: "reference", stages: [{ member: "analyzer", name: "new-analyze", description: "新工作流" }] },
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    // members preserved from existing
    expect(writtenData.members).toHaveLength(2);
    expect(writtenData.members[0].name).toBe("analyzer");
    expect(writtenData.members[1].name).toBe("reviewer");
    // description preserved from existing
    expect(writtenData.description).toBe("Existing team");
    // workflow updated
    expect(writtenData.workflow.strictness).toBe("reference");
    expect(writtenData.workflow.stages[0].name).toBe("new-analyze");
  });

  it("should preserve existing description when not provided in update", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Original description",
      members: [{ name: "analyzer", systemPrompt: "分析" }],
    });

    const { saveTeamDefinition } = await loadModule();
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        // no description provided — should preserve
        members: [{ name: "analyzer", systemPrompt: "新的分析" }],
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    expect(writtenData.description).toBe("Original description");
  });

  it("should fill in missing model and systemPrompt together from existing team", async () => {
    mockReadTeam.mockReturnValue({
      name: "my-team",
      description: "Existing",
      members: [
        { name: "analyzer", label: "分析员", systemPrompt: "分析", model: "gpt-4" },
      ],
    });

    const { saveTeamDefinition } = await loadModule();
    // When systemPrompt is omitted entirely, both systemPrompt and model should fill from existing
    const result = await saveTeamDefinition(
      {
        name: "my-team",
        description: "Updated",
        members: [
          { name: "analyzer" }, // no systemPrompt, no model — fill both from existing
        ],
      },
      "/tmp/root",
      true
    );

    expect(result).toBeNull();
    const writtenData = mockWriteTeam.mock.calls[0][0];
    expect(writtenData.members[0].systemPrompt).toBe("分析");
    expect(writtenData.members[0].model).toBe("gpt-4");
    expect(writtenData.members[0].label).toBe("分析员");
  });
});
