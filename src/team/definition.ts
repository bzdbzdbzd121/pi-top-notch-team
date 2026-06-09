/** A single member role in a team definition. */
export interface TeamMember {
  /** Unique identifier within the team (used as CLI argument). */
  name: string;
  /** Human-readable role label (defaults to name). */
  label?: string;
  /** System prompt defining this member's role and behavior. */
  systemPrompt: string;
  /** Override the default model for this member. */
  model?: string;
}

/** Default values applied to all members (unless overridden per-member). */
export interface TeamDefaults {
  /** Default model for all members. */
  model?: string;
}

/** A single step in a workflow. */
export interface WorkflowStage {
  /** Member name (must match TeamMember.name). */
  member: string;
  /** Stage identifier, unique within the workflow. */
  name: string;
  /** What this stage does. */
  description: string;
  /** Expected input description (optional). */
  input?: string;
  /** Expected output description (optional). */
  output?: string;
  /** Additional constraints (optional). */
  constraints?: string;
  /** Failure handling strategy (optional object). */
  onFailure?: { returnToStage: string; condition: string };
}

/** A loop section in a workflow. */
export interface WorkflowLoop {
  /** Natural language condition to continue looping. */
  condition: string;
  /** References to main flow stage names to repeat. */
  stages: string[];
}

/** Default workflow definition for a team. */
export interface TeamWorkflow {
  /** Execution mode. */
  strictness: "strict" | "reference";
  /** Workflow purpose description (optional). */
  description?: string;
  /** Main flow stages. */
  stages: WorkflowStage[];
  /** Optional loop sections. */
  loops?: WorkflowLoop[];
}

/** A team definition as stored in YAML. */
export interface TeamDefinition {
  /** Team name (used as identifier in /team commands). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Defaults applied to each member. */
  defaults?: TeamDefaults;
  /** Member roles in this team (at least 1). */
  members: TeamMember[];
  /** Optional default workflow definition. */
  workflow?: TeamWorkflow;
}
