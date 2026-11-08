import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Maximum display width of a team name, in terminal columns (CJK counts as 2).
 * Aligned with the status-bar title budget (`min(20, width / 4)`), so an
 * accepted name is never necessarily truncated.
 */
export const TEAM_NAME_MAX_WIDTH = 20;

/** Placeholder rendered in the UI while the session still carries the synthetic fallback name. */
export const UNNAMED_TEAM_DISPLAY = "未命名团队";

export type TeamNameResult =
  | { ok: true; name: string; adjusted: boolean }
  | { ok: false; reason: string };

/**
 * Reserved namespace for the system-generated fallback name (`_dynamic_<ts>`).
 * User names can never match it: the rules require the first character to be a
 * letter or digit, so "unnamed" is derivable without an extra state field.
 */
const SYNTHETIC_PREFIX = "_dynamic_";

/** Allowed characters: any letter, decimal digits, hyphen, underscore. */
const ALLOWED_NAME_RE = /^[\p{L}\p{Nd}_-]+$/u;
const ALLOWED_CHAR_RE = /^[\p{L}\p{Nd}_-]$/u;
const ALNUM_CHAR_RE = /^[\p{L}\p{Nd}]$/u;

/** Space separators only (U+0020, NBSP, ideographic space, …) — never tabs or newlines. */
const SPACE_SEPARATOR_RUN_RE = /\p{Zs}+/gu;

const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * One-sentence description of the naming rules.
 * Shared by tool error messages and prompt interpolation so the two never drift.
 */
export function describeTeamNameRules(): string {
  return [
    "团队名规则：只能使用中文、其他语言的字母、数字、连字符（-）与下划线（_）",
    `必须以字母或数字开头并结尾，最多 ${TEAM_NAME_MAX_WIDTH} 个显示列（中文按 2 列计）`,
    "不能是 Windows 预留设备名（CON、PRN、AUX、NUL、COM1-9、LPT1-9）",
    "空格会折成 -，其他字符不会被静默删除",
  ].join("；") + "。";
}

function reject(cause: string): TeamNameResult {
  // Plan: rejections state the specific cause *and* the rules (single source of truth).
  return { ok: false, reason: `${cause}\n${describeTeamNameRules()}` };
}

/** Render a character for an error message: control chars as code points, the rest quoted. */
function describeChar(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  const isControl = /\p{Cc}|\p{Cf}|\p{Cs}/u.test(char);
  return isControl ? `U+${cp.toString(16).toUpperCase().padStart(4, "0")}` : `「${char}」`;
}

function describeIllegalChars(name: string): string {
  const illegal = [...new Set([...name].filter((char) => !ALLOWED_CHAR_RE.test(char)))];
  const shown = illegal.slice(0, 5).map(describeChar).join("、");
  return illegal.length > 5 ? `${shown} 等` : shown;
}

/**
 * Normalize and validate a user-supplied team name.
 *
 * Pipeline (no silent character deletion): NFC → trim → fold space runs to `-`
 * → whitelist → first/last character → display width → Windows device names.
 * NFKC is deliberately NOT applied (`①` → `1`, `㎏` → `kg` would rewrite the name).
 */
export function normalizeTeamName(raw: unknown): TeamNameResult {
  if (typeof raw !== "string") {
    return reject("团队名必须是文本。");
  }

  const name = raw.normalize("NFC").trim().replace(SPACE_SEPARATOR_RUN_RE, "-");
  if (!name) {
    return reject("团队名不能为空。");
  }
  if (!ALLOWED_NAME_RE.test(name)) {
    return reject(`团队名包含不允许的字符：${describeIllegalChars(name)}。`);
  }

  const chars = [...name];
  if (!ALNUM_CHAR_RE.test(chars[0]) || !ALNUM_CHAR_RE.test(chars[chars.length - 1])) {
    return reject(`团队名必须以字母或数字开头并结尾（当前：${name}）。`);
  }

  const width = visibleWidth(name);
  if (width > TEAM_NAME_MAX_WIDTH) {
    return reject(`团队名过长：${width} 显示列，上限 ${TEAM_NAME_MAX_WIDTH} 列（中文按 2 列计）。`);
  }

  if (RESERVED_DEVICE_NAMES.has(name.toUpperCase())) {
    return reject(`「${name}」是 Windows 预留设备名，不能用作团队名。`);
  }

  return { ok: true, name, adjusted: name !== raw };
}

/**
 * Whether the name is still the system fallback name (i.e. the team is unnamed).
 * Accepted user names can never hit this (they must start with a letter or digit).
 */
export function isSyntheticTeamName(name: string): boolean {
  return typeof name === "string" && name.startsWith(SYNTHETIC_PREFIX);
}
