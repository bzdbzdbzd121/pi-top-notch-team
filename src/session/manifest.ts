import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getRootDir } from "../config";
import { getSessionState } from "./state";
import type { SessionOrigin } from "./state";
import type { TeamMember } from "../team/definition";

/**
 * Team session manifest (`session.json`) — the on-disk anchor for /team resume.
 *
 * Every active team session persists a manifest under
 * `<rootDir>/sessions/<team-name>/<sessionId>/session.json` capturing
 * everything needed to rehydrate a session after the TL process exits or the
 * pi session is switched away: the full member roster (the ONLY copy for
 * dynamic teams), origin, dynamic phase, shared-context gate flag, goal, and
 * the PIDs of started member processes (for orphan cleanup on resume).
 *
 * Status semantics:
 *   - "active"  — written at session start and on every mutation. If found on
 *                 disk at pi startup it means the previous session ended
 *                 without a clean stop (crash / kill / /new / /resume) and is
 *                 resumable.
 *   - "stopped" — written by teardownTeamSession on a clean /team stop. The
 *                 session dir is intentionally KEPT (member contexts remain
 *                 resumable); disk cleanup is explicit via /team delete.
 *
 * All writes are best-effort (fail-open): a manifest write failure must never
 * break the session itself.
 */

export interface ManifestGoal {
  text: string;
  criteria: string;
}

export interface TeamSessionManifest {
  version: 1;
  teamName: string;
  sessionId: string;
  origin: SessionOrigin;
  isDynamic: boolean;
  dynamicPhase: "design" | "execution";
  status: "active" | "stopped";
  startedAt: number;
  lastActiveAt: number;
  /** Working directory of the TL process that created this session. pi scopes
   *  sessions per project (cwd); /team resume does the same — only sessions
   *  from the current cwd are listed by default (--all shows everything).
   *  Absent in manifests written before this field existed. */
  cwd?: string;
  sharedContextWritten: boolean;
  goal: ManifestGoal | null;
  agentInitiatedTask: string | null;
  members: TeamMember[];
  /** Members that are currently started (restart these on resume). */
  startedMembers: string[];
  /** Last known member process PIDs (orphan detection on resume). */
  memberPids: Record<string, number>;
}

// ── Runtime context (not derivable from TeamSessionState) ──
// isDynamic / dynamicPhase / agentInitiatedTask live in TeamContext (index.ts
// scope), so the sync points feed them in here. Set at session start and on
// every transition; reset on teardown.
interface ManifestRuntimeContext {
  isDynamic: boolean;
  dynamicPhase: "design" | "execution";
  agentInitiatedTask: string | null;
}

let runtimeCtx: ManifestRuntimeContext = {
  isDynamic: false,
  dynamicPhase: "design",
  agentInitiatedTask: null,
};

export function setManifestRuntimeContext(patch: Partial<ManifestRuntimeContext>): void {
  runtimeCtx = { ...runtimeCtx, ...patch };
}

/** Reset runtime context to defaults (called on session teardown). */
export function resetManifestRuntimeContext(): void {
  runtimeCtx = { isDynamic: false, dynamicPhase: "design", agentInitiatedTask: null };
}

// ── Paths ──────────────────────────────────────────────────

export function getManifestPath(rootDir: string, teamName: string, sessionId: string): string {
  return join(rootDir, "sessions", teamName, sessionId, "session.json");
}

// ── Read / write primitives ────────────────────────────────

export function readManifestFile(path: string): TeamSessionManifest | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    if (typeof parsed.teamName !== "string" || typeof parsed.sessionId !== "string") return null;
    return parsed as TeamSessionManifest;
  } catch {
    return null;
  }
}

function writeManifestFile(path: string, manifest: TeamSessionManifest): void {
  mkdirSync(join(path, ".."), { recursive: true });
  // Atomic-ish: write to temp file then rename so a crash mid-write cannot
  // leave a truncated manifest that readManifestFile would reject anyway.
  const tmp = `${path}.tmp-${process.pid}`;
  const body = JSON.stringify(manifest, null, 2);
  writeFileSync(tmp, body, "utf-8");
  try {
    renameSync(tmp, path); // atomic on POSIX
  } catch {
    writeFileSync(path, body, "utf-8");
  }
}

// ── Listing (for /team resume picker) ──────────────────────

export interface ManifestEntry {
  path: string;
  manifest: TeamSessionManifest;
}

