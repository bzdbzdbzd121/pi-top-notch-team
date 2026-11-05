import type { TeamSettings } from "./settings";

/**
 * TL「亲自分析限制」（tlSelfWorkGuard）解析器。
 *
 * 覆盖两个按阶段互斥的运行时限制器（总开关共用，次数只作用于执行阶段）：
 *  - 执行阶段派发前拦截（sticky，默认每回合 3 次）；
 *  - 动态团队设计阶段的 read 频率提醒（节奏固定每 4 次，不受次数设置影响）。
 *
 * 本模块**不得** `import { loadSettings }`（静态扫描白名单会红）——调用方统一经
 * 合并层 `getEffectiveSettings()` 读取，保证临时设置生效。
 */

export const DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD = 3;

/**
 * 次数下限 2：团队提示词保证「需求对齐阶段允许读取 1-2 个文件」，上限 < 2 会让该
 * 例外当场失效（提示词与运行时冲突）。`0` 也不接受——它与同菜单里「等待上限 0 =
 * 不限」的约定方向相反，想关闭请用开关。
 */
export const MIN_TL_SELF_WORK_GUARD_THRESHOLD = 2;

export interface ResolvedTlSelfWorkGuard {
  /** 限制是否生效（两个限制器共用）。 */
  enabled: boolean;
  /** 每回合允许的非管理工具调用次数（整数 ≥ 2；缺省 3）。 */
  threshold: number;
}

/**
 * 解析生效值。
 *
 * 异常方向：**保持约束**（回到默认 开启 + 3），与 allowPeerMessaging /
 * allowAgentInitiatedSessions 的 fail-open（放宽）相反——那两项放宽的是用户能力
 * （误关容易被发现），本项放宽的是行为约束（误关是静默的角色漂移，模型会不声不响
 * 自己埋头分析）。不要按「统一 fail-open」的惯性改这里。
 *
 * 调用点仍必须自带 try/catch：本函数自身已兜底，但调用点的异常后果不对称——
 * 回合开始事件的处理器抛错只会记一条扩展错误，工具调用事件的处理器抛错会阻断
 * 每一次工具调用。
 */
export function resolveTlSelfWorkGuard(settings?: TeamSettings): ResolvedTlSelfWorkGuard {
  try {
    const raw = settings?.tlSelfWorkGuard;
    // 仅字面 false 关闭；缺失/非法/异常形态一律保持开启（fail-safe）。
    const enabled = raw?.enabled !== false;
    const t = raw?.threshold;
    const threshold =
      typeof t === "number" && Number.isInteger(t) && t >= MIN_TL_SELF_WORK_GUARD_THRESHOLD
        ? t
        : DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD;
    return { enabled, threshold };
  } catch {
    return { enabled: true, threshold: DEFAULT_TL_SELF_WORK_GUARD_THRESHOLD };
  }
}

/**
 * 菜单标签：「开启 · 每回合 3 次」/「关闭」。
 * 关闭时不输出次数——否则会给出自相矛盾的标签（「关闭 · 每回合 5 次」）。
 */
export function describeTlSelfWorkGuardSetting(settings: TeamSettings): string {
  const r = resolveTlSelfWorkGuard(settings);
  return r.enabled ? `开启 · 每回合 ${r.threshold} 次` : "关闭";
}
