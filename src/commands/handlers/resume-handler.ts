import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamContext, SessionUI } from "../../session/context";
import { getSessionState, startSession, markSharedContextWritten } from "../../session/state";
import { setGoalInternal } from "../../tools/goal-tools";
import {
  listSessionManifests,
  setManifestRuntimeContext,
  syncActiveManifest,
  type TeamSessionManifest,
} from "../../session/manifest";
import { readTeam } from "../../team/store";
import { getRootDir } from "../../config";
import { ensureAddDynamicMemberTool } from "../../setup/dynamic-session-bootstrap";
import { STOP_TEAM_SESSION_TOOL_NAME } from "../../tools/agent-session-tool-names";
import type { TeamDefinition } from "../../team/definition";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /team resume [名称或sessionId前缀] — Resume an interrupted or stopped team session.
 *
 * Rehydrates TeamSessionState from the on-disk manifest (session.json), then
 * restarts the previously-started members with `--continue` so their full
 * context is restored from the persisted pi session files. In-flight tasks at
 * interruption time are NOT replayed (processes died mid-turn); the TL is
 * told via a one-shot prompt banner to re-check member status and re-dispatch.
 */

/** Deps injected by index.ts (member spawning needs module-scope wiring). */
export interface ResumeHandlerDeps {
  /**
   * Spawn a member process resuming its persisted session (--continue).
   * Returns the new pid. Throws on failure.
   */
  startResumedMember: (name: string) => Promise<number | null>;
}

// ── Orphan cleanup ─────────────────────────────────────────
// If the TL process was killed, member processes may have survived as orphans
// (they normally self-terminate on stdin EOF, but a hard kill can race). A
// revived session must not have two processes appending to the same session
// file, so best-effort SIGTERM any survivor. Verified via /proc environ to
// avoid killing an unrelated reused PID; skipped on non-Linux.

function isTeamMemberProcess(pid: number, manifest: TeamSessionManifest): boolean {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf-8");
    return (
      env.includes(`TEAM_NAME=${manifest.teamName}`) &&
      env.includes(join("sessions", manifest.teamName, manifest.sessionId))
    );
  } catch {
    return false;
  }
}

export function cleanupOrphanMembers(manifest: TeamSessionManifest): string[] {
  const killed: string[] = [];
  for (const [name, pid] of Object.entries(manifest.memberPids ?? {})) {
    if (typeof pid !== "number" || pid <= 0) continue;
    if (!isTeamMemberProcess(pid, manifest)) continue;
    try {
      process.kill(pid, "SIGTERM");
      killed.push(name);
    } catch {
      // Already gone — fine.
    }
  }
  return killed;
}

// ── Picker label ───────────────────────────────────────────

function formatEntry(m: TeamSessionManifest): string {
  const when = new Date(m.lastActiveAt).toLocaleString();
  const status = m.status === "active" ? "中断" : "已停止";
  const kind = m.isDynamic ? "动态" : "预定义";
  return `${m.teamName} (${m.sessionId}) — ${kind}/${status}/${m.members.length} 成员 — ${when}`;
}

// ── Handler ────────────────────────────────────────────────

