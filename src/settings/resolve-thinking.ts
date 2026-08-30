/**
 * 成员思考强度（thinking level）解析——纯函数。
 *
 * 支持语义复刻自 pi-ai 的 `getSupportedThinkingLevels`（已对照 pi 0.83.x
 * dist bundle chunk-MNAIPA3J.js 逐字验证）：
 *   - 非 reasoning 模型：仅支持 "off"。
 *   - reasoning 模型：off/minimal/low/medium/high 默认支持，除非
 *     thinkingLevelMap 将其显式映射为 null；xhigh/max 仅当
 *     thinkingLevelMap 中存在对应条目时支持。
 *
 * 为什么本地复刻而不是 import "@earendil-works/pi-ai/compat"：
 * pi-ai 不是本包的依赖（仅 pi 内部 bundle），且扩展加载器的 jiti alias
 * 前缀替换有拼坏 @earendil-works 深导入的前科（见 DESIGN.md §17 的
 * pi-tui/dist/keys.js 案例）。该逻辑小而纯，在此版本锚定。
 */

export const MEMBER_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type MemberThinkingLevel = (typeof MEMBER_THINKING_LEVELS)[number];

/** 支持性检测所需的最小 Model 形状（pi Model 的结构子集）。 */
export interface ThinkingModelInfo {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** 运行时校验：值是否为合法思考级别（用于 settings.yaml 解析）。 */
export function isMemberThinkingLevel(value: unknown): value is MemberThinkingLevel {
  return (
    typeof value === "string" &&
    (MEMBER_THINKING_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * 返回模型支持的思考级别集合（语义与 pi-ai getSupportedThinkingLevels 一致）。
 */
export function getSupportedThinkingLevelsFor(
  model: ThinkingModelInfo
): MemberThinkingLevel[] {
  if (!model.reasoning) {
    return ["off"];
  }
  return MEMBER_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * 解析成员的 `--thinking` 参数。
 *
 * 用户要求：配置了思考级别且模型支持 → 使用该级别；否则保持现状
 * （不传 flag，member pi 使用自己的默认思考级别链：per-model 覆盖 >
 * 全局默认 > 模型自身默认）。
 *
 * `supportedLevels` 为 undefined（注册表不可用 / 模型未登录 / 无模型覆盖）
 * 时 fail-open：不传 flag，保持现状。
 */
export function resolveMemberThinking(
  requested: MemberThinkingLevel | undefined,
  supportedLevels: readonly string[] | undefined
): MemberThinkingLevel | undefined {
  if (!requested) return undefined;
  if (!supportedLevels) return undefined;
  return supportedLevels.includes(requested) ? requested : undefined;
}

/** 菜单/通知用的可读标签。 */
export function describeMemberThinkingSetting(settings: {
  memberThinkingLevel?: MemberThinkingLevel;
}): string {
  return settings.memberThinkingLevel
    ? `指定级别：${settings.memberThinkingLevel}`
    : "默认（不指定）";
}