/**
 * Scan `<rootDir>/sessions/<team>/<sessionId>/session.json` for all teams
 * (including `_dynamic_*`). Sorted by lastActiveAt descending (most recent
 * first). Corrupt/unreadable manifests are skipped.
 */
export function listSessionManifests(rootDir: string, options?: { cwd?: string }): ManifestEntry[] {
  const sessionsRoot = join(rootDir, "sessions");
  let out: ManifestEntry[] = [];
  let teamDirs: string[];
  try {
    teamDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const teamName of teamDirs) {
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(join(sessionsRoot, teamName), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      const path = getManifestPath(rootDir, teamName, sessionId);
      const manifest = readManifestFile(path);
      if (manifest) out.push({ path, manifest });
    }
  }
  out.sort((a, b) => b.manifest.lastActiveAt - a.manifest.lastActiveAt);
  // Project scoping (mirrors pi --resume): when a cwd filter is given, only
  // sessions created in that directory are returned. Manifests without a cwd
  // (written before this field existed) are excluded from filtered results.
  if (options?.cwd) {
    out = out.filter((e) => e.manifest.cwd === options.cwd);
  }
  return out;
}

// ── Sync (merge-write against current in-memory session) ───

export interface ManifestSyncPatch {
  status?: "active" | "stopped";
  /** Goal snapshot; null clears. Absent: keep existing on-disk value. */
  goal?: ManifestGoal | null;
  /** Mark a member as started (adds to startedMembers + records pid). */
  startedMember?: { name: string; pid: number | null };
  /** Mark a member as intentionally stopped (removes from startedMembers/pids). */
  stoppedMember?: string;
}

/**
 * Merge-write the manifest for the CURRENT active session. Reads team/session
 * identity from getSessionState(), dynamic flags from the runtime context, and
 * accumulates startedMembers/memberPids from the existing on-disk manifest.
 * No-op when no session is active; fail-open on fs errors.
 */
export function syncActiveManifest(patch: ManifestSyncPatch = {}, rootDir: string = getRootDir()): void {
  try {
    const session = getSessionState();
    if (!session.active || !session.teamDefinition || !session.sessionId) return;

    const team = session.teamDefinition;
    const path = getManifestPath(rootDir, team.name, session.sessionId);
    const existing = readManifestFile(path);

    const startedMembers = new Set(existing?.startedMembers ?? []);
    const memberPids: Record<string, number> = { ...(existing?.memberPids ?? {}) };

    if (patch.startedMember) {
      startedMembers.add(patch.startedMember.name);
      if (patch.startedMember.pid != null) {
        memberPids[patch.startedMember.name] = patch.startedMember.pid;
      }
    }
    if (patch.stoppedMember) {
      startedMembers.delete(patch.stoppedMember);
      delete memberPids[patch.stoppedMember];
    }

    const manifest: TeamSessionManifest = {
      version: 1,
      teamName: team.name,
      sessionId: session.sessionId,
      origin: existing?.origin ?? session.origin,
      isDynamic: runtimeCtx.isDynamic,
      dynamicPhase: runtimeCtx.dynamicPhase,
      status: patch.status ?? existing?.status ?? "active",
      startedAt: existing?.startedAt ?? session.startedAt ?? Date.now(),
      lastActiveAt: Date.now(),
      cwd: process.cwd(),
      sharedContextWritten: session.sharedContextWritten,
      goal: patch.goal !== undefined ? patch.goal : existing?.goal ?? null,
      agentInitiatedTask: runtimeCtx.agentInitiatedTask,
      members: team.members,
      startedMembers: [...startedMembers],
      memberPids,
    };

    writeManifestFile(path, manifest);
  } catch {
    // Fail-open: manifest persistence must never break the session.
  }
}

/**
 * Mark a session's manifest as cleanly stopped. Called by teardown — the
 * session directory (member contexts included) is intentionally preserved so
 * the session stays resumable.
 */
export function markManifestStopped(
  teamName: string,
  sessionId: string,
  rootDir: string = getRootDir()
): void {
  try {
    const path = getManifestPath(rootDir, teamName, sessionId);
    const existing = readManifestFile(path);
    if (!existing) return;
    existing.status = "stopped";
    existing.lastActiveAt = Date.now();
    // Processes are stopped by teardown — no live PIDs remain.
    existing.memberPids = {};
    existing.startedMembers = existing.startedMembers ?? [];
    writeManifestFile(path, existing);
  } catch {
    // Fail-open
  }
}