export async function handleResume(
  pi: ExtensionAPI,
  teamCtx: TeamContext,
  ctx: ExtensionCommandContext,
  subargs: string,
  deps: ResumeHandlerDeps,
): Promise<void> {
  if (getSessionState().active) {
    ctx.ui.notify("当前已有活跃团队会话，请先 /team stop 再恢复其他会话。", "warning");
    return;
  }

  const rootDir = getRootDir();
  const entries = listSessionManifests(rootDir);
  if (entries.length === 0) {
    ctx.ui.notify("没有可恢复的团队会话（未找到任何 session.json 清单）。", "info");
    return;
  }

  // ── Pick which session to resume ──
  const arg = subargs.trim();
  let candidates = entries;
  if (arg) {
    candidates = entries.filter(
      (e) => e.manifest.teamName === arg || e.manifest.sessionId.startsWith(arg)
    );
    if (candidates.length === 0) {
      ctx.ui.notify(`没有匹配 "${arg}" 的可恢复会话。`, "warning");
      return;
    }
  }

  let selected = candidates[0];
  if (candidates.length > 1) {
    const options = candidates.map((e) => formatEntry(e.manifest));
    const choice = await ctx.ui.select("选择要恢复的团队会话（按最后活跃时间排序）", options);
    if (!choice) return; // cancelled
    const idx = options.indexOf(choice);
    if (idx < 0) return;
    selected = candidates[idx];
  }

  const manifest = selected.manifest;

  // ── Orphan member cleanup (best-effort) ──
  const killedOrphans = cleanupOrphanMembers(manifest);

  // ── Rehydrate team definition: manifest roster is authoritative ──
  // (for dynamic teams it is the only copy; for predefined teams it is the
  // exact snapshot this session's member dirs were built from). Description
  // prefers the current YAML when available.
  const yamlTeam = manifest.isDynamic ? null : readTeam(manifest.teamName, rootDir);
  const team: TeamDefinition = {
    name: manifest.teamName,
    description: yamlTeam?.description ?? "（恢复的团队会话）",
    members: manifest.members ?? [],
    defaults: yamlTeam?.defaults,
    workflow: yamlTeam?.workflow,
  };

  // Clean up any stale edit/create-mode widget
  teamCtx.onEditEnd?.();
  teamCtx.onCreateEnd?.();

  // ── Rehydrate session state ──
  startSession(team, { sessionId: manifest.sessionId, origin: manifest.origin });
  if (manifest.sharedContextWritten) {
    markSharedContextWritten();
  }
  if (manifest.goal) {
    setGoalInternal(manifest.goal.text, manifest.goal.criteria);
  }
  teamCtx.isDynamicSession = manifest.isDynamic;
  teamCtx.dynamicPhase = manifest.dynamicPhase;
  teamCtx.agentInitiatedTask = manifest.agentInitiatedTask ?? null;
  setManifestRuntimeContext({
    isDynamic: manifest.isDynamic,
    dynamicPhase: manifest.dynamicPhase,
    agentInitiatedTask: manifest.agentInitiatedTask ?? null,
  });

  teamCtx.router!.updateMembers(team.members.map((m) => m.name));
  if (manifest.isDynamic) {
    ensureAddDynamicMemberTool(pi, teamCtx);
  }

  // Widget + session-tool registration (onSessionStart also syncs the manifest)
  teamCtx.onSessionStart?.(ctx.ui as unknown as SessionUI);

  // Activate session tools (+ dynamic / agent-session extras)
  const extras = [
    ...(manifest.isDynamic ? ["add_dynamic_member"] : []),
    ...(manifest.origin === "agent" ? [STOP_TEAM_SESSION_TOOL_NAME] : []),
  ];
  const currentActive = pi.getActiveTools();
  const newActive = [...new Set([...currentActive, ...teamCtx.tlToolNames, ...extras])]
    .filter((t) => t !== "create_team_definition" && t !== "update_team_definition");
  pi.setActiveTools(newActive);

  // ── Restart previously-started members with full context ──
  const restarted: string[] = [];
  const failed: string[] = [];
  for (const name of manifest.startedMembers ?? []) {
    if (!team.members.some((m) => m.name === name)) continue;
    try {
      await deps.startResumedMember(name);
      restarted.push(name);
    } catch {
      failed.push(name);
    }
  }

  // Re-stamp the manifest as active with the new pid set.
  syncActiveManifest({ status: "active" });

  // One-shot TL prompt banner (consumed by the next before_agent_start)
  teamCtx.resumedFrom = {
    teamName: manifest.teamName,
    sessionId: manifest.sessionId,
    restartedMembers: restarted,
    failedMembers: failed,
  };

  const orphanNote = killedOrphans.length > 0 ? `\n已清理 ${killedOrphans.length} 个残留成员进程（${killedOrphans.join(", ")}）。` : "";
  const failNote = failed.length > 0 ? `\n⚠️ ${failed.length} 个成员重启失败（${failed.join(", ")}）——TL 可用 start_member 重试。` : "";
  ctx.ui.notify(
    `团队会话 "${manifest.teamName}" (${manifest.sessionId}) 已恢复。\n` +
      `${restarted.length} 个成员已带着完整上下文重启${restarted.length > 0 ? `（${restarted.join(", ")}）` : ""}。${orphanNote}${failNote}\n` +
      `中断前正在执行的任务不会自动继续——TL 会确认成员状态后继续。`,
    "info"
  );
}
