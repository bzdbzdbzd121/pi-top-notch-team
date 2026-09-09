import type { TeamSettings } from "./settings";

/**
 * 成员互发的有效模式（P1 设置数据层的 resolver 输出；P2 路由层与 P3 成员层
 * 以此为唯一判定值，member 进程侧经 TEAM_PEER_MESSAGING env 快照承载同一词汇）。
 *  - "allowed"  — 允许成员互发（现状全互连拓扑，默认）。
 *  - "tl-only"  — 禁止成员互发：成员只能回复 TL（星型拓扑；成员→成员与→all
 *                 消息在 TL 路由层被拦截）。
 * 枚举形态可演进（proxy 子模式等，见最终方案 D9）。
 */
export type PeerMessagingMode = "allowed" | "tl-only";

/**
 * Resolve the effective peer-messaging mode from team settings.
 * `allowPeerMessaging === false` → "tl-only"；其余（undefined / true）→ "allowed"。
 *
 * fail-open（显式取舍）：settings 读取/访问异常时按「允许」处理——禁令缺失时
 * 保持现状可用性优先，与压缩/合并机制同姿态（绝不因 resolver 异常静默禁发）。
 */
export function resolvePeerMessaging(settings: TeamSettings): PeerMessagingMode {
  try {
    return settings.allowPeerMessaging === false ? "tl-only" : "allowed";
  } catch {
    return "allowed";
  }
}

/** Human-readable label for the peer-messaging setting (used in menus): 「允许」/「仅限回复 TL」. */
export function describePeerMessagingSetting(settings: TeamSettings): string {
  return resolvePeerMessaging(settings) === "tl-only" ? "仅限回复 TL" : "允许";
}
