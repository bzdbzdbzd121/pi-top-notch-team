import type { TeamDefinition, TeamMember } from "../team/definition";
import type { TeamSettings } from "./settings";

/** Where the effective member model came from. */
export type MemberModelSource =
  | "member"        // per-member override in team YAML
  | "team-default"  // team YAML defaults.model
  | "global-fixed"  // /team setting: fixed model
  | "global-follow" // /team setting: follow TL current model
  | "none";         // no override — member pi uses its own default

export interface ResolvedMemberModel {
  /** "provider/modelId", or undefined when no override applies. */
  model?: string;
  source: MemberModelSource;
}

/**
 * Resolve the effective model for a team member.
 *
 * Precedence (highest first):
 *   1. member.model            (team YAML, per-member override)
 *   2. team.defaults.model     (team YAML, team-wide default)
 *   3. global fixed setting    (/team setting → 指定模型)
 *   4. global follow setting   (/team setting → 跟随当前配置 → TL's current model)
 *   5. no override             (member pi process uses its own default)
 */
export function resolveMemberModel(
  memberDef: TeamMember,
  teamDef: TeamDefinition,
  settings: TeamSettings,
  tlCurrentModel?: string
): ResolvedMemberModel {
  if (memberDef.model) {
    return { model: memberDef.model, source: "member" };
  }
  if (teamDef.defaults?.model) {
    return { model: teamDef.defaults.model, source: "team-default" };
  }
  if (settings.memberModel.mode === "fixed" && settings.memberModel.model) {
    return { model: settings.memberModel.model, source: "global-fixed" };
  }
  if (tlCurrentModel) {
    return { model: tlCurrentModel, source: "global-follow" };
  }
  return { source: "none" };
}

/** Split "provider/modelId" on the FIRST slash (model IDs may contain slashes). */
export function splitModelRef(modelRef: string): { provider: string; modelId: string } | null {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    return null;
  }
  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}
