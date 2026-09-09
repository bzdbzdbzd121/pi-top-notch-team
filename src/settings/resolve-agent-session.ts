import type { TeamSettings } from "./settings";

/**
 * 解析 agent 自主会话开关（start_team_session，ADR-0003）。
 * `allowAgentInitiatedSessions === false` → 禁止；其余（undefined / true / 访问异常）→ 允许。
 *
 * fail-open（显式取舍，不对称论证）：误允许可经 /team setting 修正，误禁止静默剥夺
 * agent 委派能力更难察觉——与 resolvePeerMessaging 同姿态（注释写明取舍）。
 *
 * 生效时点：per-call 动态求值（late-evaluation 纪律）——消费点每次调用实时读
 * settings，绝不在注册点缓存；切换下一回合边界即生效，无需重启。
 * 语义边界：仅影响**启动相**；运行中的 agent 会话不终止，stop/resume 不受影响。
 */
export function resolveAgentSessionAllowed(settings: TeamSettings): boolean {
  try {
    return settings.allowAgentInitiatedSessions !== false;
  } catch {
    return true;
  }
}

/** 菜单标签：「允许」/「禁止」。 */
export function describeAgentSessionSetting(settings: TeamSettings): string {
  return resolveAgentSessionAllowed(settings) ? "允许" : "禁止";
}
