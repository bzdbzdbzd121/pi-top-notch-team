import { describe, it, expect } from "vitest";
import { resolveMemberModel, splitModelRef } from "./resolve-model";
import type { TeamDefinition, TeamMember } from "../team/definition";
import type { TeamSettings } from "./settings";

const FOLLOW: TeamSettings = { memberModel: { mode: "follow" } };
const FIXED: TeamSettings = {
  memberModel: { mode: "fixed", model: "openai/gpt-5" },
};

function member(model?: string): TeamMember {
  return { name: "coder", systemPrompt: "…", model };
}

function team(defaultModel?: string): TeamDefinition {
  return {
    name: "t",
    description: "d",
    defaults: defaultModel ? { model: defaultModel } : undefined,
    members: [member()],
  };
}

describe("resolveMemberModel precedence", () => {
  it("member override wins over everything", () => {
    const r = resolveMemberModel(member("google/gemini-3-pro"), team("anthropic/claude-sonnet-4-5"), FIXED, "openai/gpt-5.1");
    expect(r).toEqual({ model: "google/gemini-3-pro", source: "member" });
  });

  it("team defaults.model wins over global settings", () => {
    const r = resolveMemberModel(member(), team("anthropic/claude-sonnet-4-5"), FIXED, "openai/gpt-5.1");
    expect(r).toEqual({ model: "anthropic/claude-sonnet-4-5", source: "team-default" });
  });

  it("global fixed setting applies when no team-level config", () => {
    const r = resolveMemberModel(member(), team(), FIXED, "openai/gpt-5.1");
    expect(r).toEqual({ model: "openai/gpt-5", source: "global-fixed" });
  });

  it("global follow uses the TL current model", () => {
    const r = resolveMemberModel(member(), team(), FOLLOW, "openai/gpt-5.1");
    expect(r).toEqual({ model: "openai/gpt-5.1", source: "global-follow" });
  });

  it("follow mode without a TL current model → no override", () => {
    const r = resolveMemberModel(member(), team(), FOLLOW, undefined);
    expect(r).toEqual({ source: "none" });
  });

  it("fixed mode without a model → falls through to follow/none", () => {
    const broken: TeamSettings = { memberModel: { mode: "fixed" } };
    expect(resolveMemberModel(member(), team(), broken, "openai/gpt-5.1"))
      .toEqual({ model: "openai/gpt-5.1", source: "global-follow" });
    expect(resolveMemberModel(member(), team(), broken, undefined))
      .toEqual({ source: "none" });
  });
});

describe("splitModelRef", () => {
  it("splits provider/modelId on the first slash", () => {
    expect(splitModelRef("anthropic/claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("keeps slashes inside the model id (e.g. openrouter)", () => {
    expect(splitModelRef("openrouter/anthropic/claude-sonnet-4")).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
  });

  it("rejects malformed refs", () => {
    expect(splitModelRef("noslash")).toBeNull();
    expect(splitModelRef("/no-provider")).toBeNull();
    expect(splitModelRef("no-id/")).toBeNull();
    expect(splitModelRef("")).toBeNull();
  });
});
