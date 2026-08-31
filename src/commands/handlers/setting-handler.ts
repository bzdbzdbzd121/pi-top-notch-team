import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getRootDir } from "../../config";
import {
  loadSettings,
  saveSettings,
  describeMemberModelSetting,
  type TeamSettings,
} from "../../settings/settings";
import {
  DEFAULT_THRESHOLD_PERCENT,
  describeAutoCompactSetting,
} from "../../settings/resolve-auto-compact";
import {
  describeMessageCoalescingSetting,
  resolveMessageCoalescing,
} from "../../settings/resolve-message-coalescing";
import {
  describeWaitTimeoutSetting,
  resolveWaitTimeoutMinutes,
} from "../../settings/resolve-wait-timeout";
import {
  MEMBER_THINKING_LEVELS,
  describeMemberThinkingSetting,
} from "../../settings/resolve-thinking";
import {
  getSessionSettings,
  setSessionSetting,
  clearSessionSetting,
  clearAllSessionSettings,
  resolveEffectiveSettings,
  type DeepPartial,
} from "../../settings/session-settings";
import { getSessionState } from "../../session/state";
import { scrollSelect } from "../../ui/scroll-select";

/** Menu option identifiers (suffix after the emoji prefix is matched loosely). */
const OPT_SCOPE = "设置作用域";
const OPT_MEMBER_MODEL = "成员默认模型";
const OPT_MEMBER_THINKING = "成员思考强度";
const OPT_AUTO_COMPACT = "自动压缩";
const OPT_WAIT_TIMEOUT = "等待上限";
const OPT_COALESCE = "消息合并";
const OPT_CLEAR_ALL = "清除全部临时设置";
const OPT_FOLLOW = "跟随当前配置";
const OPT_FIXED = "指定模型";

// Auto-compaction submenu options
const AC_TOGGLE = "开关切换";
const AC_SET_PERCENT = "设置百分比阈值";
const AC_SET_TOKENS = "设置 token 阈值";
const AC_CLEAR_PERCENT = "清除百分比阈值";
const AC_CLEAR_TOKENS = "清除 token 阈值";
const AC_SET_TIMEOUT = "设置超时（分钟）";

// Message-coalescing submenu options (S1, 阶段 2)
const COALESCE_TOGGLE = "开关切换";
const COALESCE_SET_SIZE = "设置批量上限（条数）";
const COALESCE_SET_CHARS = "设置总字符上限";

/** 设置作用域：仅当前会话（临时 overlay）/ 全局（settings.yaml）。 */
type SettingScope = "temp" | "global";
const SCOPE_LABEL: Record<SettingScope, string> = {
  temp: "仅当前会话（临时）",
  global: "全局",
};

/**
 * 团队 YAML 指定 model 时（成员 model 或 defaults.model），全局/临时模型设置对
 * 这些成员不生效——菜单项透明附注（阶段 4）。
 */
function teamYamlSpecifiesModel(): boolean {
  const s = getSessionState();
  if (!s.active || !s.teamDefinition) return false;
  if (s.teamDefinition.defaults?.model) return true;
  return s.teamDefinition.members.some((m) => !!m.model);
}

function formatModel(m: { provider: string; id: string; name?: string }): string {
  return `${m.provider}/${m.id}`;
}

function currentModelRef(ctx: ExtensionCommandContext): string | undefined {
  return ctx.model ? formatModel(ctx.model) : undefined;
}

/**
 * /team setting — 团队设置交互菜单（阶段 4：作用域改造）。
 *
 * 顶层菜单：
 *   ① 设置作用域（●仅当前会话（临时）/ 全局）——一次 select 往返切换，切换后
 *      重新显示菜单；临时入口在 sessionManager 不可用/空 sessionId 时禁用（fail-open）。
 *   ②-⑥ 五项设置——「当前值」恒显示 merge 后生效值（global + overlay 深合并），
 *      有覆盖的键带 [临时] 徽标；模型项在团队 YAML 指定 model 时附注「此设置不生效」。
 *   ⑦ 清除全部临时设置（仅 overlay 非空时显示）——内存 + 绑定快照双清（S7）。
 *
 * 子菜单路由：作用域=临时 → 工作对象为 effective（显示与编辑一致），每次变更
 * 经 persist 写入 overlay（setSessionSetting/clearSessionSetting，undefined =
 * 恢复全局）；作用域=全局 → 工作对象为磁盘全局，persist 直写 settings.yaml。
 * 复用既有 configure* 函数，仅 save 目标参数化（零重复逻辑）。
 *
 * 通知文案按场景：团队活跃期「（仅当前 pi 会话生效；/team resume 本团队会话时将
 * 恢复）」；会话外「（仅当前 pi 会话生效，重启后失效）」；全局作用域无后缀。
 */
