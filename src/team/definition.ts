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
}
