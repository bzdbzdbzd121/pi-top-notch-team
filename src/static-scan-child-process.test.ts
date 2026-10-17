import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 仓库根（test 文件位于 src/ 下）。 */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 阶段 5 静态守卫：`child_process` 白名单扫描（方案 §7.A「明确的实现纪律」）。
 *
 * 目的：同步模块（尤其 `src/sync/**`）必须经统一 git 执行器
 * （`src/sync/git-runner.ts`）调用 git —— 只有它做了环境硬化（`LC_ALL=C`、
 * 禁止交互、清除 `GIT_*` 注入）、硬超时 + SIGKILL、输出上限、`-z` 解析与错误
 * 分类。任何绕过都会悄悄丢掉这些保护（例如用户全局 git 钩子/分页器挂死、
 * 输出无上限撑爆内存、凭据交互弹窗卡住进程）。
 *
 * 白名单（含理由）：
 * - `src/sync/git-runner.ts`   统一 git 执行器本体（唯一允许 spawn git 的模块）。
 * - `src/process/member-process.ts`  成员进程 spawn（`pi --mode rpc` 子进程生命周期）。
 * - `src/setup/member-lifecycle.ts`  成员进程创建/重启路径（复用同一 spawn 语义）。
 * - `src/tools/tl-tools.ts`    TL 工具侧的成员进程探测/停止（进程管理，不经 git）。
 */
const WHITELIST: Record<string, string> = {
  "src/sync/git-runner.ts": "统一 git 执行器本体（唯一允许 spawn git 的模块）",
  "src/process/member-process.ts": "成员进程 spawn（pi --mode rpc 子进程生命周期）",
  "src/setup/member-lifecycle.ts": "成员进程创建/重启路径（进程管理，非 git）",
  "src/tools/tl-tools.ts": "TL 工具的成员进程探测/停止（进程管理，非 git）",
};

export interface ChildProcessViolation {
  file: string;
  count: number;
}

/** 扫描 root 下所有生产 .ts 文件（排除 *.test.ts、test 目录、node_modules 与 dist），返回 child_process 违规。 */
export function scanChildProcessConsumers(root: string): ChildProcessViolation[] {
  const violations: ChildProcessViolation[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "test" || entry.name === "node_modules" || entry.name === "dist") continue;
        walk(join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const source = readFileSync(join(dir, entry.name), "utf-8");
        const matches = source.match(/(?:from|require\()\s*["'](?:node:)?child_process["']/g);
        if (matches && matches.length > 0 && !WHITELIST[rel]) {
          violations.push({ file: rel, count: matches.length });
        }
      }
    }
  };
  walk(root, "");
  return violations;
}

describe("静态扫描守卫（阶段 5）：child_process 只允许在统一白名单内", () => {
  it("生产代码中除白名单模块外无 child_process 引用（同步模块必须经统一 git 执行器）", () => {
    const violations = scanChildProcessConsumers(REPO_ROOT);
    expect(violations).toEqual([]);
  });

  it("白名单模块内确实引用 child_process（白名单非空壳）", () => {
    for (const file of Object.keys(WHITELIST)) {
      const source = readFileSync(join(REPO_ROOT, file), "utf-8");
      expect(source, `${file} 应引用 child_process`).toMatch(
        /(?:from|require\()\s*["'](?:node:)?child_process["']/
      );
    }
  });

  it("src/sync/ 下只有 git-runner.ts 允许引用 child_process", () => {
    const syncDir = join(REPO_ROOT, "src", "sync");
    const offenders = readdirSync(syncDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => /(?:from|require\()\s*["'](?:node:)?child_process["']/.test(readFileSync(join(syncDir, name), "utf-8")))
      .filter((name) => `src/sync/${name}` !== "src/sync/git-runner.ts");
    expect(offenders).toEqual([]);
  });

  it("人为新增绕过（含 src/sync/ 内新增 spawn 文件）→ 违规（负例 fixture）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-guard-cp-"));
    try {
      writeFileSync(join(tmp, "index.ts"), 'import { spawn } from "node:child_process";\n');
      mkdirSync(join(tmp, "src", "sync"), { recursive: true });
      writeFileSync(join(tmp, "src", "sync", "rogue.ts"), 'const cp = require("child_process");\n');
      writeFileSync(join(tmp, "src", "sync", "git-runner.ts"), 'import { spawn } from "node:child_process";\n');
      const hits = scanChildProcessConsumers(tmp);
      expect(hits).toEqual(
        expect.arrayContaining([
          { file: "index.ts", count: 1 },
          { file: "src/sync/rogue.ts", count: 1 },
        ])
      );
      // 白名单文件不计违规
      expect(hits.map((h) => h.file)).not.toContain("src/sync/git-runner.ts");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("普通模块（无 child_process）不误报；测试文件不受约束", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scan-guard-cp-"));
    try {
      writeFileSync(join(tmp, "plain.ts"), 'import { join } from "node:path";\n');
      writeFileSync(join(tmp, "spawn-helper.test.ts"), 'import { spawn } from "node:child_process";\n');
      mkdirSync(join(tmp, "dist"), { recursive: true });
      writeFileSync(join(tmp, "dist", "bundled.js"), 'require("child_process")\n');
      expect(scanChildProcessConsumers(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
