import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createMemberProcess, hasSessionFiles } from "../process/member-process";
import type { MemberProcessHandle, MemberProcessConfig } from "../process/member-process";
import type { ProcessManager } from "../process/manager";
import type { MessageQueue } from "../channel/message-queue";
import type { ResponseWaiter } from "../channel/response-waiter";
import type { MemberOperationalState } from "../session/context";
import type { TeamSessionState } from "../session/state";
import type { TeamSettings } from "../settings/settings";
import { getRootDir } from "../config";
import { loadEffectiveSettings } from "../settings/session-settings";
import { resolveMemberThinking, isMemberThinkingLevel } from "../settings/resolve-thinking";
import { resolveMemberModel } from "../settings/resolve-model";
import { resolvePeerMessaging } from "../settings/resolve-peer-messaging";
import { createMemberEventHandler } from "../channel/event-handler";
import type { AutoCompactRuntime } from "../channel/auto-compact";
import type { MessageCoalescer } from "../channel/message-coalescer";
import { mkdirSync } from "node:fs";
import { transitionState } from "../session/state-machine";
import { ensureSharedContextFile } from "../session/shared-context";

// ── Dependency Injection Interface ─────────────────────────

export interface MemberLifecycleDeps {
  pi: ExtensionAPI;
  memberOpsStates: Map<string, MemberOperationalState>;
  messageQueue: MessageQueue;
  responseWaiter: ResponseWaiter;
  lastPendingCorrId: Map<string, string>;
  recentlyProcessedMessages: Map<string, number>;
  processManager?: ProcessManager;
  /** Auto-reply tracking: last assistant text per member (populated at message_end). */
  lastAssistantTexts?: Map<string, string>;
  /** Auto-reply tracking: members that replied via team_send_message in current turn. */
  perTurnReplied?: Set<string>;
  /** Auto-reply tracking: pending setTimeout refs for scheduled auto-replies. */
  pendingAutoReplies?: Map<string, NodeJS.Timeout>;
  /** Activity hook forwarded to the event handler (Member Inspector). Receives the full member RPC event. */
  onMemberActivity?: (memberName: string, event: any) => void;
  /**
   * Member process handles by name — forwarded to the event handler (Phase 1:
   * the get_state query after prompt rejections + the compaction_end flush
   * dispatch). Absent = those branches are inert.
   */
  memberHandles?: Map<string, MemberProcessHandle>;
  /**
   * Shared auto-compaction runtime (from createMessageChannel) — forwarded to
   * the event handler (Phase 1: the compaction_end consumption branch).
   */
  autoCompact?: AutoCompactRuntime;
  /**
   * Shared message coalescer (from createMessageChannel, S1 阶段 2) —
   * forwarded to the event handler (agent_end flush / compaction_end flush /
   * process-exit drain). Absent = the S1 branches are inert.
   */
  coalescer?: MessageCoalescer;
}

// ── Duplicate-start guard (阶段 1, 方案 §3.1) ───────────────

/**
 * 重复启动判定的唯一实现（工具层 start_member 与下面的结构性兜底共用）。
 *
 * 只看进程句柄自己的状态：
 *   - running            → 拒绝（避免两个同名进程同时运行）
 *   - stopped + PID 非空 → 拒绝（正在停止中：已置停止态、进程仍在退出。
 *                          把 stop_member 与 start_member 放进同一条消息并行
 *                          执行时必现——旧进程退出会把新成员标成已停、清掉它
 *                          名下的消息队列）
 *   - 其余（stopped + PID 空 / error / idle / 无句柄）→ 放行
 *     （崩溃后句柄是 stopped + PID 空，属「崩溃后可重试」的既有恢复路径）
 *
 * 刻意不看成员操作状态表（可能残留已停止成员的条目——表里有条目 ≠ 在运行）
 * 与进程管理器状态（崩溃循环冻结会把仍在运行的成员报成错误态）。
 * fail-open：句柄缺失或 getState 抛错 → 放行（结构性兜底仍在创建函数内）。
 */
export interface DuplicateStartBlock {
  /** running = 已在运行；stopping = 正在停止中（已置停止态、进程仍在退出）。 */
  reason: "running" | "stopping";
  pid: number | null;
}

