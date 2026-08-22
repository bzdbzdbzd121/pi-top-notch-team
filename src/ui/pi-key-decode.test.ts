import { describe, it, expect } from "vitest";
import { decodePrintableKey } from "./pi-key-decode";

// ── decodePrintableKey 本地实现（pi-key-decode.ts）测试 ────────────────────
// 行为锁定：与 pi-tui dist/keys.js 的 decodePrintableKey 逐字节一致
// （0.83.0 与 0.84.2 diff 验证过）。任何上游行为变更需在此同步。

describe("decodePrintableKey — kitty CSI-u", () => {
  it("纯字符 CSI-u 解码（按 a → \\x1b[97u → 'a'）", () => {
    expect(decodePrintableKey("\x1b[97u")).toBe("a");
  });

  it("Shift 修饰字符解码（\\x1b[65;1u → 'A'）", () => {
    expect(decodePrintableKey("\x1b[65;1u")).toBe("A");
  });

  it("Shift 且上报 shifted keycode 时优先 shifted（\\x1b[65:2u → 'A'）", () => {
    expect(decodePrintableKey("\x1b[65:2u")).toBe("A");
  });

  it("alt 修饰序列拒绝（\\x1b[97;3u → undefined，不劫持 ctrl/alt 分支）", () => {
    expect(decodePrintableKey("\x1b[97;3u")).toBeUndefined();
  });

  it("ctrl 修饰序列拒绝（\\x1b[97;5u → undefined）", () => {
    expect(decodePrintableKey("\x1b[97;5u")).toBeUndefined();
  });

  it("super 修饰序列拒绝（\\x1b[97;9u → undefined）", () => {
    expect(decodePrintableKey("\x1b[97;9u")).toBeUndefined();
  });

  it("Caps Lock 位掩码忽略（\\x1b[97;65u → 'a'，LOCK_MASK=64+128 剥离）", () => {
    expect(decodePrintableKey("\x1b[97;65u")).toBe("a");
  });

  it("控制字符拒绝（\\x1b[9u → undefined）", () => {
    expect(decodePrintableKey("\x1b[9u")).toBeUndefined();
  });

  it("非 CSI-u 序列 → undefined（走 legacy 兜底路径）", () => {
    expect(decodePrintableKey("\x1b[D")).toBeUndefined();
  });
});

describe("decodePrintableKey — xterm modifyOtherKeys", () => {
  it("纯字符（\\x1b[27;1;97~ → 'a'）", () => {
    expect(decodePrintableKey("\x1b[27;1;97~")).toBe("a");
  });

  it("Shift 修饰（\\x1b[27;2;65~ → 'A'）", () => {
    expect(decodePrintableKey("\x1b[27;2;65~")).toBe("A");
  });

  it("alt 修饰拒绝（\\x1b[27;3;97~ → undefined）", () => {
    expect(decodePrintableKey("\x1b[27;3;97~")).toBeUndefined();
  });

  it("ctrl 修饰拒绝（\\x1b[27;5;97~ → undefined）", () => {
    expect(decodePrintableKey("\x1b[27;5;97~")).toBeUndefined();
  });

  it("Caps Lock 位掩码忽略（\\x1b[27;65;97~ → 'a'）", () => {
    expect(decodePrintableKey("\x1b[27;65;97~")).toBe("a");
  });

  it("控制字符拒绝（\\x1b[27;1;9~ → undefined）", () => {
    expect(decodePrintableKey("\x1b[27;1;9~")).toBeUndefined();
  });

  it("非 modifyOtherKeys 格式 → undefined", () => {
    expect(decodePrintableKey("\x1b[27;2;97u")).toBeUndefined();
  });
});

describe("decodePrintableKey — legacy 原字符", () => {
  it("原字符不经解码（'a' → undefined，插入分支走兜底）", () => {
    expect(decodePrintableKey("a")).toBeUndefined();
    expect(decodePrintableKey("\r")).toBeUndefined();
  });
});