export async function handleSetting(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const rootDir = getRootDir();
  const global = loadSettings(rootDir);
  const overlay = getSessionSettings();
  // 临时入口可用性：需要当前 pi 会话标识（fail-open：不可用则强制全局）
  const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
  const tempAvailable = sessionId !== "";
  const activeTeamSession = getSessionState().active;
  const teamYamlNote = teamYamlSpecifiesModel()
    ? "团队 YAML 指定了 model，此设置不生效"
    : "";

  let scope: SettingScope = tempAvailable ? "temp" : "global";

  for (;;) {
    // 每次显示菜单时重算生效值（overlay 可能被子菜单/⑦变更）
    const effective = resolveEffectiveSettings(global, getSessionSettings());
    const badge = (key: keyof TeamSettings) =>
      overlay[key] !== undefined ? " [临时]" : "";

    const scopeItem = tempAvailable
      ? `${OPT_SCOPE}：${scope === "temp" ? "●" : ""}${SCOPE_LABEL.temp} / ${
          scope === "global" ? "●" : ""
        }${SCOPE_LABEL.global}`
      : `${OPT_SCOPE}：全局（临时设置不可用：无法获取当前 pi 会话）`;

    const items = [
      scopeItem,
      `${OPT_MEMBER_MODEL}（当前：${describeMemberModelSetting(effective, currentModelRef(ctx))}）${badge("memberModel")}${teamYamlNote ? `（${teamYamlNote}）` : ""}`,
      `${OPT_MEMBER_THINKING}（当前：${describeMemberThinkingSetting(effective)}）${badge("memberThinkingLevel")}`,
      `${OPT_AUTO_COMPACT}（当前：${describeAutoCompactSetting(effective)}）${badge("autoCompact")}`,
      `${OPT_WAIT_TIMEOUT}（当前：${describeWaitTimeoutSetting(effective)}）${badge("waitTimeoutMinutes")}`,
      `${OPT_COALESCE}（当前：${describeMessageCoalescingSetting(effective)}）${badge("messageCoalescing")}`,
      ...(Object.keys(overlay).length > 0 ? [`${OPT_CLEAR_ALL}（恢复全局）`] : []),
    ];

    const topChoice = await ctx.ui.select("团队设置（Esc 退出）", items);
    if (topChoice === undefined) return; // Esc

    if (topChoice.startsWith(OPT_SCOPE)) {
      if (!tempAvailable) {
        ctx.ui.notify(
          "临时设置不可用：无法获取当前 pi 会话（sessionManager 缺失或会话标识为空）。已使用全局设置。",
          "warning"
        );
        continue;
      }
      // 一次 select 往返切换，重新显示菜单
      scope = scope === "temp" ? "global" : "temp";
      ctx.ui.notify(`设置作用域已切换为「${SCOPE_LABEL[scope]}」。`, "info");
      continue;
    }

    if (topChoice.startsWith(OPT_CLEAR_ALL)) {
      // 内存 + 绑定快照双清（防「清了又复活」；活跃期快照随 clearAll 删除）
      clearAllSessionSettings();
      ctx.ui.notify("已清除全部临时设置，恢复全局设置生效。", "info");
      return;
    }

    // ── 子菜单：工作对象 + persist 按作用域分流 ──
    // 临时 → working = effective（显示 merge 后生效值，变更写 overlay，逐键 pin）；
    // 全局 → working = 磁盘全局对象（直改，persist 落盘）。仅 save 目标参数化。
    const working = scope === "temp" ? effective : global;
    const noticeSuffix =
      scope === "temp"
        ? activeTeamSession
          ? "（仅当前 pi 会话生效；/team resume 本团队会话时将恢复）"
          : "（仅当前 pi 会话生效，重启后失效）"
        : "";
    const persistFor = (key: keyof TeamSettings): (() => void) =>
      scope === "temp"
        ? () => {
            const v = working[key];
            if (v === undefined) {
              clearSessionSetting(key); // 恢复全局（如「思考强度：默认」）
            } else {
              setSessionSetting(key, v as DeepPartial<TeamSettings[typeof key]>);
            }
          }
        : () => saveSettings(working, rootDir);

    if (topChoice.startsWith(OPT_MEMBER_MODEL)) {
      await configureMemberModel(ctx, working, persistFor("memberModel"), noticeSuffix, teamYamlNote);
    } else if (topChoice.startsWith(OPT_MEMBER_THINKING)) {
      await configureMemberThinking(ctx, working, persistFor("memberThinkingLevel"), noticeSuffix);
    } else if (topChoice.startsWith(OPT_AUTO_COMPACT)) {
      await configureAutoCompact(ctx, working, persistFor("autoCompact"), noticeSuffix);
    } else if (topChoice.startsWith(OPT_WAIT_TIMEOUT)) {
      await configureWaitTimeout(ctx, working, persistFor("waitTimeoutMinutes"), noticeSuffix);
    } else if (topChoice.startsWith(OPT_COALESCE)) {
      await configureMessageCoalescing(ctx, working, persistFor("messageCoalescing"), noticeSuffix);
    }
    return;
  }
}

