import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { getSessionState, renameTeamInSession } from "./state";
import { normalizeTeamName } from "../team/team-name";
import { listTeams } from "../team/store";
import { syncActiveManifest } from "./manifest";
import { rewriteStubIfUnchanged, type StubRewriteOutcome } from "./shared-context";
import type { TeamDefinition } from "../team/definition";

/**
 * Team rename transaction (set_team_name).
 *
 * Exactly one time window allows a rename: dynamic session + design phase +
 * no running member process. The member side freezes TEAM_NAME, the absolute
 * shared-context path and `--session-dir` at spawn time, so a rename after the
 * first start_member would leave old members self-identifying with the old name
 * — the window is not caused by moving the directory.
 *
 * Order (must not be reordered):
 *   1-7  validation (zero side effects)
 *   8-10 move the session directory (one atomic rename on the same fs)
 *   11   in-memory rename
 *   12   manifest write into the new directory — failure rolls 11+8-10 back
 *   13   post-success hook (rebind per-session settings dir + refresh widget)
 *   14   shared-context stub rewrite (only while it is still the system stub)
 *
 * The hook runs AFTER the directory move on purpose: it rebinds the settings
 * snapshot directory, and a snapshot write before the move would mkdirSync a
 * stray old-name directory that /team resume would then read instead.
 */

export type TeamNameRejection =
  | "inactive"
  | "not-dynamic"
  | "phase-execution"
  | "member-running"
  | "invalid"
  | "taken"
  | "io"
  | "partial";

export interface ApplyTeamNameDeps {
  rootDir: string;
  /** teamCtx.isDynamicSession (injected — this module never imports TeamContext). */
  isDynamic: boolean;
  /** teamCtx.dynamicPhase — renames are design-phase only. */
  dynamicPhase: "design" | "execution";
  /** Defensive depth: any member process still running blocks the rename. */
  hasRunningMember(): boolean;
  /** Post-success hook (index.ts: rebind per-session settings dir + refresh widget). Fail-open. */
  onRenamed?(newName: string): void;
  /** Failure injection (default renameSync). */
  moveDir?(from: string, to: string): void;
  /** Failure injection (default syncActiveManifest against `rootDir`). */
  syncManifest?(): boolean;
  /** Failure injection (default rewriteStubIfUnchanged). */
  rewriteSharedContextStub?(oldTeam: TeamDefinition, newTeam: TeamDefinition): StubRewriteOutcome;
}

export type TeamNameOutcome =
  | {
      ok: true;
      name: string;
      previousName: string;
      moved: boolean;
      adjusted: boolean;
      /** Absolute session directory after the rename (unchanged when moved=false). */
      dir: string;
      /** What happened to the system shared-context stub (reported honestly). */
      stubRewrite: StubRewriteOutcome;
    }
  | { ok: false; code: TeamNameRejection; message: string };

function reject(code: TeamNameRejection, message: string): TeamNameOutcome {
  return { ok: false, code, message };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort removal of an empty directory (a leftover parent confuses /team resume). */
function removeDirIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Not empty / already gone / no permission — leave it alone.
  }
}

