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
// 扫描范围（生产源码）：`index.ts`（退场横幅，内联在模板字符串里的模型可见文本）+
// `src/prompts/*.ts`（全部提示词模块）。排除 `*.test.ts`（测试要写负例断言）与
// `test/` 目录、`node_modules`、`dist`。
//
// 为什么**不**扩到 `src/tools/*.ts`（工具描述 / promptGuidelines / 拒绝文案）与
// `src/prompts/orchestration-playbook.md`：
// - 风险类是「向模型宣称对话历史长什么样，以此获取权威」的文本；工具描述讲的是工具
//   怎么用、拒绝文案讲的是这一步为什么被拦，都不做历史断言；Playbook 是编排方法论。
// - 三类文本的合法措辞（「所有成员」「一律派发」「都属高风险」）与历史断言高度同形，
//   扩面会把守卫变成噪音源，反而促使后人加豁免。
// - 若将来出现新的「历史权威」文本，应把它放回 `session-transition-notice.ts`（单一
//   来源），而不是扩扫描面。
//
// 豁免规则：**零文件级豁免**。判定靠「四特征同句」保证精确，因此不需要例外清单：
// 出现命中就是文案该改写（限定为进入前 / 冲突情形），而不是往这里加白名单——一份可
// 豁免的守卫等于没有守卫。
// ────────────────────────────────────────────────────────────────

/**
 * 绝对化历史断言的四个特征，**必须同时出现在同一句**才判为违规：
 * 1. 历史名词（历史/记录）——断言的对象是对话历史本身；
 * 2. 量词（所有/全部/一切/都/均/一律/无一例外）——断言覆盖全部而非部分；
 * 3. 断言谓词（发生在/发生于/属于/视作）——断言的是一个事实命题；
 * 4. 进入范围词（进入/切换）——断言的是「进入之前」这一时间范围。
 *
 * 收紧为「四特征同句」是本轮审查的必修项：只按「历史 + 量词」共现判定会误报合法
 * 文案（「历史里的所有做法都属于普通模式」「所有历史记录均由 extension 维护」），
 * 而零豁免策略会把误报升级成「必须改对文本」。
 *
 * 正则均不带 `g` 标志、按句子复用同一实例（`test()` 在非 global 正则上无 `lastIndex`
 * 状态），因此不存在跨调用污染；保留各特征自身的 flags，不再用 `new RegExp(source)`
 * 重建（那会丢 flags）。
 */
const ABSOLUTE_CLAIM_FEATURES: ReadonlyArray<{ id: string; label: string; pattern: RegExp }> = [
  { id: "history-noun", label: "历史名词（历史/记录）", pattern: /历史|记录/ },
  { id: "quantifier", label: "量词（所有/全部/一切/都/均/一律/无一例外）", pattern: /所有|全部|一切|都|均|一律|无一例外/ },
  { id: "assertion-predicate", label: "断言谓词（发生在/发生于/属于/视作）", pattern: /发生在|发生于|属于|视作/ },
  { id: "entry-scope", label: "进入范围词（进入/切换）", pattern: /进入|切换/ },
];

/** 按句切分（。！？与换行都是边界），保留字节偏移以便报告行号。 */
function splitSentences(source: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  for (const m of source.matchAll(/[^。！？\n]+/g)) {
    out.push({ text: m[0], offset: m.index ?? 0 });
  }
  return out;
}

export interface AbsoluteClaimHit {
  file: string;
  /** 1-based 行号（违规句的起始行）。 */
  line: number;
  /** 违规句（trim 后），便于直接定位与改写。 */
  sentence: string;
  /** 缺失特征（用于解释为何判为违规：空数组 = 四特征齐全）。 */
  matchedFeatures: string[];
}

