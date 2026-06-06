import type { TeamDefinition } from "./definition";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const MEMBER_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Validate a parsed YAML object as a TeamDefinition.
 * Returns { valid: true, errors: [] } if valid, or { valid: false, errors: [...] } if not.
 */
export function validateTeamDefinition(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (data === null || data === undefined || typeof data !== "object") {
    return { valid: false, errors: ["Team definition must be an object"] };
  }

  const def = data as Record<string, unknown>;

  // name
  if (!def.name || typeof def.name !== "string" || def.name.trim() === "") {
    errors.push("Team name is required and must be a non-empty string");
  }

  // description
  if (!def.description || typeof def.description !== "string" || def.description.trim() === "") {
    errors.push("Team description is required and must be a non-empty string");
  }

  // members
  if (!Array.isArray(def.members)) {
    errors.push("Team members must be an array");
  } else if (def.members.length === 0) {
    errors.push("Team must have at least one member");
  } else {
    const seenNames = new Set<string>();

    for (let i = 0; i < def.members.length; i++) {
      const member = def.members[i] as Record<string, unknown> | undefined;

      if (!member || typeof member !== "object") {
        errors.push(`members[${i}]: must be an object`);
        continue;
      }

      // member.name
      if (!member.name || typeof member.name !== "string") {
        errors.push(`members[${i}]: name is required and must be a string`);
      } else {
        if (!MEMBER_NAME_RE.test(member.name)) {
          errors.push(
            `members[${i}].name "${member.name}": must start with a letter, and contain only lowercase letters, numbers, hyphens, and underscores`
          );
        }
        if (seenNames.has(member.name)) {
          errors.push(`members[${i}].name "${member.name}": duplicate member name`);
        }
        seenNames.add(member.name);
      }

      // member.systemPrompt
      if (!member.systemPrompt || typeof member.systemPrompt !== "string") {
        errors.push(`members[${i}] "${member.name ?? "?"}": systemPrompt is required and must be a string`);
      }

      // member.model (optional, but if present must be string)
      if (member.model !== undefined && typeof member.model !== "string") {
        errors.push(`members[${i}] "${member.name ?? "?"}": model must be a string`);
      }
    }
  }

  // defaults (optional)
  if (def.defaults !== undefined) {
    if (typeof def.defaults !== "object" || def.defaults === null) {
      errors.push("defaults must be an object");
    } else {
      const defaults = def.defaults as Record<string, unknown>;
      if (defaults.model !== undefined && typeof defaults.model !== "string") {
        errors.push("defaults.model must be a string");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
