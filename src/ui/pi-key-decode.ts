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