/** 扫描一个文件源码，返回命中的绝对化历史断言（四特征同句）。 */
export function scanAbsoluteHistoryClaims(
  source: string,
  file = "<memory>",
): AbsoluteClaimHit[] {
  const hits: AbsoluteClaimHit[] = [];
  for (const { text, offset } of splitSentences(source)) {
    const matched = ABSOLUTE_CLAIM_FEATURES.filter((f) => f.pattern.test(text));
    if (matched.length !== ABSOLUTE_CLAIM_FEATURES.length) continue;
    hits.push({
      file,
      line: source.slice(0, offset).split("\n").length,
      sentence: text.trim(),
      matchedFeatures: matched.map((f) => f.id),
    });
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
    expect(violations.map((v) => `${v.file}:${v.line} ${v.sentence}`)).toEqual([]);
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

  it("正例：四特征同句的断言必须被检出（前置/后置量词 × 四种谓词）", () => {
    const cases = [
      "历史里你亲自分析代码的记录都发生在进入之前。",
      "所有历史记录都属于进入前的普通模式。",
      "历史里的做法均发生于切换之前。",
      "记录里的所有做法都视作进入前的状态。",
    ];
    for (const text of cases) {
      const hits = scanAbsoluteHistoryClaims(text);
      expect(hits, text).toHaveLength(1);
      expect(hits[0].matchedFeatures).toHaveLength(ABSOLUTE_CLAIM_FEATURES.length);
    }
  });

  it("不误报（审查表 6 句 + 横幅缩短句）：缺任一特征都不算违规", () => {
    const legitimate = [
      // ① 有历史名词 + 量词 + 谓词，缺进入范围词（说的是本次会话内的做法）
      "历史里的所有做法都属于普通模式",
      // ② 前置量词修饰历史名词，但没有断言谓词（描述存储实现）
      "所有历史记录均由 extension 维护",
      // ③ 后置量词修饰历史名词，但没有断言谓词
      "历史记录一律由成员进程写入",
      // ④ 退场横幅缩短句：历史 + 都 + 发生在，但说的是「会话结束之前」
      "你在历史记录里看到的成功调用都发生在会话结束之前",
      // ⑤ 量词 + 谓词，但没有历史名词（描述团队构成）
      "共享上下文里的所有成员都属于该团队",
      // ⑥ 历史名词 + 进入范围词，但没有量词（限定写法本身）
      "历史里**进入本会话之前**留下的做法属于普通模式",
      // ⑦ 横幅交叉引用句（缩短版）：锚点 + 进入范围，无量词/谓词
      "若历史里出现过以「【系统通知｜团队会话状态】」开头的系统通知（进入团队会话时注入），它同样已失效",
    ];
    for (const text of legitimate) {
      expect(scanAbsoluteHistoryClaims(text), text).toEqual([]);
    }
  });

  it("正例：报告包含文件、行号与违规句（可直接定位到待改写文本）", () => {
    const hits = scanAbsoluteHistoryClaims(
      "line one\n历史里的做法都发生在切换之前。\n",
      "prompt.ts",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "prompt.ts", line: 2 });
    expect(hits[0].sentence).toContain("发生在切换之前");
    expect(hits[0].matchedFeatures).toEqual([
      "history-noun",
      "quantifier",
      "assertion-predicate",
      "entry-scope",
    ]);
  });

  it("跨行不断句：一句被换行拆开时分段判定（宁可漏报不误报，规则写明）", () => {
    // 提示词里的长句常被换行折断；分段判定意味着跨行的绝对断言可能漏报。
    // 这是刻意的取舍：误报会把零豁免变成「必须改对文本」，漏报只降低守卫灵敏度。
    const split = "历史里的所有做法\n都发生在进入之前。";
    expect(scanAbsoluteHistoryClaims(split)).toEqual([]);
  });

  it("测试文件不受守卫约束（测试内需要写负例断言）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-abs-"));
    try {
      mkdirSync(join(tmp, "src", "prompts"), { recursive: true });
      writeFileSync(
        join(tmp, "src", "prompts", "negative.test.ts"),
        "历史记录都发生在进入之前。\n",
      );
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