/** Parse a positive integer input; returns undefined on invalid input. */
function parsePositiveInt(text: string): number | undefined {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/** Parse a non-negative integer input (0 = unlimited is meaningful); undefined on invalid. */
function parseNonNegativeInt(text: string): number | undefined {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Auto-compaction submenu. Loops until Esc so multiple items can be
 * configured in one visit. Persists (overlay or disk, per scope) after every
 * change and surfaces the effective configuration (including the
 * default-fallback state).
 */
async function configureAutoCompact(
  ctx: ExtensionCommandContext,
  settings: TeamSettings,
  persist: () => void,
  noticeSuffix: string,
): Promise<void> {
  // Track whether the user has been told about the default fallback,
  // so the notice appears at most once per menu visit.
  let fallbackNotified = false;

  const saveAndMaybeNotifyFallback = (): void => {
    persist();
    const ac = settings.autoCompact;
    if (
      ac.enabled &&
      ac.thresholdPercent === undefined &&
      ac.thresholdTokens === undefined &&
      !fallbackNotified
    ) {
      fallbackNotified = true;
      ctx.ui.notify(
        `未配置任何阈值，自动压缩将使用默认阈值 ${DEFAULT_THRESHOLD_PERCENT}% 生效。${noticeSuffix}`,
        "info"
      );
    }
  };

  for (;;) {
    const ac = settings.autoCompact;
    const items = [
      `${AC_TOGGLE}（当前：${ac.enabled ? "开启" : "关闭"}）`,
      `${AC_SET_PERCENT}（当前：${ac.thresholdPercent !== undefined ? `${ac.thresholdPercent}%` : "未配置"}）`,
      `${AC_SET_TOKENS}（当前：${ac.thresholdTokens !== undefined ? `${ac.thresholdTokens}` : "未配置"}）`,
      `${AC_CLEAR_PERCENT}`,
      `${AC_CLEAR_TOKENS}`,
      `${AC_SET_TIMEOUT}（当前：${ac.timeoutMinutes} 分钟）`,
    ];
    const choice = await ctx.ui.select(
      `自动压缩 — 生效中：${describeAutoCompactSetting(settings)}（Esc 返回）`,
      items
    );
    if (choice === undefined) return; // Esc

    if (choice.startsWith(AC_TOGGLE)) {
      ac.enabled = !ac.enabled;
      saveAndMaybeNotifyFallback();
    } else if (choice.startsWith(AC_SET_PERCENT)) {
      const text = await ctx.ui.input("百分比阈值（1–100 的整数）", String(DEFAULT_THRESHOLD_PERCENT));
      if (text === undefined) continue; // Esc — no change
      const n = parsePositiveInt(text);
      if (n === undefined || n > 100) {
        ctx.ui.notify("无效输入：请输入 1–100 的整数。", "warning");
        continue;
      }
      ac.thresholdPercent = n;
      saveAndMaybeNotifyFallback();
    } else if (choice.startsWith(AC_SET_TOKENS)) {
      const text = await ctx.ui.input("token 阈值（正整数，如 150000）", "150000");
      if (text === undefined) continue;
      const n = parsePositiveInt(text);
      if (n === undefined) {
        ctx.ui.notify("无效输入：请输入正整数。", "warning");
        continue;
      }
      ac.thresholdTokens = n;
      saveAndMaybeNotifyFallback();
    } else if (choice.startsWith(AC_CLEAR_PERCENT)) {
      ac.thresholdPercent = undefined;
      saveAndMaybeNotifyFallback();
    } else if (choice.startsWith(AC_CLEAR_TOKENS)) {
      ac.thresholdTokens = undefined;
      saveAndMaybeNotifyFallback();
    } else if (choice.startsWith(AC_SET_TIMEOUT)) {
      const text = await ctx.ui.input("压缩等待超时（分钟，≥1）", String(ac.timeoutMinutes));
      if (text === undefined) continue;
      const n = parsePositiveInt(text);
      if (n === undefined) {
        ctx.ui.notify("无效输入：请输入 ≥1 的整数分钟数。", "warning");
        continue;
      }
      ac.timeoutMinutes = n;
      saveAndMaybeNotifyFallback();
    }
  }
}

/**
 * 消息合并子菜单（S1，阶段 2）：开关 + 批量上限 + 总字符上限。
 * 循环直至 Esc；每次变更即持久化（按作用域）。关闭时派发层完全走原逐条路径（fail-open）。
 */
async function configureMessageCoalescing(
  ctx: ExtensionCommandContext,
  settings: TeamSettings,
  persist: () => void,
  noticeSuffix: string,
): Promise<void> {
  for (;;) {
    const mc = resolveMessageCoalescing(settings);
    const items = [
      `${COALESCE_TOGGLE}（当前：${mc.enabled ? "开启" : "关闭"}）`,
      `${COALESCE_SET_SIZE}（当前：${mc.maxBatchSize} 条）`,
      `${COALESCE_SET_CHARS}（当前：${mc.maxBatchChars} 字符）`,
    ];
    const choice = await ctx.ui.select(
      `消息合并 — 生效中：${describeMessageCoalescingSetting(settings)}（Esc 返回）`,
      items
    );
    if (choice === undefined) return; // Esc

    if (choice.startsWith(COALESCE_TOGGLE)) {
      settings.messageCoalescing = {
        ...(settings.messageCoalescing ?? { enabled: true }),
        enabled: !mc.enabled,
      };
      persist();
      ctx.ui.notify(
        (mc.enabled
          ? "消息合并已关闭：成员消息恢复逐条立即派发。"
          : "消息合并已开启：接收方回合结束时积压消息合并为单条派发。") + noticeSuffix,
        "info"
      );
    } else if (choice.startsWith(COALESCE_SET_SIZE)) {
      const text = await ctx.ui.input("合并包最多条数（≥1 的整数）", String(mc.maxBatchSize));
      if (text === undefined) continue;
      const n = parsePositiveInt(text);
      if (n === undefined) {
        ctx.ui.notify("无效输入：请输入 ≥1 的整数。", "warning");
        continue;
      }
      settings.messageCoalescing = {
        ...(settings.messageCoalescing ?? { enabled: true }),
        maxBatchSize: n,
      };
      persist();
    } else if (choice.startsWith(COALESCE_SET_CHARS)) {
      const text = await ctx.ui.input("合并包总字符软上限（≥1 的整数）", String(mc.maxBatchChars));
      if (text === undefined) continue;
      const n = parsePositiveInt(text);
      if (n === undefined) {
        ctx.ui.notify("无效输入：请输入 ≥1 的整数。", "warning");
        continue;
      }
      settings.messageCoalescing = {
        ...(settings.messageCoalescing ?? { enabled: true }),
        maxBatchChars: n,
      };
      persist();
    }
  }
}

/**
 * 成员思考强度子菜单：选择一个思考级别（或「默认」不指定）。
 *
 * 语义：配置后，成员启动时若其生效模型支持该级别 → 以 `--thinking` 传给
 * member 进程；不支持（或无法判定支持集）→ 不传 flag，保持 pi 默认。
 * 仅影响之后启动的成员。
 */
const THINKING_DEFAULT_LABEL = "默认（不指定 — 使用 pi 对该模型的默认思考级别）";

async function configureMemberThinking(
  ctx: ExtensionCommandContext,
  settings: TeamSettings,
  persist: () => void,
  noticeSuffix: string,
): Promise<void> {
  const items = [
    THINKING_DEFAULT_LABEL,
    ...MEMBER_THINKING_LEVELS.map(
      (l) => (settings.memberThinkingLevel === l ? "● " : "") + l
    ),
  ];
  const choice = await ctx.ui.select(
    `成员思考强度（当前：${describeMemberThinkingSetting(settings)}）— 仅对之后启动的成员生效（Esc 返回）`,
    items
  );
  if (choice === undefined) return; // Esc

  if (choice === THINKING_DEFAULT_LABEL) {
    settings.memberThinkingLevel = undefined;
    persist();
    ctx.ui.notify(
      `成员思考强度已设为「默认（不指定）」。\n仅对之后启动的成员生效。${noticeSuffix}`,
      "info"
    );
    return;
  }

  // Strip the "● " current-marker prefix before matching
  const level = choice.replace(/^● /, "");
  if (!(MEMBER_THINKING_LEVELS as readonly string[]).includes(level)) return;
  settings.memberThinkingLevel = level as (typeof MEMBER_THINKING_LEVELS)[number];
  persist();
  ctx.ui.notify(
    `成员思考强度已设为「${level}」。\n模型不支持该级别的成员保持默认；仅对之后启动的成员生效。${noticeSuffix}`,
    "info"
  );
}

async function configureWaitTimeout(
  ctx: ExtensionCommandContext,
  settings: TeamSettings,
  persist: () => void,
  noticeSuffix: string,
): Promise<void> {
  const current = resolveWaitTimeoutMinutes(settings);
  const text = await ctx.ui.input(
    "等待上限（分钟，0 = 永不超时）",
    String(current)
  );
  if (text === undefined) return; // Esc — no change
  const n = parseNonNegativeInt(text);
  if (n === undefined) {
    ctx.ui.notify("无效输入：请输入 ≥0 的整数分钟数（0 = 永不超时）。", "warning");
    return;
  }
  settings.waitTimeoutMinutes = n;
  persist();
  ctx.ui.notify(
    (n === 0
      ? "等待上限已设为「不限」：wait 工具与批屏障永不超时（恢复原始语义）。"
      : `等待上限已设为 ${n} 分钟：wait 工具在超时后返回诊断，批屏障在超预算后直接派发。`) + noticeSuffix,
    "info"
  );
}

async function configureMemberModel(
  ctx: ExtensionCommandContext,
  settings: TeamSettings,
  persist: () => void,
  noticeSuffix: string,
  teamYamlNote: string,
): Promise<void> {
  const tlModel = currentModelRef(ctx);

  // ── Mode selection ──────────────────────────────────────
  const tlSuffix = tlModel ? `，当前：${tlModel}` : "（TL 当前模型未设置）";
  const followLabel =
    (settings.memberModel.mode === "follow" ? "● " : "") +
    `${OPT_FOLLOW}${tlModel ? `（成员启动时使用 TL 当前模型：${tlModel}）` : "（成员启动时使用 TL 当前模型）"}`;
  const fixedLabel = settings.memberModel.mode === "fixed" && settings.memberModel.model
    ? `● ${OPT_FIXED}（当前：${settings.memberModel.model}）`
    : `${OPT_FIXED}…`;

  const modeChoice = await ctx.ui.select(
    `成员默认模型 — 仅对之后启动的成员生效${teamYamlNote ? `（${teamYamlNote}）` : ""}（Esc 返回）`,
    [followLabel, fixedLabel]
  );
  if (modeChoice === undefined) return; // Esc

  // ── Follow mode ─────────────────────────────────────────
  if (modeChoice.includes(OPT_FOLLOW)) {
    settings.memberModel = { mode: "follow" };
    persist();
    ctx.ui.notify(
      `成员默认模型已设为「跟随当前配置」${tlSuffix}。\n仅对之后启动的成员生效。${noticeSuffix}`,
      "info"
    );
    return;
  }

  // ── Fixed mode: pick from available (logged-in) models ──
  const available = ctx.modelRegistry.getAvailable();
  if (available.length === 0) {
    ctx.ui.notify("没有可用的已登录模型。请先在 pi 中登录模型提供商。", "warning");
    return;
  }

  const currentFixed = settings.memberModel.mode === "fixed" ? settings.memberModel.model : undefined;
  const items = available.map((m) => {
    const ref = formatModel(m);
    const isCurrent = ref === currentFixed;
    const isTl = ctx.model && ref === formatModel(ctx.model);
    return {
      value: ref,
      label: (isCurrent ? "● " : "") + ref,
      description: `${m.name}${isTl ? " · TL 当前" : ""}`,
      searchText: `${m.provider} ${m.id} ${m.name}`,
    };
  });

  // Scrollable + filterable picker (built-in ctx.ui.select renders ALL options
  // without scrolling — unusable for 100+ models)
  const pickedRef = await scrollSelect(ctx, {
    title: "指定成员默认模型（Esc 返回）",
    items,
    maxVisible: 10,
    initialValue: currentFixed,
  });
  if (pickedRef === undefined) return; // Esc

  const picked = available.find((m) => formatModel(m) === pickedRef);
  if (!picked) return;

  settings.memberModel = { mode: "fixed", model: formatModel(picked) };
  persist();
  ctx.ui.notify(
    `成员默认模型已设为「${formatModel(picked)}」。\n仅对之后启动的成员生效；团队成员 YAML 中的 model/defaults.model 优先级更高。${noticeSuffix}`,
    "info"
  );
}
