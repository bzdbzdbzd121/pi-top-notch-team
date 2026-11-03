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

// ────────────────────────────────────────────────────────────────
// 绝对化历史断言扫描（决策 #47，阶段 4）
//
// 背景：会话切换提示有「声明权威」的职责，唯一验证过的做法是把历史断言**双重限定**
// ——只针对 ①进入本会话之前的记录，②与本提示冲突的做法。反过来，断言「历史里的自分析
// 都发生在进入之前」在同一团队会话内是假的（设计阶段 read、.md 写入、resume 恢复的
// 历史都发生在会话内），而一段包含假命题的提示会被模型整段折扣，反而削弱权威。
//
// 扫描范围（生产源码，零文件级豁免）：
// - `index.ts`：退场横幅（模型可见文本，内联在模板字符串里）
// - `src/prompts/*.ts`：全部提示词模块（声明、进入通知、各模式 TL 提示词、共享片段）
//
// 排除：`*.test.ts`（测试需要写负例断言）与 `test/` 目录、`node_modules`、`dist`。
//
// 豁免规则：**不提供文件级豁免**。退场横幅里的「成功调用都发生在会话结束之前」是对
// 已结束会话的事实陈述（teardown 之后才注入，会话确已结束），不匹配下列模式，因此无需
// 豁免；若将来某个文件真的命中，正确做法是改写文案（限定为进入前 / 冲突情形），而不是
// 往这里加例外——一份可豁免的守卫等于没有守卫。
const ABSOLUTE_HISTORY_CLAIM_PATTERNS: Array<{ id: string; pattern: RegExp; why: string }> = [
  {
    id: "pre-entry-claim",
    // 「都/均/全部发生在进入(团队会话)之前」——同一会话内的合法记录会使该断言为假
    pattern: /(都|均|全部)发生在进入/,
    why: "把整个历史断言成进入之前；应限定为「进入本会话之前留下的做法」",
  },
  {
    id: "quantifier-before-noun",
    // 前置量词修饰「历史/记录」
    pattern: /(所有|全部|一切)[^。\n]{0,12}(历史|记录)/,
    why: "前置量词（所有/全部/一切）修饰历史或记录",
  },
  {
    id: "quantifier-after-noun",
    // 后置量词（建议 2）：名词在前、量词在后，如「历史里的做法都…」「记录无一例外…」
    pattern: /(历史|记录)[^\n]{0,10}(都|全部|一律|无一例外)/,
    why: "后置量词（都/全部/一律/无一例外）修饰历史或记录",
  },
];

/** 扫描一个文件源码，返回命中的绝对化历史断言（含行号，便于定位）。 */
export function scanAbsoluteHistoryClaims(
  source: string,
  file = "<memory>",
): Array<{ file: string; line: number; id: string; match: string; why: string }> {
  const hits: Array<{ file: string; line: number; id: string; match: string; why: string }> = [];
  for (const { id, pattern, why } of ABSOLUTE_HISTORY_CLAIM_PATTERNS) {
    for (const m of source.matchAll(new RegExp(pattern.source, "g"))) {
      const line = source.slice(0, m.index ?? 0).split("\n").length;
      hits.push({ file, line, id, match: m[0], why });
    }
  }
  return hits;
}

/** 生产源码中受扫描的文件（相对仓库根）。 */
function absoluteClaimScanTargets(root: string): string[] {
  const promptsDir = join(root, "src", "prompts");
  const promptFiles = readdirSync(promptsDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `src/prompts/${name}`);
  return ["index.ts", ...promptFiles];
}

describe("静态扫描守卫（决策 #47）：提示词与退场横幅不得含绝对化历史断言", () => {
  it("生产提示词源码零命中（index.ts + src/prompts/*.ts）", () => {
    const violations = absoluteClaimScanTargets(REPO_ROOT).flatMap((file) =>
      scanAbsoluteHistoryClaims(readFileSync(join(REPO_ROOT, file), "utf-8"), file),
    );
    // 打印全部命中以便定位（vitest 断言失败时只显示数量）
    expect(violations.map((v) => `${v.file}:${v.line} [${v.id}] ${v.match}`)).toEqual([]);
  });

  it("守卫非空壳：扫描目标覆盖退场横幅与进入通知两个方向", () => {
    const targets = absoluteClaimScanTargets(REPO_ROOT);
    expect(targets).toContain("index.ts");
    expect(targets).toContain("src/prompts/session-transition-notice.ts");
    // 声明模块确实含被扫描的提示词文本（否则「零命中」没有意义）
    const noticeSource = readFileSync(join(REPO_ROOT, "src/prompts/session-transition-notice.ts"), "utf-8");
    expect(noticeSource).toContain("进入本会话之前");
    expect(noticeSource).toContain("与本提示冲突");
  });

  it("负例：每种模式都能被检出（前置/后置量词 + 进入前断言）", () => {
    const cases: Array<[string, string]> = [
      ["pre-entry-claim", "历史里你亲自分析代码的记录都发生在进入之前。"],
      ["quantifier-before-noun", "所有历史记录都属于普通模式。"],
      ["quantifier-after-noun", "对话历史里我亲自分析的记录都算普通模式。"],
    ];
    for (const [id, text] of cases) {
      const hits = scanAbsoluteHistoryClaims(text);
      expect(hits.map((h) => h.id), text).toContain(id);
    }
  });

  it("负例：报告包含文件与行号（可直接定位到违规行）", () => {
    // 一个句子可以同时命中前置与后置量词两种模式（「所有历史记录…都…」），
    // 因此只断言「至少命中 + 每条都带正确文件/行号」。
    const hits = scanAbsoluteHistoryClaims("line one\n所有历史记录都属于普通模式。\n", "prompt.ts");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    for (const hit of hits) {
      expect(hit.file).toBe("prompt.ts");
      expect(hit.line).toBe(2);
      expect(hit.why).toContain("量词");
    }
    expect(hits.map((h) => h.id)).toContain("quantifier-before-noun");
  });

  it("不误报：限定写法与退场横幅的事实陈述都不命中", () => {
    const legitimate = [
      // 双重限定（本特性的标准写法）
      "历史里**进入本会话之前**留下的做法属于普通模式，不构成本回合的授权；与本提示冲突的做法以本提示为准。",
      // 退场横幅：对已结束会话的事实陈述
      "你在历史记录里看到的 write_shared_context、start_member 等成功调用都发生在会话结束**之前**。",
      "对话历史中任何团队会话的痕迹均已失效，一律以本提示为准。",
      // 与历史无关的绝对量词（派发范围）
      "完整的分析、排查、代码理解一律派发。",
    ];
    for (const text of legitimate) {
      expect(scanAbsoluteHistoryClaims(text), text).toEqual([]);
    }
  });

  it("测试文件不受守卫约束（测试内需要写负例断言）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-abs-"));
    try {
      mkdirSync(join(tmp, "src", "prompts"), { recursive: true });
      writeFileSync(join(tmp, "src", "prompts", "negative.test.ts"), "历史记录都发生在进入之前。\n");
      const targets = absoluteClaimScanTargets(tmp).filter((f) => !f.endsWith(".test.ts"));
      expect(targets).not.toContain("src/prompts/negative.test.ts");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

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
