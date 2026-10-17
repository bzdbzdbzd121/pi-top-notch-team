#!/usr/bin/env node
/**
 * 团队定义云同步：端到端冒烟复跑脚本（零新增依赖）。
 *
 *   node scripts/run-cloud-sync-smoke.mjs            # 完整：流程冒烟 + 真实 pi 加载冒烟
 *   node scripts/run-cloud-sync-smoke.mjs --flow     # 只跑流程冒烟
 *   node scripts/run-cloud-sync-smoke.mjs --load     # 只跑真实 pi 加载冒烟
 *
 * 步骤：
 *   1. 流程冒烟：SYNC_SMOKE=1 + vitest 跑 src/sync/smoke.cloud-sync.test.ts
 *      （真实 git + 本地裸仓库做云端 + 临时 TOP_NOTCH_TEAM_ROOT，**零网络**）；
 *      覆盖四类：无冲突同步 / 冲突决策与留档 / 断网重跑 / 备份恢复。
 *   2. 真实 pi 加载冒烟：`pi --mode json --no-tools -e ./index.ts`（扩展能被真实 pi 加载）。
 *
 * 记录：结果 tee 到 /tmp/sync-stage5-smoke.log 与 /tmp/sync-stage5-pi-load.log
 * （含执行命令、开始时间与 EXIT 码）。退出码 = 任一步骤失败即非 0。
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const FLOW_LOG = "/tmp/sync-stage5-smoke.log";
const LOAD_LOG = "/tmp/sync-stage5-pi-load.log";

const args = process.argv.slice(2);
const flowOnly = args.includes("--flow");
const loadOnly = args.includes("--load");
const runFlow = !loadOnly;
const runLoad = !flowOnly;

function run(label, command, commandArgs, logPath) {
  const startedAt = new Date().toISOString();
  const header = [
    `# ${label}`,
    `# 命令：${[command, ...commandArgs].join(" ")}`,
    `# 工作目录：${repoRoot}`,
    `# 开始：${startedAt}`,
    "",
  ].join("\n");
  process.stdout.write(`${header}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    // GIT_ALLOW_PROTOCOL=file：把「零网络」变成硬护栏（任何 https/ssh 尝试立即失败）
    env: { ...process.env, SYNC_SMOKE: "1", LC_ALL: "C", GIT_ALLOW_PROTOCOL: "file" },
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  const exitCode = result.status ?? 1;
  writeFileSync(logPath, `${header}${output}\n# EXIT：${exitCode}\n`, "utf-8");
  process.stdout.write(`# EXIT：${exitCode}（记录：${logPath}）\n\n`);
  return exitCode;
}

let failed = 0;

if (runFlow) {
  failed += run(
    "步骤 1/2：云同步流程冒烟（真实 git + 本地裸仓库 + 零网络）",
    "npx",
    ["vitest", "run", "src/sync/smoke.cloud-sync.test.ts"],
    FLOW_LOG
  );
}

if (runLoad) {
  failed += run(
    "步骤 2/2：真实 pi 加载冒烟（扩展能被真实 pi 加载）",
    join(repoRoot, "node_modules", ".bin", "pi"),
    ["--mode", "json", "--no-tools", "-e", "./index.ts"],
    LOAD_LOG
  );
}

if (failed === 0) {
  process.stdout.write(`冒烟全部通过。流程记录：${FLOW_LOG}；加载记录：${LOAD_LOG}\n`);
} else {
  process.stdout.write(`冒烟存在失败步骤（失败计数 ${failed}）。请查看上述记录。\n`);
  // 失败时把记录内容回显一遍，便于直接粘贴到报告
  for (const path of [FLOW_LOG, LOAD_LOG]) {
    try {
      process.stdout.write(`\n=== ${path} ===\n${readFileSync(path, "utf-8")}\n`);
    } catch {
      /* 记录不存在（该步骤未运行） */
    }
  }
}
process.exit(failed === 0 ? 0 : 1);
