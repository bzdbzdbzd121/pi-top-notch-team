/**
 * 阶段 5 端到端冒烟（**默认跳过**；复跑见 `scripts/run-cloud-sync-smoke.mjs`）：
 *
 *   node scripts/run-cloud-sync-smoke.mjs
 *   # 等价于：SYNC_SMOKE=1 npx vitest run src/sync/smoke.cloud-sync.test.ts
 *
 * 用真实 git + 真实生产模块（handleSyncCommand / classify / apply / decide 等）走查四类流程，
 * **零网络**（远端 = 本地裸仓库；断网用「不存在的远端路径」模拟）。
 *
 * 说明：本环境无交互终端，pi UI（confirm/select/input）用桩替换；其余全部为真实代码与
 * 真实文件系统/Git 操作。真实 pi 进程的加载冒烟由同一脚本的第二步完成
 * （`pi --mode json --no-tools -e ./index.ts`）。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMockContext } from "../test/fixtures/mock-extension-api";
import { handleSyncCommand } from "./command";
import { saveSyncConfig } from "./config";

const RUN_SMOKE = process.env.SYNC_SMOKE === "1";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, LC_ALL: "C" } });
}

function teamYaml(name: string, desc: string): string {
  return stringifyYaml({
    name,
    description: desc,
    members: [{ name: "m1", label: "成员", systemPrompt: "提示" }],
  });
}

function stubCtx(overrides?: { mode?: string; select?: (t: string, l: string[]) => string | undefined }): {
  ctx: ExtensionCommandContext;
  notify: string[];
} {
  const notify: string[] = [];
  const ctx = createMockContext(overrides?.mode ? ({ mode: overrides.mode } as never) : undefined);
  ctx.ui.notify = ((text: string) => {
    notify.push(String(text));
    process.stdout.write(`[notify] ${String(text).replace(/\n/g, "\n[notify] ")}\n`);
  }) as never;
  ctx.ui.confirm = (async () => true) as never;
  ctx.ui.select = (async (_title: string, labels: string[]) =>
    overrides?.select ? overrides.select(_title, labels) : labels[0]) as never;
  ctx.ui.input = (async () => undefined) as never;
  return { ctx: ctx as unknown as ExtensionCommandContext, notify };
}

const log = (msg: string): void => {
  process.stdout.write(`[smoke] ${msg}\n`);
};

describe.skipIf(!RUN_SMOKE)("阶段 5 端到端冒烟（SYNC_SMOKE=1 才运行）", () => {
  it("四类流程：无冲突同步 / 冲突决策 / 断网重跑 / 备份恢复", async () => {
    const base = mkdtempSync(join(tmpdir(), "smoke-"));
    const remoteDir = join(base, "cloud.git");
    const rootA = join(base, "machine-a");
    const rootB = join(base, "machine-b");
    mkdirSync(remoteDir, { recursive: true });
    git(base, ["init", "--bare", "-q", remoteDir]);
    process.env.TOP_NOTCH_TEAM_ROOT = rootA;

    try {
      // ── 场景 1：首次接入 + 无冲突双向同步（含另一台机器）──
      log("场景 1：首次接入（本机建团队 → 上传）");
      mkdirSync(join(rootA, "teams"), { recursive: true });
      writeFileSync(join(rootA, "teams", "base.yaml"), teamYaml("base", "基线团队"), "utf-8");
      saveSyncConfig({ enabled: true, remoteUrl: remoteDir, branch: "" }, rootA);
      await handleSyncCommand(stubCtx().ctx, "", { rootDir: rootA });
      expect(git(remoteDir, ["ls-tree", "-r", "--name-only", "main"])).toContain("base.yaml");
      log("   ✓ 首次接入上传成功（远端 main 已有 base.yaml）");

      log("场景 1b：第二台机器接入 → 下载 → 改 → 同步 → 第一台机器拉到");
      mkdirSync(join(rootB, "teams"), { recursive: true });
      git(rootB, ["clone", "-q", "--branch", "main", remoteDir, join(rootB, "teams")]);
      saveSyncConfig({ enabled: true, remoteUrl: remoteDir, branch: "" }, rootB);
      writeFileSync(join(rootB, "teams", "base.yaml"), teamYaml("base", "B 机改过的描述"), "utf-8");
      await handleSyncCommand(stubCtx().ctx, "", { rootDir: rootB });
      expect(git(remoteDir, ["show", "main:base.yaml"])).toContain("B 机改过的描述");
      await handleSyncCommand(stubCtx().ctx, "", { rootDir: rootA });
      expect(readFileSync(join(rootA, "teams", "base.yaml"), "utf-8")).toContain("B 机改过的描述");
      log("   ✓ 双向无冲突同步（B 改 → 推送 → A 拉到）");

      // ── 场景 2：冲突决策（两边都留 → 归档 + 导入新团队）──
      log("场景 2：冲突决策（两边都改 → 两边都留）");
      writeFileSync(join(rootA, "teams", "base.yaml"), teamYaml("base", "A 机重新描述"), "utf-8");
      writeFileSync(join(rootB, "teams", "base.yaml"), teamYaml("base", "B 机再次描述"), "utf-8");
      await handleSyncCommand(stubCtx().ctx, "", { rootDir: rootB });
      const a3 = stubCtx({ mode: "rpc", select: (_t, labels) => labels.find((l) => l.startsWith("两边都留")) });
      await handleSyncCommand(a3.ctx, "", { rootDir: rootA });
      const archives = readdirSync(join(rootA, "sync-conflicts"));
      const imported = readdirSync(join(rootA, "teams")).filter((f) => f.startsWith("base-remote-"));
      expect(archives.length).toBeGreaterThan(0);
      expect(imported.length).toBe(1);
      expect(readFileSync(join(rootA, "teams", imported[0]), "utf-8")).toContain("B 机再次描述");
      log(`   ✓ 冲突已决策：留档 ${archives[0]}；导入新团队 ${imported[0]}`);

      // RPC 降级路径的人工查看命令必须真实可执行（照抄用户路径）
      const overview = a3.notify
        .join("\n")
        .split("\n")
        .find((line) => line.includes("查看云端版本："));
      expect(overview).toBeDefined();
      const showCmd = String(overview).split("查看云端版本：")[1]!.trim();
      expect(execFileSync("/bin/sh", ["-c", showCmd], { encoding: "utf-8" })).toContain("B 机再次描述");
      log(`   ✓ RPC 人工命令可执行：${showCmd.slice(0, 60)}…`);

      // ── 场景 3：断网重跑（远端不可达 → 明确失败；恢复后收敛）──
      log("场景 3：断网重跑（远端路径不可达）");
      saveSyncConfig({ enabled: true, remoteUrl: join(base, "no-such-cloud.git"), branch: "" }, rootA);
      writeFileSync(join(rootA, "teams", "base.yaml"), teamYaml("base", "断网期间的改动"), "utf-8");
      const offline = stubCtx();
      await handleSyncCommand(offline.ctx, "", { rootDir: rootA });
      const offlineText = offline.notify.join("\n");
      expect(offlineText).toContain("云同步失败");
      expect(readFileSync(join(rootA, "teams", "base.yaml"), "utf-8")).toContain("断网期间的改动");
      log(`   ✓ 断网明确失败：${offlineText.split("\n")[0]}`);

      log("场景 3b：恢复地址后重跑 → 收敛（无重复提问）");
      saveSyncConfig({ enabled: true, remoteUrl: remoteDir, branch: "" }, rootA);
      await handleSyncCommand(stubCtx().ctx, "", { rootDir: rootA });
      expect(git(remoteDir, ["show", "main:base.yaml"])).toContain("断网期间的改动");
      log("   ✓ 重跑成功收敛（断网期间改动已上传）");

      // ── 场景 4：备份恢复（删除 teams/ → 从云端全量恢复 + 历史找回命令）──
      log("场景 4：备份恢复（删除 teams/ 后从云端恢复）");
      rmSync(join(rootA, "teams"), { recursive: true, force: true });
      await handleSyncCommand(stubCtx().ctx, "", { rootDir: rootA });
      const restored = readdirSync(join(rootA, "teams")).filter((f) => f.endsWith(".yaml"));
      expect(restored).toContain("base.yaml");
      expect(readFileSync(join(rootA, "teams", "base.yaml"), "utf-8")).toContain("断网期间的改动");
      log(`   ✓ 全量恢复 ${restored.length} 个团队：${restored.join("、")}`);

      const gitDir = join(rootA, "teams", ".git");
      const history = execFileSync("git", ["--git-dir", gitDir, "log", "--oneline", "--", "base.yaml"], {
        encoding: "utf-8",
      });
      const commits = history.trim().split("\n");
      expect(commits.length).toBeGreaterThan(1);
      const oldest = commits[commits.length - 1].split(" ")[0];
      expect(execFileSync("git", ["--git-dir", gitDir, "show", `${oldest}:base.yaml`], { encoding: "utf-8" })).toContain(
        "base"
      );
      log(`   ✓ 历史找回命令可用（${commits.length} 条历史；最早版本可 show 出）`);

      const status = stubCtx();
      await handleSyncCommand(status.ctx, "status", { rootDir: rootA, statusTimeoutMs: 15_000 });
      expect(status.notify.join("\n")).toContain("云同步状态");
      log(`   ✓ 状态查询：${status.notify.join("\n").split("\n").slice(1, 3).join(" | ")}`);

      // 归档目录不参与同步、不出现在团队列表
      expect(readdirSync(join(rootA, "teams")).some((f) => f.startsWith("sync-conflicts"))).toBe(false);
      expect(existsSync(join(rootA, "sync-conflicts"))).toBe(true);
      log(`   ✓ 归档目录仍在 teams/ 之外（${archives.length} 个留档，不参与同步）`);
    } finally {
      rmSync(base, { recursive: true, force: true });
      delete process.env.TOP_NOTCH_TEAM_ROOT;
    }
  }, 120_000);
});
