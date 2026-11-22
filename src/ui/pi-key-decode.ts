// ── decodePrintableKey 本地实现（替代 pi-tui 深导入）───────────────────────
//
// 背景：字符插入路径必须经 decodePrintableKey（与 pi 主输入框 editor.js 一致），
// 它覆盖 kitty CSI-u + modifyOtherKeys 两种协议。pi-tui 主 index 只 re-export
// `decodeKittyPrintable`，`decodePrintableKey` 在 `dist/keys.js` 内部——过去深导入
// `@earendil-works/pi-tui/dist/keys.js`。
//
// 为什么不能深导入（2025 实测根因）：pi 的扩展加载器（dist/core/extensions/
// loader.js）用 jiti 的 alias 前缀替换解析扩展依赖：`"@earendil-works/pi-tui"`
// → `<...>/pi-tui/dist/index.js`（包 main）。任何子路径导入都会被拼接到 main 后，
// `@earendil-works/pi-tui/dist/keys.js` → `<...>/pi-tui/dist/index.js/dist/keys.js`
// → Cannot find module → 整个扩展加载失败（"Failed to load extension"）。该 loader
// 只对裸包名做别名/虚拟模块映射，子路径导入在 Bun 二进制模式（virtualModules）与
// Node 模式（alias）下均不支持。
//
// 修复：`decodePrintableKey` = `decodeKittyPrintable`（主入口已导出，安全）∪
// `decodeModifyOtherKeysPrintable`（pi-tui 私有，~15 行）。此处按 pi-tui
// dist/keys.js 原样复刻后者（0.83.0 与 0.84.2 逐字节一致，diff 验证），
// 行为与上游 editor 完全对齐（一致性即正确性）；上游若变更此处需同步核对。
import { decodeKittyPrintable } from "@earendil-works/pi-tui";

const MODIFIERS = {
  shift: 1,
  alt: 2,
  ctrl: 4,
  super: 8,
};
const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

/** xterm modifyOtherKeys 格式：CSI 27 ; modifiers ; keycode ~（modifiers 1-indexed） */
function parseModifyOtherKeysSequence(
  data: string,
): { codepoint: number; modifier: number } | null {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match) return null;
  const modValue = parseInt(match[1], 10);
  const codepoint = parseInt(match[2], 10);
  return { codepoint, modifier: modValue - 1 };
}

/** 仅接受纯字符/Shift 修饰的 modifyOtherKeys 序列；ctrl/alt/其他修饰返回 undefined */
function decodeModifyOtherKeysPrintable(data: string): string | undefined {
  const parsed = parseModifyOtherKeysSequence(data);
  if (!parsed) return undefined;
  const modifier = parsed.modifier & ~LOCK_MASK;
  if ((modifier & ~MODIFIERS.shift) !== 0) return undefined;
  if (!Number.isFinite(parsed.codepoint) || parsed.codepoint < 32) return undefined;
  try {
    return String.fromCodePoint(parsed.codepoint);
  } catch {
    return undefined;
  }
}

/**
 * 解码终端输入为可插入字符（若有）。
 *
 * 仅接受纯字符/Shift 字符：kitty CSI-u 与 modifyOtherKeys 两种协议；
 * ctrl/alt 修饰序列与 legacy 原字符返回 undefined（由调用方走原兜底路径）。
 */
export function decodePrintableKey(data: string): string | undefined {
  return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}

/**
 * Shift + 基础键打出的符号。kitty 与 xterm modifyOtherKeys 都可能报「基础码位 +
 * shift」（`CSI 47;2u` / `CSI 27;2;47~` = Shift+`/`），而用户实际打出的是 `?`。
 * 两套协议的同一假设必须一致，否则同一次按键的两种编码行为不同。
 */
const SHIFTED_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({ "/": "?" });

/** kitty CSI-u：`CSI code[:alternates];modifiers[:event];text u` 的键码/修饰/事件部分。 */
const KITTY_COMMAND = /^\x1b\[(\d+)(?::[\d:]*)?;(\d+)(?::(\d+))?u$/;
/** kitty 无修饰形态：`CSI code[:alternates]u`（交给 decodePrintableKey 即可）。 */
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;
/** kitty 事件类型：1 = press、2 = repeat、3 = release。命令键只认 press。 */
const KITTY_EVENT_PRESS = 1;
const KITTY_EVENT_RELEASE = 3;

/** 修饰位只允许 Shift（+ Caps/Num Lock）；其他修饰返回 undefined。 */
function shiftOnly(modifier: number): boolean | undefined {
  const masked = modifier & ~LOCK_MASK;
  if ((masked & ~MODIFIERS.shift) !== 0) return undefined;
  return (masked & MODIFIERS.shift) !== 0;
}

function charAt(codepoint: number): string | undefined {
  if (!Number.isFinite(codepoint) || codepoint < 32) return undefined;
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return undefined;
  }
}

function shifted(char: string, shift: boolean): string {
  return shift ? SHIFTED_SYMBOLS[char] ?? char : char;
}

/**
 * 命令键的有效字符（决策 #14 的字符路径纪律：命令键也必须走解码，不能只认
 * legacy 字面量）。相对 `decodePrintableKey`（文本插入的单一事实来源，保持不动）
 * 只多两件事：
 *   1. 接受 kitty 的 `:<event>` 后缀（pi 请求 flags=7，按键是 `CSI 47;2:1u`），
 *      且**只认 press（事件 1）**：release（3）不是按键输入，repeat（2）会让按住
 *      `?` 反复开关图例。注意这是本键自己的取舍，不要当成与 `e`/`t` 的一致性论据
 *      ——`matchesKey` 对 repeat 序列（如 `CSI 101;1:2u`）同样返回 true，`?` 比它们
 *      更严格；
 *   2. 把「Shift + 基础符号」归一成用户实际打出的字符（`/` → `?`），kitty 与
 *      modifyOtherKeys 同一处理，不对美式布局做自相矛盾的假设。
 * legacy 原字符仍返回 undefined，由调用方用 `matchesKey` 兜底。
 */
export function decodeCommandChar(data: string): string | undefined {
  const kitty = KITTY_COMMAND.exec(data);
  if (kitty) {
    const event = kitty[3] === undefined ? KITTY_EVENT_PRESS : Number(kitty[3]);
    if (event !== KITTY_EVENT_PRESS) return undefined;
    const shift = shiftOnly(Number(kitty[2]) - 1);
    if (shift === undefined) return undefined;
    const char = charAt(Number(kitty[1]));
    return char === undefined ? undefined : shifted(char, shift);
  }
  const other = MODIFY_OTHER_KEYS.exec(data);
  if (other) {
    const shift = shiftOnly(Number(other[1]) - 1);
    if (shift === undefined) return undefined;
    const char = charAt(Number(other[2]));
    return char === undefined ? undefined : shifted(char, shift);
  }
  return decodePrintableKey(data);
}
