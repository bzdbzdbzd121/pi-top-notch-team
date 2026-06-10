import type { TeamDefinition } from "./definition";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const MEMBER_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const VALID_STRICTNESS = new Set(["strict", "reference"]);

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
  const memberNames: string[] = [];
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
        memberNames.push(member.name);
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

  // workflow (optional)
  if (def.workflow !== undefined) {
    validateWorkflow(def.workflow, memberNames, errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a workflow object.
 * Appends error messages to the `errors` array.
 */
export function validateWorkflow(
  workflow: unknown,
  memberNames: string[],
  errors: string[]
): void {
  if (workflow === null || workflow === undefined || typeof workflow !== "object") {
    errors.push("workflow must be an object");
    return;
  }

  const wf = workflow as Record<string, unknown>;

  // strictness
  if (wf.strictness !== undefined && !VALID_STRICTNESS.has(wf.strictness as string)) {
    errors.push(`workflow.strictness "${String(wf.strictness)}": must be "strict" or "reference"`);
  }

  // stages
  if (!Array.isArray(wf.stages)) {
    errors.push("workflow.stages must be an array");
    return; // can't validate further without stages
  }

  if (wf.stages.length === 0) {
    errors.push("workflow.stages must not be empty");
  }

  // Collect all main flow stage names for cross-referencing
  const mainStageNames = new Set<string>();

  for (let i = 0; i < wf.stages.length; i++) {
    const stage = wf.stages[i] as Record<string, unknown> | undefined;

    if (!stage || typeof stage !== "object") {
      errors.push(`workflow.stages[${i}]: must be an object`);
      continue;
    }

    // stage.member
    if (!stage.member || typeof stage.member !== "string") {
      errors.push(`workflow.stages[${i}]: member is required and must be a string`);
    } else if (stage.member !== "tl" && memberNames.length > 0 && !memberNames.includes(stage.member)) {
      errors.push(`workflow.stages[${i}].member "${stage.member}": does not match any team member name (use a member name or "tl")`);
    }

    // stage.name
    if (!stage.name || typeof stage.name !== "string") {
      errors.push(`workflow.stages[${i}]: name is required and must be a string`);
    } else if (mainStageNames.has(stage.name)) {
      errors.push(`workflow.stages[${i}].name "${stage.name}": duplicate stage name in main flow`);
    } else {
      mainStageNames.add(stage.name);
    }

    // stage.description
    if (!stage.description || typeof stage.description !== "string" || stage.description.trim() === "") {
      errors.push(`workflow.stages[${i}] "${String(stage.name ?? "?")}": description is required and must be a non-empty string`);
    }

    // stage.input (optional string)
    if (stage.input !== undefined && typeof stage.input !== "string") {
      errors.push(`workflow.stages[${i}] "${String(stage.name ?? "?")}": input must be a string`);
    }

    // stage.output (optional string)
    if (stage.output !== undefined && typeof stage.output !== "string") {
      errors.push(`workflow.stages[${i}] "${String(stage.name ?? "?")}": output must be a string`);
    }

    // stage.constraints (optional string)
    if (stage.constraints !== undefined && typeof stage.constraints !== "string") {
      errors.push(`workflow.stages[${i}] "${String(stage.name ?? "?")}": constraints must be a string`);
    }

    // stage.onFailure (optional object)
    if (stage.onFailure !== undefined) {
      validateOnFailure(stage.onFailure, `workflow.stages[${i}]`, mainStageNames, errors);
    }
  }

  // loops (optional)
  if (wf.loops !== undefined) {
    if (!Array.isArray(wf.loops)) {
      errors.push("workflow.loops must be an array");
    } else {
      for (let i = 0; i < wf.loops.length; i++) {
        const loop = wf.loops[i] as Record<string, unknown> | undefined;

        if (!loop || typeof loop !== "object") {
          errors.push(`workflow.loops[${i}]: must be an object`);
          continue;
        }

        // loop.condition
        if (!loop.condition || typeof loop.condition !== "string" || loop.condition.trim() === "") {
          errors.push(`workflow.loops[${i}]: condition is required and must be a non-empty string`);
        }

        // loop.stages
        if (!Array.isArray(loop.stages)) {
          errors.push(`workflow.loops[${i}]: stages must be an array`);
        } else if (loop.stages.length === 0) {
          errors.push(`workflow.loops[${i}]: stages must not be empty`);
        } else {
          for (let j = 0; j < loop.stages.length; j++) {
            const ref = loop.stages[j];
            if (typeof ref !== "string") {
              errors.push(`workflow.loops[${i}].stages[${j}]: must be a string (stage name reference)`);
            } else if (!mainStageNames.has(ref)) {
              errors.push(`workflow.loops[${i}].stages[${j}] "${ref}": does not match any main flow stage name`);
            }
          }
        }
      }
    }
  }
}

/**
 * Validate an onFailure object.
 */
function validateOnFailure(
  onFailure: unknown,
  prefix: string,
  mainStageNames: Set<string>,
  errors: string[]
): void {
  if (typeof onFailure !== "object" || onFailure === null) {
    errors.push(`${prefix}.onFailure must be an object with returnToStage and condition fields`);
    return;
  }

  const of = onFailure as Record<string, unknown>;

  if (typeof of.returnToStage !== "string") {
    errors.push(`${prefix}.onFailure.returnToStage must be a string`);
  } else if (mainStageNames.size > 0 && !mainStageNames.has(of.returnToStage)) {
    errors.push(`${prefix}.onFailure.returnToStage "${of.returnToStage}": does not match any main flow stage name`);
  }

  if (!of.condition || typeof of.condition !== "string" || of.condition.trim() === "") {
    errors.push(`${prefix}.onFailure.condition must be a non-empty string`);
  }
}
