import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockContext } from "../test/fixtures/mock-extension-api";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  formatSyncFailure,
  formatSyncResult,
  formatSyncStatus,
  handleSyncCommand,
  planNeedsConfirmation,
  type SyncStatusData,
} from "./command";
import { getSyncConfigPath, loadSyncConfig, saveSyncConfig } from "./config";
import { formatPlanSummary, manualFailure, type SyncPlan } from "./plan";

function ctxWith(overrides?: { mode?: string; notify?: ReturnType<typeof vi.fn> }): {
  ctx: ExtensionCommandContext;
  notify: ReturnType<typeof vi.fn>;
} {
  const notify = overrides?.notify ?? vi.fn();
  const ctx = createMockContext(overrides?.mode ? ({ mode: overrides.mode } as never) : undefined);
  ctx.ui.notify = notify as never;
  return { ctx: ctx as unknown as ExtensionCommandContext, notify };
}

const notifyText = (spy: ReturnType<typeof vi.fn>): string =>
  spy.mock.calls.map((c) => String(c[0])).join("\n");

function makePlan(actions: SyncPlan["actions"], flags?: Partial<SyncPlan["flags"]>): SyncPlan {
  return {
    flags: { firstAttach: false, emptyRemote: false, remoteUrlChanged: false, ...flags },
    actions,
    ignored: { nestedYaml: [], nonYamlLocalModified: [] },
    invalidLocalTeams: [],
    remoteSha: "abc",
    branch: "main",
  };
}

const baseSummary = {
  branch: "main",
  downloaded: [],
  uploaded: [],
  deletedOnLocal: [],
  deletedOnRemote: [],
  passthroughUpdated: [],
  keptLocalPaths: [],
  ignored: { nestedYaml: [], nonYamlLocalModified: [] },
  invalidTeams: [],
  commit: "",
  pushed: false,
  fallbackIdentity: false,
  fastForward: false,
  noop: false,
};

