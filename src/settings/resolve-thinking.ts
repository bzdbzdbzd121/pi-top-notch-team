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

/**
 * 成员思考强度设置形态（对象化两态，与 memberModel 同构）：
 *   - "follow" — 成员 spawn 时使用 TL 当前思考强度（快照语义）。
 *   - "fixed"  — 固定使用 `level`；fixed 且缺 level → 视为默认（不指定，
 *     与 MemberModelSetting fixed 无 model 回退先例一致）。
 * undefined（键缺失）表达「默认」——显式 default 是伪状态，不引入第三态。
 */
export type MemberThinkingMode = "follow" | "fixed";

export interface MemberThinkingSetting {
  /** "follow" — 成员 spawn 时使用 TL 当前思考强度；"fixed" — 固定 level */
  mode: MemberThinkingMode;
  /** 仅 mode === "fixed" 时有意义；fixed 且缺失 → 视为默认（不指定） */
  level?: MemberThinkingLevel;
}

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
 * settings.yaml / resume 快照的 memberThinkingLevel 值解析：
 * 旧字符串形态 → 新对象形态迁移 + 新对象形态校验，一次完成。
 *
 * 迁移守卫必须用**原始 YAML 值**调用（决策 #34 教训）：settings 克隆恒带新形态
 * 缺省（undefined），用克隆值判断则永不迁移。
 *
 *   - 旧值 `"high"`（合法 7 级别）→ `{mode:"fixed", level:"high"}`
 *   - 防御性：`"follow"`（手写/未来形态）→ `{mode:"follow"}`
 *   - 新形态对象 → 原样通过（幂等）
 *   - 非法值 → undefined（丢弃，fail-open 回退默认）
 */
export function parseMemberThinkingSetting(
  value: unknown
): MemberThinkingSetting | undefined {
  if (isMemberThinkingLevel(value)) {
    return { mode: "fixed", level: value };
  }
  if (value === "follow") {
    return { mode: "follow" };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.mode === "follow") {
      // follow 模式下 level 无意义——规范化丢弃（保持幂等输出形态）
      return { mode: "follow" };
    }
    if (obj.mode === "fixed") {
      if (obj.level === undefined) {
        return { mode: "fixed" };
      }
      if (isMemberThinkingLevel(obj.level)) {
        return { mode: "fixed", level: obj.level };
      }
      // fixed + 非法 level → 整体丢弃（fail-open）
      return undefined;
    }
    // 未知 mode（含已否决的三态 "default"）→ 丢弃
    return undefined;
  }
  return undefined;
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
 * 设置形态（P1 对象化）：
 *   - fixed → 使用 `level`（缺 level 视为默认）；
 *   - follow → 使用 `tlLevel`（TL 当前思考强度快照，P2 接线注入）；
 *   - undefined → 默认。
 *
 * `supportedLevels` 为 undefined（注册表不可用 / 模型未登录 / 无模型覆盖）
 * 时 fail-open：不传 flag，保持现状。
 *
 * fail-open 不 clamp：成员模型不支持 TL 级别（如 TL=xhigh、成员仅到 high）时
 * 不传 flag 用 pi 默认——成员侧 setThinkingLevel 也会 clamp，预检 fail-open
 * 保证「传了什么、生效什么」完全可预测，避免「以为传 high 实际 medium」的
 * 隐性偏差（决策 D3）。
 */
export function resolveMemberThinking(
  requested: MemberThinkingSetting | undefined,
  tlLevel: MemberThinkingLevel | undefined,
  supportedLevels: readonly string[] | undefined
): MemberThinkingLevel | undefined {
  const target =
    requested === undefined
      ? undefined
      : requested.mode === "follow"
        ? tlLevel
        : requested.level;
  if (!target) return undefined;
  if (!supportedLevels) return undefined;
  return supportedLevels.includes(target) ? target : undefined;
}

/** 菜单/通知用的可读标签。 */
export function describeMemberThinkingSetting(
  settings: { memberThinkingLevel?: MemberThinkingSetting },
  tlLevel?: MemberThinkingLevel
): string {
  const setting = settings.memberThinkingLevel;
  if (!setting) return "默认（不指定）";
  if (setting.mode === "follow") {
    return tlLevel ? `跟随 TL（当前：${tlLevel}）` : "跟随 TL（TL 级别未知）";
  }
  return setting.level ? `指定级别：${setting.level}` : "默认（不指定）";
}
