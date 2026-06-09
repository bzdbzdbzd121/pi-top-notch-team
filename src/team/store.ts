import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TeamDefinition } from "./definition";
import { validateTeamDefinition } from "./schema";

const TEAMS_DIR = "teams";

/** Get the teams directory path under a given root. */
export function getTeamsDir(rootDir: string): string {
  return join(rootDir, TEAMS_DIR);
}

/** Write a team definition to a YAML file. Creates the directory if needed. */
export function writeTeam(team: TeamDefinition, rootDir: string): void {
  const dir = getTeamsDir(rootDir);
  const filePath = join(dir, `${team.name}.yaml`);

  // Ensure the directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const yaml = stringifyYaml(team, { lineWidth: 120 });
  writeFileSync(filePath, yaml, "utf-8");
}

/** Read a team definition from a YAML file. Returns null if not found or invalid. */
export function readTeam(name: string, rootDir: string): TeamDefinition | null {
  const filePath = join(getTeamsDir(rootDir), `${name}.yaml`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = parseYaml(raw);
    const validation = validateTeamDefinition(data);

    if (!validation.valid) {
      console.warn(`Invalid team definition in ${filePath}:\n${validation.errors.join("\n")}`);
      return null;
    }

    return data as TeamDefinition;
  } catch (err) {
    console.warn(`Failed to read team "${name}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** List all team names (without .yaml extension). Returns empty array if no teams directory. */
export function listTeams(rootDir: string): string[] {
  const dir = getTeamsDir(rootDir);

  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((file) => extname(file) === ".yaml")
    .map((file) => basename(file, ".yaml"));
}

/** Delete a team definition file. Returns true if deleted, false if not found. */
export function deleteTeam(name: string, rootDir: string): boolean {
  const filePath = join(getTeamsDir(rootDir), `${name}.yaml`);

  if (!existsSync(filePath)) {
    return false;
  }

  unlinkSync(filePath);
  return true;
}

/** Delete session data directory for a team. Returns true if deleted, false if nothing to delete. */
export function deleteTeamSessions(name: string, rootDir: string): boolean {
  const sessionDir = join(rootDir, "sessions", name);
  if (!existsSync(sessionDir)) {
    return false;
  }
  rmSync(sessionDir, { recursive: true, force: true });
  return true;
}
