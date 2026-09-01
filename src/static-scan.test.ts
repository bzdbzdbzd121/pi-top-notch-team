import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 仓库根（test 文件位于 src/ 下）。 */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 阶段 5 防退化守卫（R4）：静态扫描 `loadSettings(` 调用点——除白名单模块外，
 * 所有生产代码的全局设置读取必须经合并层（getEffectiveSettings /
 * loadEffectiveSettings），否则临时设置（per-session overlay）会被静默绕过。
 *
 * 白名单（含理由）：
 * - settings.ts            settings 定义层（loadSettings 声明处）。
 * - session-settings.ts    merge 层 + 快照机制（方案白名单：快照读写内部
 *                          loadSettings 模式属合法路径）。
 * - setting-handler.ts     设置编辑器：菜单需同时读 global 与 overlay 以构建
 *                          UI（非设置消费点，本身即 merge 层的维护者）。
 *
 * member-lifecycle.ts 不含裸 loadSettings——其 options.settings 缺省回退已
 * 改为 loadEffectiveSettings（合并感知，阶段 5），杜绝「忘记传 settings 静默
 * 回退全局」的 R4 漏洞。
 */
const WHITELIST: Record<string, string> = {
  "src/settings/settings.ts": "settings 定义层（loadSettings 声明处）",
  "src/settings/session-settings.ts":
    "merge 层 + 快照机制（方案白名单：快照读写内部 loadSettings 模式属合法路径）",
  "src/commands/handlers/setting-handler.ts":
    "设置编辑器：菜单需同时读 global 与 overlay 构建 UI（非设置消费点）",
};

export interface ScanViolation {
  file: string;
  count: number;
}

/** 扫描 root 下所有生产 .ts 文件（排除 *.test.ts、test 目录、node_modules 与 dist 构建产物），返回裸 loadSettings 违规。 */
export function scanLoadSettingsConsumers(root: string): ScanViolation[] {
  const violations: ScanViolation[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "test" || entry.name === "node_modules" || entry.name === "dist") continue;
        walk(join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const source = readFileSync(join(dir, entry.name), "utf-8");
        const matches = source.match(/\bloadSettings\(/g);
        if (matches && matches.length > 0 && !WHITELIST[rel]) {
          violations.push({ file: rel, count: matches.length });
        }
      }
    }
  };
  walk(root, "");
  return violations;
}

describe("静态扫描守卫（阶段 5）：所有 loadSettings 消费点必须经合并层", () => {
  it("生产代码中除白名单模块外无裸 loadSettings 调用点", () => {
    const violations = scanLoadSettingsConsumers(REPO_ROOT);
    expect(violations).toEqual([]);
  });

  it("白名单模块内确实存在 loadSettings 调用（白名单非空壳）", () => {
    for (const file of Object.keys(WHITELIST)) {
      const source = readFileSync(join(REPO_ROOT, file), "utf-8");
      expect(source, `${file} 应含 loadSettings(`).toMatch(/\bloadSettings\(/);
    }
  });

  it("人为新增绕过消费点 → 违规（负例 fixture：文件级）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-guard-"));
    try {
      writeFileSync(join(tmp, "index.ts"), "const s = loadSettings(root);\n");
      mkdirSync(join(tmp, "src", "tools"), { recursive: true });
      writeFileSync(join(tmp, "src", "tools", "new-consumer.ts"), "const s = loadSettings(root);\n");
      const hits = scanLoadSettingsConsumers(tmp);
      expect(hits).toHaveLength(2);
      expect(hits).toEqual(
        expect.arrayContaining([
          { file: "index.ts", count: 1 },
          { file: "src/tools/new-consumer.ts", count: 1 },
        ])
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loadEffectiveSettings 不是 loadSettings 消费点（子串安全，不误报）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-guard-"));
    try {
      writeFileSync(join(tmp, "consumer.ts"), "const s = loadEffectiveSettings(root);\n");
      expect(scanLoadSettingsConsumers(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("测试文件不受守卫约束（排除 *.test.ts）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-guard-"));
    try {
      writeFileSync(join(tmp, "foo.test.ts"), "const s = loadSettings(root);\n");
      expect(scanLoadSettingsConsumers(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("构建产物目录被排除（dist 内 .d.ts 的 loadSettings 字样不误报）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-guard-"));
    try {
      mkdirSync(join(tmp, "dist", "src", "settings"), { recursive: true });
      writeFileSync(
        join(tmp, "dist", "src", "settings", "settings.d.ts"),
        "export declare function loadSettings(root: string): TeamSettings;\n"
      );
      // 真正的源码仍受守卫约束（dist 排除不豁免 src）
      mkdirSync(join(tmp, "src"), { recursive: true });
      writeFileSync(join(tmp, "src", "consumer.ts"), "const s = loadSettings(root);\n");
      expect(scanLoadSettingsConsumers(tmp)).toEqual([{ file: "src/consumer.ts", count: 1 }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