describe("阶段 2 输出文案（验收 13）", () => {
  it("无事可做 → 一行摘要", () => {
    expect(formatSyncResult({ ...baseSummary, noop: true })).toBe("已是最新（云端无更新，本机无待同步改动）");
  });

  it("有变更 → 下载/上传/删除/提交摘要", () => {
    const text = formatSyncResult({
      ...baseSummary,
      downloaded: ["refactoring", "reviewer-team"],
      uploaded: ["analyzer-team"],
      deletedOnRemote: ["old-team"],
      commit: "a1b2c3d4e5f6",
      pushed: true,
    });
    expect(text).toContain("云同步完成");
    expect(text).toContain("下载：2（refactoring、reviewer-team）");
    expect(text).toContain("上传：1（analyzer-team）");
    expect(text).toContain("删除：1（云端删 old-team）");
    expect(text).toContain("提交：（本地已推送）a1b2c3d");
  });

  it("推送失败 → 唯一允许的中间态明确报告", () => {
    const text = formatSyncResult({
      ...baseSummary,
      uploaded: ["a"],
      commit: "deadbeefcafe",
      pushed: false,
      pushFailure: manualFailure("推送被拒绝：云端已有其它机器推送的更新", "重新运行 /team sync"),
    });
    expect(text).toContain("本地已提交，尚未推送");
    expect(text).toContain("推送失败：推送被拒绝");
    expect(text).toContain("修法：重新运行 /team sync");
  });

  it("兜底身份与非法 YAML 附注", () => {
    const text = formatSyncResult({
      ...baseSummary,
      uploaded: ["a"],
      commit: "1234567",
      pushed: true,
      fallbackIdentity: true,
      invalidTeams: [{ name: "bad", errors: ["members 不能为空"] }],
    });
    expect(text).toContain("身份：本次提交使用兜底身份");
    expect(text).toContain("未修改你的 git 全局配置");
    expect(text).toContain("异常：1 个团队文件校验失败（bad.yaml：members 不能为空");
  });

  it("失败输出：原因 + 修法 + （可选）原始诊断", () => {
    const failure = manualFailure("远端仓库不存在或无权访问", "核对仓库地址与访问权限");
    expect(formatSyncFailure(failure)).toBe("云同步失败：远端仓库不存在或无权访问。修法：核对仓库地址与访问权限");
    const withRaw = formatSyncFailure(
      { ...failure, command: "git ls-remote origin", stderr: "fatal: not found" },
      { raw: true }
    );
    expect(withRaw).toContain("失败命令：git ls-remote origin");
    expect(withRaw).toContain("原始输出：\nfatal: not found");
  });

  it("计划摘要：下载/上传/删除与首次接入标记", () => {
    const text = formatPlanSummary(
      makePlan(
        [
          { kind: "remote-modified", path: "a.yaml" },
          { kind: "local-only", path: "b.yaml" },
          { kind: "local-deleted", path: "c.yaml" },
          { kind: "remote-deleted", path: "d.yaml" },
          { kind: "both-deleted", path: "e.yaml" },
        ],
        { firstAttach: true, emptyRemote: true }
      )
    );
    expect(text).toContain("下载：1（a.yaml）");
    expect(text).toContain("上传：1（b.yaml）");
    expect(text).toContain("删除：2（云端删：c.yaml；本机删：d.yaml）");
    expect(text).toContain("首次接入");
    expect(text).toContain("云端为空仓库");
    expect(text).not.toContain("e.yaml");
  });

  describe("状态输出", () => {
    const data = (overrides: Partial<SyncStatusData>): SyncStatusData => ({
      configured: true,
      enabled: true,
      remoteUrlMasked: "git@github.com:me/team-defs.git",
      branch: "main",
      branchSourceLabel: "自动探测",
      remote: { kind: "up-to-date" },
      checkedAt: "12:03:11",
      local: { uncommittedTeams: 0, unpushedCommits: 0 },
      archive: { count: 0 },
      invalidTeams: [],
      repo: { ok: true },
      ...overrides,
    });

    it("未配置", () => {
      const text = formatSyncStatus(data({ configured: false, enabled: false, remoteUrlMasked: "" }));
      expect(text).toContain("云同步状态");
      expect(text).toContain("配置：未配置");
      expect(text).toContain("运行 /team sync 按引导填写私有仓库地址");
    });

    it("已配置无更新", () => {
      const text = formatSyncStatus(data({}));
      expect(text).toContain("配置：已配置（启用）");
      expect(text).toContain("仓库：git@github.com:me/team-defs.git（已脱敏）");
      expect(text).toContain("分支：main（自动探测）");
      expect(text).toContain("远端：无更新（检查于 12:03:11）");
      expect(text).toContain("本地：0 个团队有未提交改动；0 个未推送提交");
      expect(text).toContain("仓库：正常");
    });

    it("落后/领先/分叉/空远端", () => {
      expect(formatSyncStatus(data({ remote: { kind: "behind", behind: 2 } }))).toContain("远端：落后 2 个提交");
      expect(formatSyncStatus(data({ remote: { kind: "ahead", ahead: 1 } }))).toContain("领先 1 个提交");
      expect(formatSyncStatus(data({ remote: { kind: "diverged", ahead: 1, behind: 2 } }))).toContain("已分叉");
      expect(formatSyncStatus(data({ remote: { kind: "empty" } }))).toContain("远端：空仓库");
    });

    it("远端无法检查 → 原因 + 修法", () => {
      const text = formatSyncStatus(
        data({ remote: { kind: "error", failure: manualFailure("认证失败或凭据缺失", "配置 git 凭据") } })
      );
      expect(text).toContain("远端：无法检查：认证失败或凭据缺失。修法：配置 git 凭据");
    });

    it("归档 / 异常 / 仓库需处理行", () => {
      const text = formatSyncStatus(
        data({
          archive: { count: 1, latest: "/tmp/sync-conflicts/refactoring.20261017-1201.yaml" },
          invalidTeams: [{ name: "bad", errors: ["members 不能为空"] }],
          local: { uncommittedTeams: 2, unpushedCommits: 1 },
          repo: { ok: false, note: "存在 .git/index.lock" },
        })
      );
      expect(text).toContain("本地：2 个团队有未提交改动；1 个未推送提交");
      expect(text).toContain("归档：1 个冲突留档待清理");
      expect(text).toContain("异常：1 个团队文件校验失败（bad.yaml：members 不能为空");
      expect(text).toContain("仓库：需处理（存在 .git/index.lock）");
    });
  });
});