export function applyTeamName(rawName: unknown, deps: ApplyTeamNameDeps): TeamNameOutcome {
  // ── Steps 1-4: window checks (synchronous, zero side effects) ──
  const session = getSessionState();
  if (!session.active || !session.teamDefinition || !session.sessionId) {
    return reject(
      "inactive",
      "当前无活跃团队会话，无法命名。请先启动团队会话（/team dynamic 或 start_team_session）。"
    );
  }
  if (!deps.isDynamic) {
    return reject(
      "not-dynamic",
      "当前是预定义团队会话，set_team_name 不可用。预定义团队请用 /team edit <名字> 修改团队定义。"
    );
  }
  if (deps.dynamicPhase !== "design") {
    return reject(
      "phase-execution",
      "本会话已进入执行阶段（成员已启动），团队名已冻结：成员的会话目录、共享上下文路径与 TEAM_NAME " +
        "在启动时已固化，改名会让同一会话里新旧名称混用。如需改名，请结束本会话后重开" +
        "（/team stop → /team dynamic 或 start_team_session），并在启动成员前命名。"
    );
  }
  if (deps.hasRunningMember()) {
    return reject(
      "member-running",
      "仍有成员进程在运行（start_member 正在启动），无法改名。名称会在第一个成员成功启动后冻结：" +
        "成员的 TEAM_NAME、会话目录与共享上下文路径在启动时已固化，之后即使停止成员也无法在同一会话内改名。" +
        "请等待该启动完成；如需改名，请结束本会话后重开（/team stop → /team dynamic 或 start_team_session），" +
        "并在启动成员前命名。"
    );
  }

  // ── Step 5: naming rules ──
  const normalized = normalizeTeamName(rawName);
  if (!normalized.ok) {
    return reject("invalid", `团队名不可用：\n${normalized.reason}\n可立即换一个名字重试。`);
  }
  const name = normalized.name;
  const previousName = session.teamDefinition.name;
  const sessionId = session.sessionId;
  const sessionsRoot = join(deps.rootDir, "sessions");
  const oldDir = join(sessionsRoot, previousName, sessionId);
  const newParent = join(sessionsRoot, name);
  const newDir = join(newParent, sessionId);

  // ── Step 6: idempotent success (same name → no filesystem action) ──
  if (name === previousName) {
    return {
      ok: true,
      name,
      previousName,
      moved: false,
      adjusted: normalized.adjusted,
      dir: oldDir,
      stubRewrite: "not-attempted",
    };
  }

  // ── Step 7: collisions (never overwrite) ──
  let existingTeams: string[];
  try {
    existingTeams = listTeams(deps.rootDir);
  } catch (err) {
    // An unreadable teams/ directory must not surface as a thrown tool error.
    return reject(
      "io",
      `改名失败（无法读取已有团队列表）：${errorMessage(err)}。团队名与会话目录未改变，可重试。`
    );
  }
  const takenByTeam = existingTeams.some(
    (teamName) => teamName.toLowerCase() === name.toLowerCase()
  );
  if (takenByTeam) {
    return reject(
      "taken",
      `团队名「${name}」已被预定义团队使用（同名会让同一个可读标识同时指向两个团队）。请换一个名字后重试。`
    );
  }
  if (existsSync(newDir)) {
    return reject(
      "io",
      `目标会话目录已存在（sessions/${name}/${sessionId}），已中止改名，未做任何改动。请换一个名字重试。`
    );
  }

  // ── Steps 8-10: move the session directory ──
  const moveDir = deps.moveDir ?? renameSync;
  try {
    mkdirSync(newParent, { recursive: true });
    moveDir(oldDir, newDir);
  } catch (err) {
    removeDirIfEmpty(newParent);
    return reject(
      "io",
      `改名失败（无法移动会话目录）：${errorMessage(err)}。团队名与会话目录未改变，可换名重试。`
    );
  }
  removeDirIfEmpty(join(sessionsRoot, previousName));

  // ── Step 11: in-memory rename ──
  renameTeamInSession(name);
  const oldTeam = session.teamDefinition;
  const newTeam: TeamDefinition = { ...oldTeam, name };

  // ── Step 12: manifest must land in the (new) directory ──
  // A silent failure here would leave "directory=new, manifest=old": /team
  // resume would rebuild an empty old-name directory and the member contexts
  // plus the settings snapshot would look lost. Hence the rollback.
  const syncManifest =
    deps.syncManifest ?? (() => syncActiveManifest({ status: "active" }, deps.rootDir));
  // Step 14 helper (defined early: the degraded partial path keeps the same
  // post-move cleanup as the success path).
  const rewriteStub =
    deps.rewriteSharedContextStub ?? ((old: TeamDefinition, next: TeamDefinition) =>
      rewriteStubIfUnchanged(old, next, sessionId));
  const tryRewriteStub = (): StubRewriteOutcome => {
    try {
      return rewriteStub(oldTeam, newTeam);
    } catch {
      // fail-open — an old-name stub is cosmetic; never fail the rename for it.
      return "undecidable";
    }
  };
  if (!syncManifest()) {
    renameTeamInSession(previousName);
    try {
      // The old parent was cleaned up after the move — recreate it, otherwise
      // the rollback rename would fail with ENOENT.
      mkdirSync(join(sessionsRoot, previousName), { recursive: true });
      moveDir(newDir, oldDir);
    } catch {
      // Rollback failed: the directory stays at the new name. Keep memory
      // aligned with the disk so /team resume (directory name is
      // authoritative) heals the manifest instead of losing the session.
      try {
        renameTeamInSession(name);
      } catch {
        // Session may have been torn down in between — nothing else to do.
      }
      // The directory HAS moved: rebind the per-session settings dir (and
      // refresh the widget) even on this degraded path — otherwise a later
      // settings write would recreate a stray old-name directory and
      // /team resume would not find the snapshot.
      try {
        deps.onRenamed?.(name);
      } catch {
        // fail-open — the disk is already at the new name.
      }
      // Same post-move cleanup as the success path: rewrite the stub so the
      // file does not keep advertising the old name.
      tryRewriteStub();
      return reject(
        "partial",
        `会话目录已改为「${name}」，但清单写入失败且回滚也失败。请执行 /team resume：恢复时以目录名为准，清单会被自动修正。`
      );
    }
    // Rollback succeeded: drop the now-empty new-name parent directory.
    removeDirIfEmpty(newParent);
    return reject(
      "io",
      `改名失败（清单写入失败），已回滚到原团队名「${previousName}」。可换名重试。`
    );
  }

  // ── Step 13: post-success hook (settings dir rebind + widget refresh) ──
  try {
    deps.onRenamed?.(name);
  } catch {
    // fail-open — the name is already in effect; the UI catches up on the next
    // refresh / member event.
  }

  // ── Step 14: shared context stub (structural check — the roster may have grown) ──
  const stubRewrite = tryRewriteStub();

  return {
    ok: true,
    name,
    previousName,
    moved: true,
    adjusted: normalized.adjusted,
    dir: newDir,
    stubRewrite,
  };
}