export function detectDuplicateStart(
  handle: MemberProcessHandle | undefined
): DuplicateStartBlock | null {
  if (!handle) return null;
  let state;
  try {
    state = handle.getState();
  } catch {
    return null;
  }
  if (!state) return null;
  if (state.status === "running") {
    return { reason: "running", pid: state.pid ?? null };
  }
  if (state.status === "stopped" && state.pid !== null && state.pid !== undefined) {
    return { reason: "stopping", pid: state.pid };
  }
  return null;
}

// ── createAndRegisterMember ────────────────────────────────
// Creates a member RPC process and wires event handling for:
//   - Operational state transitions (agent_start/agent_end/process_exit/process_error)
//   - team_send_message tool result interception
//   - <team-message> tag backup parsing
//   - Process crash notification to TL
//   - Pending correlation ID cleanup on member failure

export function createAndRegisterMember(
  pi: ExtensionAPI,
  config: MemberProcessConfig,
  deps: MemberLifecycleDeps
): MemberProcessHandle {
  // 结构性重复启动兜底（阶段 1，方案 §3.1.2 第二层 / 不变式 E7）：
  // 同时服务 start_member 与 /team resume 两条启动路径，工具层守卫缺接线时
  // 仍然拦得住。必须放在下面「把成员操作状态重置为 idle」之前——那个写入
  // 发生在注册句柄之前，挡在后面的话被拒绝的调用已经把运行中成员的状态改成
  // 了 idle，all-idle 门控会提前放行。
  // 刻意不在这里「顺手停掉旧进程」：旧进程的退出事件会把刚起来的新成员标成
  // 已停、清掉它的消息队列，等于把要防的问题放大一份。
  const blocked = detectDuplicateStart(deps.memberHandles?.get(config.name));
  if (blocked) {
    const pid = blocked.pid ?? "未知";
    throw new Error(
      blocked.reason === "running"
        ? `成员 "${config.name}" 已在运行 (PID: ${pid})，拒绝重复创建进程。`
        : `成员 "${config.name}" 正在停止中 (PID: ${pid})，请等 stop_member 返回后再启动。`
    );
  }

  const handle = createMemberProcess(config, spawn);
  deps.memberOpsStates.set(config.name, transitionState("idle", { type: "started" }));

  if (deps.processManager) {
    deps.processManager.addHandle(handle);
  }

  handle.onEvent(createMemberEventHandler(config.name, deps));

  return handle;
}

// ── buildMemberConfig ──────────────────────────────────────
// Build a MemberProcessConfig from a member name and session state.
// Uses fileURLToPath (Windows-safe) instead of .pathname.
//
// Model resolution precedence (see src/settings/resolve-model.ts):
//   member.model > team defaults.model > global fixed > global follow (TL model) > none

export interface BuildMemberConfigOptions {
  /** TL's current model as "provider/id" — used when the global setting is "follow". */
  tlCurrentModel?: string;
  /**
   * TL's current thinking level — used when the global `memberThinkingLevel`
   * setting is "follow" (P2 事件接线快照，与 tlCurrentModel 对称)。
   * 取值为 TL 实际生效级别（agent.state.thinkingLevel，clamp 后）；非合法级别
   * 字符串（运行时防御）→ 视为未知 fail-open 不传 flag。
   */
  tlThinkingLevel?: string;
  /**
   * Force session resume (`--continue`). When omitted, resume is auto-detected:
   * a member whose session dir already contains persisted pi session files is
   * always resumed (context continuity on restart), a fresh dir starts fresh.
   */
  resume?: boolean;
  /**
   * Look up the thinking levels supported by a model ("provider/id").
   * Returns undefined when the model cannot be found / the registry is
   * unavailable (fail-open → no `--thinking` flag, member keeps its default).
   * Only consulted when the global `memberThinkingLevel` setting is set.
   */
  lookupSupportedThinkingLevels?: (modelRef: string) => readonly string[] | undefined;
  /**
   * Pre-resolved effective settings (global settings + per-session overlay merged,
   * 阶段 2 临时设置). When omitted, plain global settings are loaded from disk
   * (legacy path — keeps existing call sites/tests intact). index.ts always passes
   * getEffectiveSettings() so per-session temporary settings reach the member spawn.
   */
  settings?: TeamSettings;
}

