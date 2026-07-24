import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getRootDir } from "../../config";
import {
  loadSettings,
  saveSettings,
  describeMemberModelSetting,
  type TeamSettings,
} from "../../settings/settings";
import { scrollSelect } from "../../ui/scroll-select";

/** Menu option identifiers (suffix after the emoji prefix is matched loosely). */
const OPT_MEMBER_MODEL = "成员默认模型";
const OPT_FOLLOW = "跟随当前配置";
const OPT_FIXED = "指定模型";

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
    ]
  );
  if (topChoice === undefined) return; // Esc

  if (topChoice.startsWith(OPT_MEMBER_MODEL)) {
    await configureMemberModel(ctx, settings, rootDir);
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
