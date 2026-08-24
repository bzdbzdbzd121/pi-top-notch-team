import type { TeamSettings } from "./settings";

/**
 * Default total budget for team wait operations, in minutes (0 = unlimited).
 *
 * Shared by, and fully independent of auto-compaction:
 *  - the all-idle deadline of wait_and_get_member_status / team_send_and_wait
 *    (defense in depth: never hang forever on a stuck member), and
 *  - the batch alignment barrier budget (maxWait).
 */
export const DEFAULT_WAIT_TIMEOUT_MINUTES = 15;

/**
 * Resolve the effective wait budget (minutes) from global settings.
 * Absent settings / unset field → the default. 0 = unlimited
 * (the original "wait tools never time out" semantics).
 */
export function resolveWaitTimeoutMinutes(settings?: TeamSettings): number {
  if (!settings) return DEFAULT_WAIT_TIMEOUT_MINUTES;
  return Math.max(0, Math.floor(settings.waitTimeoutMinutes ?? DEFAULT_WAIT_TIMEOUT_MINUTES));
}

/** Human-readable label: "15 分钟" / "不限" (used in menus). */
export function describeWaitTimeoutSetting(settings: TeamSettings): string {
  const minutes = resolveWaitTimeoutMinutes(settings);
  return minutes > 0 ? `${minutes} 分钟` : "不限";
}
