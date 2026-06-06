import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root directory for all top-notch-team data.
 * Override via TOP_NOTCH_TEAM_ROOT environment variable (for testing).
 */
export function getRootDir(): string {
  return process.env.TOP_NOTCH_TEAM_ROOT ?? join(homedir(), ".pi", "top-notch-team");
}