export function buildMemberConfig(
  memberName: string,
  session: TeamSessionState,
  options?: BuildMemberConfigOptions
): MemberProcessConfig | null {
  const team = session.teamDefinition;
  if (!team) return null;

  const memberDef = team.members.find((m) => m.name === memberName);
  if (!memberDef) return null;

  const rootDir = getRootDir();
  const sessionId = session.sessionId;
  if (!sessionId) {
    console.warn(
      `[team] No sessionId in session state — member "${memberName}" will use flat path.`
    );
  }
  // Isolate session data under <rootDir>/sessions/<team-name>/<sessionId>/
  // This prevents conflicts when the same team is used across multiple sessions.
  const sessionSubDir = sessionId ? join(team.name, sessionId) : team.name;
  const sessionDir = join(rootDir, "sessions", sessionSubDir, memberName);

  // Create session directory before starting the member
  mkdirSync(sessionDir, { recursive: true });

  // Guarantee the shared context file exists — auto-create a minimal stub
  // when the TL hasn't written one yet (instead of only warning).
  const sharedContextPath = ensureSharedContextFile(team, sessionId);

  // Resolve the effective model for this member (global settings + team YAML + TL model)
  // 阶段 5：缺省回退改走合并层（loadEffectiveSettings = 磁盘全局 + 内存 overlay
  // 深合并）——杜绝「忘记传 settings 静默回退全局」导致临时设置被绕过的 R4 漏洞。
  // 生产调用点（index.ts）恒传 getEffectiveSettings()，此回退为防御性兜底。
  const settings = options?.settings ?? loadEffectiveSettings(rootDir);
  const resolved = resolveMemberModel(memberDef, team, settings, options?.tlCurrentModel);

  // Resolve the thinking level: only pass `--thinking` when the global setting
  // is configured AND the resolved model supports that exact level; otherwise
  // absent → member pi uses its own default thinking level (保持现状).
  const requestedLevel = settings.memberThinkingLevel;
  let thinking: string | undefined;
  if (requestedLevel && resolved.model) {
    const supported = options?.lookupSupportedThinkingLevels?.(resolved.model);
    // P1：follow 模式尚未接线（P2 引入 tlThinkingLevel 快照注入）——TL 级别传
    // undefined，resolveMemberThinking fail-open 不传 flag（与 tlCurrentModel
    // undefined 行为一致）。fixed 路径行为与 P1 前完全一致。
    // P2：follow 模式注入 TL 级别快照（非法级别字符串运行时防御 → fail-open）。
    const tlLevel =
      options?.tlThinkingLevel !== undefined && isMemberThinkingLevel(options.tlThinkingLevel)
        ? options.tlThinkingLevel
        : undefined;
    thinking = resolveMemberThinking(requestedLevel, tlLevel, supported);
  }

  return {
    name: memberName,
    role: memberName,
    roleLabel: memberDef.label ?? memberName,
    teamName: team.name,
    teamMembers: team.members.map((m) => m.name),
    memberDescription: memberDef.systemPrompt,
    sessionDir,
    sharedContextPath,
    memberExtensionPath: fileURLToPath(
      new URL("../../member.ts", import.meta.url)
    ),
    cwd: process.cwd(),
    // P3 成员体验层：互发策略 spawn 快照（仅禁止态写入，allowed 恒不设字段——
    // 与 model/thinking 先例同构；member.ts/member-process 侧同异缺省 allowed）。
    ...(resolvePeerMessaging(settings) === "tl-only" ? { peerMessaging: "tl-only" } : {}),
    // Resume whenever this member already has persisted session files — covers
    // /team resume, TL-process restarts, and intentional stop/start cycles.
    // A fresh sessionId dir has no files and starts clean.
    ...(options?.resume || hasSessionFiles(sessionDir) ? { resume: true } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

// ── getMemberLog ───────────────────────────────────────────
// Query a member's recent session messages via RPC get_messages.

export async function getMemberLog(
  handle: MemberProcessHandle,
  maxLines: number,
  maxContentLength?: number
): Promise<string> {
  const response = await handle.sendCommandAndWait(
    { type: "get_messages" },
    (event: any) =>
      event.type === "response" && event.command === "get_messages"
  );

  const effectiveMaxLen = maxContentLength ?? 200;

  const messages = response?.data?.messages ?? [];
  const recent = messages.slice(-maxLines);
  return recent
    .map((m: any) => {
      let content =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content);

      // Truncate at character level (UTF-16 code units), reserving 3 chars for "..."
      if (content.length > effectiveMaxLen) {
        const truncatedLen = Math.max(0, effectiveMaxLen - 3);
        content = content.slice(0, truncatedLen) + "...";
      }

      return `[${m.role}] ${content}`;
    })
    .join("\n");
}
