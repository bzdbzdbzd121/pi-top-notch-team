import { readFileSync, writeFileSync, existsSync, unlinkSync, rmSync, readdirSync, mkdirSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
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

  // Defensive validation before writing
  const validation = validateTeamDefinition(team as any);
  if (!validation.valid) {
    console.warn(
      `[top-notch-team] writeTeam validation failed for "${team.name}":\n${validation.errors.join("\n")}`
    );
    // Still write to avoid data loss for the caller
  }

  // Ensure the directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const yaml = stringifyYaml(team, { lineWidth: 120 });
  writeFileAtomic(filePath, yaml);
}

/**
 * Write with same-directory temp file + atomic rename (POSIX rename semantics).
 *
 * Why: a direct overwrite can expose a half-written YAML to a concurrent
 * reader (sync staging, another pi instance, `/team list`). A crash or a failed
 * rename must leave the previous file untouched — the temp name never matches
 * `*.yaml` (so it is never listed as a team) and is removed when the rename
 * fails. Residual `.tmp-<pid>` files from a hard kill are ignored by listTeams
 * and cleaned by the sync recovery path.
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    syncFileBestEffort(tmpPath); // 掉电时不留下空的团队 YAML（尽力而为）
    renameSync(tmpPath, filePath); // atomic on POSIX
  } catch (err) {
    // 任一步失败都清理临时文件（部分写入/替换失败），旧文件保持不变
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 临时文件可能尚未创建；保留原始错误 */
    }
    throw err;
  }
}

/** 尽力而为地把文件数据刷到磁盘（fsync 失败不改变写入语义，只影响掉电持久性）。 */
function syncFileBestEffort(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    /* best-effort */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
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