describe("确认策略（零交互边界）", () => {
  it("普通修改计划零交互", () => {
    expect(planNeedsConfirmation(makePlan([{ kind: "local-modified", path: "a.yaml" }, { kind: "remote-modified", path: "b.yaml" }]))).toBe(false);
  });

  it("首次接入且有上传 → 需确认", () => {
    expect(
      planNeedsConfirmation(makePlan([{ kind: "local-only", path: "a.yaml" }], { firstAttach: true, emptyRemote: true }))
    ).toBe(true);
    // 新机器只下载 → 无需确认
    expect(planNeedsConfirmation(makePlan([{ kind: "remote-only", path: "a.yaml" }], { firstAttach: true }))).toBe(false);
  });

  it("删除传播需确认；both-deleted 不需要", () => {
    expect(planNeedsConfirmation(makePlan([{ kind: "local-deleted", path: "a.yaml" }]))).toBe(true);
    expect(planNeedsConfirmation(makePlan([{ kind: "remote-deleted", path: "a.yaml" }]))).toBe(true);
    expect(planNeedsConfirmation(makePlan([{ kind: "both-deleted", path: "a.yaml" }]))).toBe(false);
  });
});

describe("命令层边界", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "sync-command-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("非交互模式（print/json）拒绝写操作", async () => {
    const { ctx, notify } = ctxWith({ mode: "print" });
    await handleSyncCommand(ctx, "", { rootDir });
    expect(notifyText(notify)).toContain("需要交互式界面");
  });

  it("未配置 + 无界面 → 引导文案（不写任何文件）", async () => {
    const { ctx, notify } = ctxWith({ mode: "print" });
    await handleSyncCommand(ctx, "status", { rootDir });
    expect(notifyText(notify)).toContain("云同步状态");
    expect(notifyText(notify)).toContain("未配置");
    expect(existsSync(getSyncConfigPath(rootDir))).toBe(false);
  });

  it("已配置但尚未接入 → 状态显示尚未接入", async () => {
    saveSyncConfig({ enabled: true, remoteUrl: join(rootDir, "no-such-remote.git"), branch: "" }, rootDir);
    const { ctx, notify } = ctxWith();
    await handleSyncCommand(ctx, "status", { rootDir, statusTimeoutMs: 1000 });
    const text = notifyText(notify);
    expect(text).toContain("尚未接入");
    expect(text).toContain("仓库：需处理");
  });

  it("首次接入引导：地址非法 → 提示原因且不落盘", async () => {
    const notify = vi.fn();
    const ctx = createMockContext();
    ctx.ui.notify = notify as never;
    ctx.ui.input = vi.fn().mockResolvedValue("https://user:pass@github.com/me/x.git") as never;
    await handleSyncCommand(ctx as unknown as ExtensionCommandContext, "", { rootDir });
    expect(notifyText(notify)).toContain("不能内嵌");
    expect(existsSync(getSyncConfigPath(rootDir))).toBe(false);
  });

  it("首次接入引导：Esc 取消 → 不落盘", async () => {
    const notify = vi.fn();
    const ctx = createMockContext();
    ctx.ui.notify = notify as never;
    ctx.ui.input = vi.fn().mockResolvedValue(undefined) as never;
    await handleSyncCommand(ctx as unknown as ExtensionCommandContext, "", { rootDir });
    expect(notifyText(notify)).toContain("已取消配置");
    expect(existsSync(getSyncConfigPath(rootDir))).toBe(false);
  });

  it("首次接入引导：合法地址保存后继续 → 远端不可达时报分类失败", async () => {
    const notify = vi.fn();
    const ctx = createMockContext();
    ctx.ui.notify = notify as never;
    ctx.ui.input = vi.fn().mockResolvedValue(join(rootDir, "no-such-remote.git")) as never;
    await handleSyncCommand(ctx as unknown as ExtensionCommandContext, "", { rootDir });

    expect(loadSyncConfig(rootDir)).toMatchObject({ enabled: true, remoteUrl: join(rootDir, "no-such-remote.git") });
    expect(notifyText(notify)).toContain("云同步失败");
  });
});
