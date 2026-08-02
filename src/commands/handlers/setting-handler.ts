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
import { scrollSelect } from "../../ui/scroll-select";

/** Menu option identifiers (suffix after the emoji prefix is matched loosely). */
const OPT_MEMBER_MODEL = "成员默认模型";
const OPT_AUTO_COMPACT = "自动压缩";
const OPT_FOLLOW = "跟随当前配置";
const OPT_FIXED = "指定模型";

// Auto-compaction submenu options
const AC_TOGGLE = "开关切换";
const AC_SET_PERCENT = "设置百分比阈值";
const AC_SET_TOKENS = "设置 token 阈值";
const AC_CLEAR_PERCENT = "清除百分比阈值";
const AC_CLEAR_TOKENS = "清除 token 阈值";
const AC_SET_TIMEOUT = "设置超时（分钟）";

function formatModel(m: { provider: string; id: string; name?: string }): string {
  return `${m.provider}/${m.id}`;
}

function currentModelRef(ctx: ExtensionCommandContext): string | undefined {
  return ctx.model ? formatModel(ctx.model) : undefined;
}

/**
 * /team setting — Interactive settings menu for team sessions.
 *
 * Currently supports:
 *   - 成员默认模型: "follow" (member uses TL's current model at spawn time)
 *                   or "fixed" (one of pi's available/logged-in models)
 *
 * The setting only affects members started AFTER the change; already-running
 * member processes keep the model they were spawned with.
 */
export async function handleSetting(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const rootDir = getRootDir();
  const settings = loadSettings(rootDir);

  // ── Top-level menu ──────────────────────────────────────
  const topChoice = await ctx.ui.select(
    "团队设置（Esc 退出）",
    [
      `${OPT_MEMBER_MODEL}（当前：${describeMemberModelSetting(settings, currentModelRef(ctx))}）`,
      `${OPT_AUTO_COMPACT}（当前：${describeAutoCompactSetting(settings)}）`,
    ]
  );
  if (topChoice === undefined) return; // Esc

  if (topChoice.startsWith(OPT_MEMBER_MODEL)) {
    await configureMemberModel(ctx, settings, rootDir);
  } else if (topChoice.startsWith(OPT_AUTO_COMPACT)) {
    await configureAutoCompact(ctx, settings, rootDir);
  }
}

/** Parse a positive integer input; returns undefined on invalid input. */
function parsePositiveInt(text: string): number | undefined {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/**
 * Auto-compaction submenu. Loops until Esc so multiple items can be
 * configured in one visit. Saves after every change and surfaces the
 * effective configuration (including the default-fallback state).
 */
async function configureAutoCompact(
  ctx: ExtensionCommandContext,
  settings: TeamSettings,
  rootDir: string,
): Promise<void> {
  // Track whether the user has been told about the default fallback,
  // so the notice appears at most once per menu visit.
  let fallbackNotified = false;

  const saveAndMaybeNotifyFallback = (): void => {
    saveSettings(settings, rootDir);
    const ac = settings.autoCompact;
    if (
      ac.enabled &&
      ac.thresholdPercent === undefined &&
      ac.thresholdTokens === undefined &&
      !fallbackNotified
    ) {
      fallbackNotified = true;
      ctx.ui.notify(
        `未配置任何阈值，自动压缩将使用默认阈值 ${DEFAULT_THRESHOLD_PERCENT}% 生效。`,
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

async function configureMemberModel(
  ctx: ExtensionCommandContext,
  settings: TeamSettings,
  rootDir: string,
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
    "成员默认模型 — 仅对之后启动的成员生效（Esc 返回）",
    [followLabel, fixedLabel]
  );
  if (modeChoice === undefined) return; // Esc

  // ── Follow mode ─────────────────────────────────────────
  if (modeChoice.includes(OPT_FOLLOW)) {
    settings.memberModel = { mode: "follow" };
    saveSettings(settings, rootDir);
    ctx.ui.notify(
      `成员默认模型已设为「跟随当前配置」${tlSuffix}。\n仅对之后启动的成员生效。`,
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
  saveSettings(settings, rootDir);
  ctx.ui.notify(
    `成员默认模型已设为「${formatModel(picked)}」。\n仅对之后启动的成员生效；团队成员 YAML 中的 model/defaults.model 优先级更高。`,
    "info"
  );
}
