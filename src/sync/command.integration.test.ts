import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { stringify as stringifyYaml } from "yaml";
import { createMockContext } from "../test/fixtures/mock-extension-api";
import { handleSyncCommand } from "./command";
import { getSyncConfigPath, saveSyncConfig } from "./config";
import { getTeamsDir } from "../team/store";
import { runGit } from "./git-runner";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * 阶段 2 集成测试（方案 §5 阶段 2 验收 1–12、14）：
 * 真实 git + 本地裸仓库做「云端」，TOP_NOTCH_TEAM_ROOT 指向临时目录，零网络。
 */

const GIT_ID = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function gitCli(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, LC_ALL: "C", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}


/** 手工写入 loose tree 对象（可含 `../` 等 git 拒绝创建的路径；配合 fetch 默认不 fsck 的场景）。 */
function craftMaliciousTree(repoDir: string, blobSha: string, entryPath: string): string {
  const body = Buffer.concat([Buffer.from(`100644 ${entryPath}\0`, "utf8"), Buffer.from(blobSha, "hex")]);
  const store = Buffer.concat([Buffer.from(`tree ${body.length}\0`, "utf8"), body]);
  const id = createHash("sha1").update(store).digest("hex");
  const dir = join(repoDir, ".git", "objects", id.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id.slice(2)), deflateSync(store));
  return id;
}

function teamYaml(name: string): string {
  return stringifyYaml({
    name,
    description: `${name} team`,
    members: [{ name: "worker", label: "Worker", systemPrompt: "Do work" }],
  });
}

describe("阶段 2：/team sync 集成（真实 git，裸仓库做云端）", () => {
  let base: string;
  let rootDir: string;
  let teamsDir: string;
  let remoteDir: string;
  let scratchSeq: number;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "sync-it-"));
    rootDir = join(base, "root");
    teamsDir = getTeamsDir(rootDir);
    remoteDir = join(base, "remote.git");
    scratchSeq = 0;
    mkdirSync(teamsDir, { recursive: true });
    gitCli(base, ["init", "--bare", "-q", remoteDir]);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });

  // ── 工具 ────────────────────────────────────────────────

  function saveEnv(key: string): void {
    savedEnv[key] = process.env[key];
  }

  function configure(remoteUrl = remoteDir, branch = ""): void {
    saveSyncConfig({ enabled: true, remoteUrl, branch }, rootDir);
  }

  /** 用 scratch 仓库向裸仓库推送一次提交（模拟「另一台机器」）。 */
  function cloneRemote(branch = "main"): string {
    const scratch = join(base, `scratch-${scratchSeq++}`);
    gitCli(base, ["clone", "-q", "--branch", branch, remoteDir, scratch]);
    return scratch;
  }

  function remoteCommit(files: Record<string, string>, message = "remote change", branch = "main"): void {
    const scratch = cloneRemote(branch);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(scratch, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", message]);
    gitCli(scratch, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  }

  /** 初始化一个非空裸仓库（可选指定默认分支）。 */
  function seedRemote(files: Record<string, string>, branch = "main"): void {
    const scratch = join(base, `seed-${scratchSeq++}`);
    mkdirSync(scratch, { recursive: true });
    gitCli(scratch, ["init", "-q"]);
    gitCli(scratch, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(scratch, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "seed"]);
    gitCli(scratch, ["remote", "add", "--", "origin", remoteDir]);
    gitCli(scratch, ["push", "-q", "origin", `${branch}:refs/heads/${branch}`]);
    gitCli(remoteDir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  }

  function remoteFile(path: string, branch = "main"): string {
    return gitCli(remoteDir, ["show", `${branch}:${path}`]);
  }

  function remoteHas(path: string, branch = "main"): boolean {
    try {
      gitCli(remoteDir, ["cat-file", "-e", `${branch}:${path}`]);
      return true;
    } catch {
      return false;
    }
  }

  function remoteBranches(): string[] {
    return gitCli(remoteDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .trim()
      .split("\n")
      .filter(Boolean);
  }

  function writeLocal(rel: string, content: string): void {
    const abs = join(teamsDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  function readLocal(rel: string): string {
    return readFileSync(join(teamsDir, rel), "utf-8");
  }

  function localHead(): string {
    return gitCli(teamsDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  }

  function localSha(): string {
    return gitCli(teamsDir, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
  }

  function makeHarness(options?: {
    confirm?: (title: string, message: string) => boolean | Promise<boolean>;
    input?: () => string | undefined | Promise<string | undefined>;
  }): {
    ctx: ExtensionCommandContext;
    notify: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
  } {
    const notify = vi.fn();
    const confirm = vi.fn(options?.confirm ?? (async () => true));
    const input = vi.fn(options?.input ?? (async () => undefined));
    const select = vi.fn(async () => undefined);
    const ctx = createMockContext();
    ctx.ui.notify = notify as never;
    ctx.ui.confirm = confirm as never;
    ctx.ui.input = input as never;
    ctx.ui.select = select as never;
    return { ctx: ctx as unknown as ExtensionCommandContext, notify, confirm, input, select };
  }

  async function sync(
    ctx: ExtensionCommandContext,
    deps?: { runGit?: typeof runGit }
  ): Promise<void> {
    await handleSyncCommand(ctx, "", { rootDir, ...deps });
  }

  function notifyText(notify: ReturnType<typeof vi.fn>): string {
    return notify.mock.calls.map((c) => String(c[0])).join("\n");
  }

  // ── 验收 1：首次接入三类起点 ──────────────────────────────

  it("1a 首次接入（仅本机 + 远端有 README/远端独占团队）→ 上传成功且远端内容保持在远端树中", async () => {
    seedRemote({ "README.md": "cloud readme\n", "remote-only.yaml": teamYaml("remote-only") });
    configure();
    writeLocal("a.yaml", teamYaml("a"));

    const { ctx, notify, confirm } = makeHarness();
    await sync(ctx);

    expect(remoteHas("a.yaml")).toBe(true);
    // 回归断言：远端 README 与远端独有团队未被推送删除
    expect(remoteHas("README.md")).toBe(true);
    expect(remoteHas("remote-only.yaml")).toBe(true);
    expect(readLocal("remote-only.yaml")).toContain("name: remote-only");
    expect(notifyText(notify)).toContain("云同步完成");
    expect(confirm).toHaveBeenCalled(); // 首次接入上传需确认
  });

  it("1b 首次接入（仅云端，新机器）→ 全量下载，零交互", async () => {
    seedRemote({ "b.yaml": teamYaml("b"), "README.md": "r\n" });
    configure();

    const { ctx, notify, confirm, input } = makeHarness();
    await sync(ctx);

    expect(readLocal("b.yaml")).toContain("name: b");
    expect(readLocal("README.md")).toBe("r\n");
    expect(confirm).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(notifyText(notify)).toContain("云同步完成");
  });

  it("1c 首次接入（两边都有，无冲突）→ 一次同步双向完成", async () => {
    seedRemote({ "r.yaml": teamYaml("r") });
    configure();
    writeLocal("l.yaml", teamYaml("l"));

    const { ctx } = makeHarness();
    await sync(ctx);

    expect(readLocal("r.yaml")).toContain("name: r");
    expect(remoteHas("l.yaml")).toBe(true);
    expect(remoteHas("r.yaml")).toBe(true);
  });

  // ── 验收 2：仅远端改 / 仅本机改 / 两边改不同团队 ───────────

  it("2a 仅远端改 → 自动下载；2b 仅本机改 → 自动上传", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx); // 首次接入

    // 仅远端改
    remoteCommit({ "a.yaml": teamYaml("a") + "# remote edit\n" });
    await sync(makeHarness().ctx);
    expect(readLocal("a.yaml")).toContain("# remote edit");

    // 仅本机改
    writeLocal("b.yaml", teamYaml("b"));
    await sync(makeHarness().ctx);
    expect(remoteHas("b.yaml")).toBe(true);
  });

  it("2c 两边改不同团队 → 一次同步双向完成且零交互", async () => {
    seedRemote({ "r.yaml": teamYaml("r"), "l.yaml": teamYaml("l") });
    configure();
    await sync(makeHarness().ctx);

    remoteCommit({ "r.yaml": teamYaml("r") + "# remote\n" });
    writeLocal("l.yaml", teamYaml("l") + "# local\n");

    const { ctx, notify, confirm, input, select } = makeHarness();
    await sync(ctx);

    expect(readLocal("r.yaml")).toContain("# remote");
    expect(remoteFile("l.yaml")).toContain("# local");
    expect(confirm).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(notifyText(notify)).toContain("云同步完成");
  });

  // ── 验收 3：删除传播 ────────────────────────────────────

  it("3a/3b/3c 删除传播：本机删→云端删；云端删→本机删；两边都删无提示", async () => {
    seedRemote({ "a.yaml": teamYaml("a"), "b.yaml": teamYaml("b"), "c.yaml": teamYaml("c") });
    configure();
    await sync(makeHarness().ctx);

    // 本机删 a → 云端删（需确认）
    unlinkSync(join(teamsDir, "a.yaml"));
    const first = makeHarness();
    await sync(first.ctx);
    expect(remoteHas("a.yaml")).toBe(false);
    expect(first.confirm).toHaveBeenCalled();

    // 云端删 b → 本机删
    const scratch = cloneRemote("main");
    unlinkSync(join(scratch, "b.yaml"));
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "remove b"]);
    gitCli(scratch, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    await sync(makeHarness().ctx);
    expect(existsSync(join(teamsDir, "b.yaml"))).toBe(false);

    // 两边都删 c → 无提示
    const delScratch = cloneRemote("main");
    unlinkSync(join(delScratch, "c.yaml"));
    gitCli(delScratch, ["add", "-A"]);
    gitCli(delScratch, [...GIT_ID, "commit", "-qm", "remove c remotely"]);
    gitCli(delScratch, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    unlinkSync(join(teamsDir, "c.yaml"));
    const both = makeHarness();
    await sync(both.ctx);
    expect(remoteHas("c.yaml")).toBe(false);
    expect(both.confirm).not.toHaveBeenCalled();
  });

  // ── 验收 4：空云端 ──────────────────────────────────────

  it("4 空云端（无任何提交）→ 本地建首提交并推送，分支名符合探测结果（main）", async () => {
    configure();
    writeLocal("a.yaml", teamYaml("a"));

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    expect(remoteBranches()).toEqual(["main"]);
    expect(remoteHas("a.yaml")).toBe(true);
    expect(notifyText(notify)).toContain("云同步完成");
  });

  it("4b 空云端 + 配置分支 trunk → 使用配置分支", async () => {
    configure(remoteDir, "trunk");
    writeLocal("a.yaml", teamYaml("a"));
    await sync(makeHarness().ctx);
    expect(remoteBranches()).toEqual(["trunk"]);
  });

  // ── 验收 5：分支发现与对齐 ──────────────────────────────

  it("5a 远端 HEAD 悬挂 → 回退到唯一分支", async () => {
    seedRemote({ "a.yaml": teamYaml("a") }, "trunk");
    gitCli(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/nonexistent"]);
    configure();
    writeLocal("l.yaml", teamYaml("l"));

    await sync(makeHarness().ctx);
    expect(remoteHas("l.yaml", "trunk")).toBe(true);
    expect(localHead()).toBe("trunk");
  });

  it("5b 本地默认分支名与远端不一致 → 对齐（不推错分支、不重复建分支）", async () => {
    seedRemote({ "r.yaml": teamYaml("r") }, "main");
    // 手工初始化本地仓库（默认分支 master）并提交
    gitCli(teamsDir, ["init", "-q"]);
    gitCli(teamsDir, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    writeLocal("l.yaml", teamYaml("l"));
    gitCli(teamsDir, ["add", "-A"]);
    gitCli(teamsDir, [...GIT_ID, "commit", "-qm", "local master"]);
    configure();

    await sync(makeHarness().ctx);

    expect(localHead()).toBe("main");
    expect(remoteBranches()).toEqual(["main"]);
    expect(remoteHas("l.yaml")).toBe(true);
    expect(readLocal("r.yaml")).toContain("name: r");
  });

  // ── 验收 6：推送被拒 → 报告 + 重跑收敛 ──────────────────

  it("6 推送被拒（窗口内另一台机器先推）→ 本地已提交未推送；重跑成功且零交互", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    writeLocal("a.yaml", teamYaml("a") + "# mine\n");

    let raced = false;
    const racingRunGit: typeof runGit = async (args, options) => {
      if (!raced && args[0] === "push") {
        raced = true;
        remoteCommit({ "z.yaml": teamYaml("z") }, "other machine");
      }
      return runGit(args, options);
    };
    const first = makeHarness();
    await sync(first.ctx, { runGit: racingRunGit });
    const firstText = notifyText(first.notify);
    expect(raced).toBe(true);
    expect(firstText).toContain("尚未推送");
    expect(remoteHas("z.yaml")).toBe(true);
    expect(remoteFile("a.yaml")).not.toContain("# mine");

    // 重跑：fetch 到另一台机器的提交 → 无冲突收敛 → 推送成功
    const second = makeHarness();
    await sync(second.ctx);
    expect(notifyText(second.notify)).toContain("本地已推送");
    expect(remoteFile("a.yaml")).toContain("# mine");
    expect(remoteHas("z.yaml")).toBe(true);
    expect(second.confirm).not.toHaveBeenCalled();
  });

  // ── 验收 7：取消 → 零改动 ───────────────────────────────

  it("7 计划确认被取消 → 工作区/索引/分支引用均未变", async () => {
    seedRemote({ "a.yaml": teamYaml("a"), "b.yaml": teamYaml("b") });
    configure();
    await sync(makeHarness().ctx);

    writeLocal("a.yaml", teamYaml("a") + "# local edit\n");
    unlinkSync(join(teamsDir, "b.yaml"));

    const indexBefore = readFileSync(join(teamsDir, ".git", "index"));
    const headBefore = localSha();
    const aContentBefore = readLocal("a.yaml");

    const { ctx, notify, confirm } = makeHarness({ confirm: async () => false });
    await sync(ctx);

    expect(confirm).toHaveBeenCalled();
    expect(readLocal("a.yaml")).toBe(aContentBefore);
    expect(existsSync(join(teamsDir, "b.yaml"))).toBe(false); // 用户的删除动作保留
    expect(Buffer.compare(readFileSync(join(teamsDir, ".git", "index")), indexBefore)).toBe(0);
    expect(localSha()).toBe(headBefore);
    expect(remoteFile("b.yaml")).toContain("name: b");
    expect(notifyText(notify)).toContain("已取消");
  });

  // ── 验收 8：计划期间外部修改 → 应用前中止 ────────────────

  it("8 计划/决策期间外部修改 YAML → 应用前中止、零改动", async () => {
    seedRemote({ "a.yaml": teamYaml("a"), "c.yaml": teamYaml("c") });
    configure();
    await sync(makeHarness().ctx);

    unlinkSync(join(teamsDir, "a.yaml")); // 触发删除确认（需要用户决策）
    const headBefore = localSha();

    const { ctx, notify } = makeHarness({
      confirm: async () => {
        writeLocal("c.yaml", teamYaml("c") + "# external edit\n"); // 决策期间外部修改
        return true;
      },
    });
    await sync(ctx);

    expect(notifyText(notify)).toContain("发生变化");
    expect(readLocal("c.yaml")).toContain("# external edit");
    expect(localSha()).toBe(headBefore);
    expect(remoteHas("a.yaml")).toBe(true); // 删除未传播
  });

  // ── 验收 9：并发 ────────────────────────────────────────

  it("9a 另一同步实例持锁 → 可读提示、零改动", async () => {
    configure();
    writeLocal("a.yaml", teamYaml("a"));
    writeFileSync(
      join(rootDir, "sync.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: hostname(), token: "other" }),
      "utf-8"
    );

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    expect(notifyText(notify)).toContain("另一个同步实例正在运行");
    expect(remoteBranches()).toEqual([]); // 远端未被触碰
  });

  it("9b index.lock 存在 → 可读报错且不建议删别人的锁", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    writeFileSync(join(teamsDir, ".git", "index.lock"), "", "utf-8");
    const { ctx, notify } = makeHarness();
    await sync(ctx);

    const text = notifyText(notify);
    expect(text).toContain("index.lock");
    expect(text).toContain("不要删除正在被使用的锁");
    rmSync(join(teamsDir, ".git", "index.lock"), { force: true });
  });

  // ── 验收 10：非法 YAML ──────────────────────────────────

  it("10 非法 YAML（本机/远端）→ 照常落地 + 明确报警", async () => {
    // 本机非法
    writeLocal("bad.yaml", "name: bad\ndescription: x\nmembers: []\n");
    configure();
    const localHarness = makeHarness();
    await sync(localHarness.ctx);
    const localText = notifyText(localHarness.notify);
    expect(localText).toContain("校验失败");
    expect(localText).toContain("bad.yaml");
    // 文案写明真实后果（偏差 2）
    expect(localText).toContain("/team list 仍列出该名，但 /team start 报「团队不存在」，修复后即可用");
    expect(remoteHas("bad.yaml")).toBe(true);

    // 远端非法
    remoteCommit({ "bad2.yaml": "name: bad2\ndescription: x\nmembers: []\n" }, "bad remote");
    const remoteHarness = makeHarness();
    await sync(remoteHarness.ctx);
    const remoteText = notifyText(remoteHarness.notify);
    expect(existsSync(join(teamsDir, "bad2.yaml"))).toBe(true);
    expect(remoteText).toContain("校验失败");
    expect(remoteText).toContain("bad2.yaml");
  });

  // ── 验收 11：特殊文件名 ─────────────────────────────────

  it("11 文件名含空格/中文 → 计划、应用、摘要全部正确", async () => {
    seedRemote({ "remote team.yaml": teamYaml("remote team") });
    configure();
    writeLocal("我的 团队.yaml", teamYaml("我的 团队"));

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    expect(existsSync(join(teamsDir, "remote team.yaml"))).toBe(true);
    expect(remoteHas("我的 团队.yaml")).toBe(true);
    const text = notifyText(notify);
    expect(text).toContain("我的 团队"); // 摘要按字面展示
  });

  // ── 验收 12：备份恢复演练 ───────────────────────────────

  it("12 删除整个 teams/ 后 /team sync 全量恢复", async () => {
    seedRemote({ "a.yaml": teamYaml("a"), "sub/b.yaml": teamYaml("b") });
    configure();
    await sync(makeHarness().ctx);
    const expectedA = readLocal("a.yaml");

    rmSync(teamsDir, { recursive: true, force: true });
    expect(existsSync(teamsDir)).toBe(false);

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    expect(readLocal("a.yaml")).toBe(expectedA);
    expect(existsSync(join(teamsDir, "sub", "b.yaml"))).toBe(true);
    expect(notifyText(notify)).toContain("云同步完成");
  });

  it("应用阶段失败 → 回滚已写文件、不动引用、未做任何改动", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    // 远端新增两个团队；注入：第二个 blob 读取失败（第一个已写盘）
    remoteCommit({ "x.yaml": teamYaml("x"), "y.yaml": teamYaml("y") }, "two new teams");
    let catFileCalls = 0;
    const failingRunGit: typeof runGit = async (args, options) => {
      if (args[0] === "cat-file") {
        catFileCalls++;
        if (catFileCalls === 2) {
          return {
            ok: false,
            stdout: "",
            stderr: "fatal: bad object (injected)",
            code: 128,
            timedOut: false,
            outputLimitExceeded: false,
            command: "git cat-file blob <injected>",
          };
        }
      }
      return runGit(args, options);
    };

    const headBefore = localSha();
    const { ctx, notify } = makeHarness();
    await sync(ctx, { runGit: failingRunGit });

    const text = notifyText(notify);
    expect(text).toContain("云同步失败");
    expect(text).toContain("已回滚，未做任何改动");
    // 第一个（已写盘）文件被回滚删除；引用未动
    expect(existsSync(join(teamsDir, "x.yaml"))).toBe(false);
    expect(existsSync(join(teamsDir, "y.yaml"))).toBe(false);
    expect(localSha()).toBe(headBefore);
    expect(remoteHas("x.yaml")).toBe(true); // 远端内容未被同步动作影响
  });

  it("首次接入时位于外层 git 仓库内 → 明确警告（不静默降级）", async () => {
    // 外层仓库
    gitCli(base, ["init", "-q", rootDir]);
    seedRemote({ "r.yaml": teamYaml("r") });
    configure();
    writeLocal("l.yaml", teamYaml("l"));

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    const text = notifyText(notify);
    expect(text).toContain("外层仓库");
    expect(text).toContain("嵌入式仓库");
    // 同步仍然完成（警告不降级为阻断）
    expect(remoteHas("l.yaml")).toBe(true);
  });

  // ── 验收 13：状态查询（真实数据） ────────────────

  it("13 状态查询：远端领先 / 本地未提交 / 异常文件 / 仓库正常", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    writeLocal("a.yaml", teamYaml("a") + "# dirty\n");
    writeLocal("bad.yaml", "name: bad\ndescription: x\nmembers: []\n");
    remoteCommit({ "remote.yaml": teamYaml("remote") }, "remote ahead");

    const { ctx, notify } = makeHarness();
    await handleSyncCommand(ctx, "status", { rootDir });
    const text = notifyText(notify);
    expect(text).toContain("云同步状态");
    expect(text).toContain("配置：已配置（启用）");
    expect(text).toContain("（已脱敏）");
    expect(text).toContain("远端：落后 1 个提交");
    expect(text).toContain("2 个团队有未提交改动");
    expect(text).toContain("异常：1 个团队文件校验失败（bad.yaml");
    expect(text).toContain("仓库：正常");
  });

  // ── 验收 14：身份缺失 ───────────────────────────────────

  it("14 身份缺失 → 兜底身份提交成功、摘要附注、不改用户全局 git 配置", async () => {
    const emptyHome = join(base, "empty-home");
    mkdirSync(emptyHome, { recursive: true });
    for (const key of ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
      saveEnv(key);
      delete process.env[key];
    }
    process.env.HOME = emptyHome;
    process.env.XDG_CONFIG_HOME = join(emptyHome, ".config");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    savedEnv.GIT_CONFIG_NOSYSTEM = undefined;

    configure();
    writeLocal("a.yaml", teamYaml("a"));

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    const text = notifyText(notify);
    expect(text).toContain("兜底身份");
    expect(text).toContain("云同步完成");
    const author = gitCli(teamsDir, ["log", "-1", "--format=%an <%ae>"]).trim();
    expect(author).toBe("pi-top-notch-team <pi-top-notch-team@localhost>");
    // 未修改用户全局 git 配置
    expect(existsSync(join(emptyHome, ".gitconfig"))).toBe(false);
  });

  // ── 复审回归（阶段 2 返工） ─────────────────────────────

  it("换远端地址 → 备份引用真实创建、旧历史可从该 ref 检出（审查 #1）", async () => {
    seedRemote({ "r1.yaml": teamYaml("r1") });
    configure(remoteDir);
    writeLocal("mine.yaml", teamYaml("mine"));
    await sync(makeHarness().ctx);
    const oldTip = localSha();

    // 第二台「云端」+ 配置改为它 → 需确认 → 同步
    const remote2 = join(base, "remote2.git");
    gitCli(base, ["init", "--bare", "-q", remote2]);
    saveSyncConfig({ enabled: true, remoteUrl: remote2, branch: "" }, rootDir);

    const { ctx, notify, confirm } = makeHarness();
    await sync(ctx);

    expect(confirm).toHaveBeenCalled(); // 地址不一致 → 明确确认
    const backups = gitCli(teamsDir, ["for-each-ref", "--format=%(refname)", "refs/sync-backup"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(backups.length).toBeGreaterThan(0);
    // 旧历史可从备份引用检出（内容与旧 tip 一致）
    const backupTip = gitCli(teamsDir, ["rev-parse", backups[0]]).trim();
    expect(backupTip).toBe(oldTip);
    expect(gitCli(teamsDir, ["show", `${backups[0]}:mine.yaml`])).toContain("name: mine");
    // 新远端只拿到「本地当前树 + 决策」，旧历史未被推过去
    expect(gitCli(remote2, ["for-each-ref", "--format=%(refname)", "refs/heads"]).trim()).toBe("refs/heads/main");
    expect(gitCli(remote2, ["ls-tree", "-r", "--name-only", "main"])).toContain("mine.yaml");
    // 备份引用也写入摘要
    expect(notifyText(notify)).toContain("备份引用");
  });

  it("远端树含危险路径（../escape.yaml）→ 任何落盘前拒绝、零越界写入（审查 #3）", async () => {
    // 构造恶意树：手工写 loose tree 对象（mktree 会拒绝，fetch 默认不 fsck）
    const scratch = join(base, `evil-${scratchSeq++}`);
    mkdirSync(scratch, { recursive: true });
    gitCli(scratch, ["init", "-q"]);
    gitCli(scratch, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    writeFileSync(join(scratch, "safe.txt"), "safe\n", "utf-8");
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "seed"]);
    const blobSha = gitCli(scratch, ["hash-object", "-w", "safe.txt"]).trim();
    const evilTree = craftMaliciousTree(scratch, blobSha, "../escape.yaml");
    const evilCommit = gitCli(scratch, [...GIT_ID, "commit-tree", evilTree, "-m", "crafted"]).trim();
    gitCli(scratch, ["remote", "add", "--", "origin", remoteDir]);
    gitCli(scratch, ["push", "-q", "origin", `${evilCommit}:refs/heads/main`]);
    gitCli(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    // 哨兵：rootDir 下的同名文件不得被触碰
    const sentinel = join(rootDir, "escape.yaml");
    writeFileSync(sentinel, "SENTINEL-DO-NOT-OVERWRITE", "utf-8");
    configure();

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    expect(readFileSync(sentinel, "utf-8")).toBe("SENTINEL-DO-NOT-OVERWRITE");
    expect(existsSync(join(teamsDir, "escape.yaml"))).toBe(false);
    expect(existsSync(join(base, "escape.yaml"))).toBe(false);
    const text = notifyText(notify);
    expect(text).toContain("危险路径");
    expect(text).toContain("云同步失败");
    expect(existsSync(join(teamsDir, "safe.txt"))).toBe(false); // 已回滚
  });

  it("非文本文件（二进制）passthrough 字节级不损坏（审查 #4）", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0xfe, 0x80, 0x00, 0x01]);
    const scratch = join(base, `bin-${scratchSeq++}`);
    mkdirSync(scratch, { recursive: true });
    gitCli(scratch, ["init", "-q"]);
    gitCli(scratch, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    writeFileSync(join(scratch, "logo.bin"), bytes);
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "binary"]);
    gitCli(scratch, ["remote", "add", "--", "origin", remoteDir]);
    gitCli(scratch, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    gitCli(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    configure();
    await sync(makeHarness().ctx);

    expect(readFileSync(join(teamsDir, "logo.bin"))).toEqual(bytes);
  });

  it("status 不改写 FETCH_HEAD（审查 #5）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    const fetchHeadPath = join(teamsDir, ".git", "FETCH_HEAD");
    writeFileSync(fetchHeadPath, "SENTINEL-FETCH-HEAD", "utf-8");
    const { ctx } = makeHarness();
    await handleSyncCommand(ctx, "status", { rootDir, statusTimeoutMs: 15_000 });

    expect(readFileSync(fetchHeadPath, "utf-8")).toBe("SENTINEL-FETCH-HEAD");
  });

  it("本地无分支时 status 显示落后而非「未检查」（审查 #10）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    // 只初始化仓库并接入远端，不创建本地分支
    gitCli(teamsDir, ["init", "-q"]);
    gitCli(teamsDir, ["remote", "add", "--", "origin", remoteDir]);
    gitCli(teamsDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    const { ctx, notify } = makeHarness();
    await handleSyncCommand(ctx, "status", { rootDir, statusTimeoutMs: 15_000 });
    expect(notifyText(notify)).toContain("远端：落后 1 个提交");
  });

  it("远端地址尾部斜杠视为等价 → 不触发换地址确认（审查 #12）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    saveSyncConfig({ enabled: true, remoteUrl: `${remoteDir}/`, branch: "" }, rootDir);
    const { ctx, confirm, notify } = makeHarness();
    await sync(ctx);

    expect(confirm).not.toHaveBeenCalled();
    expect(notifyText(notify)).toContain("已是最新");
  });

  it("空远端 + 本地历史已一致 → 直接推现有 tip，不造空内容提交（审查 #9）", async () => {
    // 本地手工建仓 + 提交
    gitCli(teamsDir, ["init", "-q"]);
    writeLocal("a.yaml", teamYaml("a"));
    gitCli(teamsDir, ["add", "-A"]);
    gitCli(teamsDir, [...GIT_ID, "commit", "-qm", "local"]);
    const tipBefore = localSha();
    configure();

    const { ctx } = makeHarness();
    await sync(ctx);

    expect(localSha()).toBe(tipBefore); // 未新建提交
    expect(remoteBranches()).toEqual(["main"]);
    expect(gitCli(remoteDir, ["rev-parse", "refs/heads/main"]).trim()).toBe(tipBefore);
  });

  it("索引刷新失败独立于推送失败：仍尝试推送并单独报告（审查 #8）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    writeLocal("a.yaml", teamYaml("a") + "# local\n");

    let resetFailed = false;
    const failingReset: typeof runGit = async (args, options) => {
      if (!resetFailed && args[0] === "reset") {
        resetFailed = true;
        return {
          ok: false,
          stdout: "",
          stderr: "fatal: Unable to create '.git/index.lock': File exists (injected)",
          code: 128,
          timedOut: false,
          outputLimitExceeded: false,
          command: "git reset --mixed --quiet",
        };
      }
      return runGit(args, options);
    };

    const { ctx, notify } = makeHarness();
    await sync(ctx, { runGit: failingReset });

    const text = notifyText(notify);
    expect(resetFailed).toBe(true);
    expect(text).toContain("索引刷新失败");
    expect(text).not.toContain("尚未推送"); // 不是推送失败
    expect(remoteFile("a.yaml")).toContain("# local"); // 仍完成推送
  });

  it("非团队文件：本机改动被云端覆盖有提示；远端删除时本地版本保留（审查 #6）", async () => {
    seedRemote({ "README.md": "cloud v1\n" });
    configure();
    await sync(makeHarness().ctx);

    // 本机 + 云端同时改 README → 本机改动不上传（云端为准）且有提示
    writeLocal("README.md", "local edit\n");
    remoteCommit({ "README.md": "cloud v2\n" }, "remote readme");
    const first = makeHarness();
    await sync(first.ctx);
    const firstText = notifyText(first.notify);
    expect(readLocal("README.md")).toBe("cloud v2\n");
    expect(firstText).toContain("非团队文件（云端为准）");
    expect(firstText).toContain("非团队文件的本机改动不会被上传");

    // 云端删除 README → 本地已跟踪版本保留（不孤儿化）且有提示
    const scratch = join(base, `rm-readme-${scratchSeq++}`);
    gitCli(base, ["clone", "-q", "--branch", "main", remoteDir, scratch]);
    unlinkSync(join(scratch, "README.md"));
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "remove readme"]);
    gitCli(scratch, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const second = makeHarness();
    await sync(second.ctx);
    expect(existsSync(join(teamsDir, "README.md"))).toBe(true);
    expect(notifyText(second.notify)).toContain("保留本地独有已跟踪文件");
  });

  it("本机文件名含反斜杠 → 跳过 + 危险路径提示，两次同步均成功（复审回归 #1）", async () => {
    seedRemote({ "remote.yaml": teamYaml("remote") });
    configure();
    writeLocal("a.yaml", teamYaml("a"));
    writeLocal("weird\\name.yaml", teamYaml("weird")); // POSIX 合法文件名（含反斜杠）

    const first = makeHarness();
    await sync(first.ctx);
    const firstText = notifyText(first.notify);
    expect(firstText).toContain("云同步完成");
    expect(firstText).toContain("危险路径");
    expect(firstText).toContain("weird\\name.yaml");
    expect(remoteHas("a.yaml")).toBe(true);
    expect(remoteHas("remote.yaml")).toBe(true);
    expect(remoteHas("weird\\name.yaml")).toBe(false); // 跳过，不上传
    expect(existsSync(join(teamsDir, "weird\\name.yaml"))).toBe(true); // 本机文件不动

    // 第二次运行：不得再报「计划期间文件发生变化」而永久失败
    const second = makeHarness();
    await sync(second.ctx);
    const secondText = notifyText(second.notify);
    expect(secondText).toContain("危险路径");
    expect(secondText).not.toContain("云同步失败");
    expect(secondText).toContain("已是最新");
  });

  it("非团队文件被云端覆盖前留档本机版本（偏差 1）", async () => {
    seedRemote({ "README.md": "cloud v1\n" });
    configure();
    await sync(makeHarness().ctx);

    const localVersion = "本机原内容 local v1\n";
    writeLocal("README.md", localVersion);
    remoteCommit({ "README.md": "cloud v2\n" }, "remote readme v2");

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    const archiveDir = join(rootDir, "sync-conflicts");
    const archived = readdirSync(archiveDir);
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^README\.md-[0-9a-f]{8}\./);
    expect(readFileSync(join(archiveDir, archived[0]), "utf-8")).toBe(localVersion);
    expect(readLocal("README.md")).toBe("cloud v2\n"); // 云端为准仍然成立

    const text = notifyText(notify);
    expect(text).toContain("留档：1 个非团队文件的本机版本（README.md → ");
    expect(text).toContain(archived[0]);
    expect(text).toContain("sync-conflicts");

    // 建议 #4：status 的归档计数必须看得见这类留档（此前只数 *.yaml）
    const statusHarness = makeHarness();
    await handleSyncCommand(statusHarness.ctx, "status", { rootDir, statusTimeoutMs: 15_000 });
    expect(notifyText(statusHarness.notify)).toContain("归档：1 个冲突留档待清理");
  });

  it("两条不同路径同一同步内归档 → 不撞名、内容各自正确（归档命名碰撞回归）", async () => {
    seedRemote({ "说明.md": "cloud 说明 v1\n", "指南.md": "cloud 指南 v1\n" });
    configure();
    await sync(makeHarness().ctx);

    // 本机改两个中文名文件；云端同时改（本机改动不上传、覆盖前留档）
    const localNotes = "本机 说明 原内容\n";
    const localGuide = "本机 指南 原内容\n";
    writeLocal("说明.md", localNotes);
    writeLocal("指南.md", localGuide);
    remoteCommit({ "说明.md": "cloud 说明 v2\n", "指南.md": "cloud 指南 v2\n" }, "remote both");

    const { ctx, notify } = makeHarness();
    await sync(ctx);

    const archiveDir = join(rootDir, "sync-conflicts");
    const archived = readdirSync(archiveDir).sort();
    expect(archived.length).toBe(2); // 同秒也不再互相覆盖
    const notesArchive = archived.find((f) => f.startsWith("说明.md-"));
    const guideArchive = archived.find((f) => f.startsWith("指南.md-"));
    expect(notesArchive).toBeDefined();
    expect(guideArchive).toBeDefined();
    expect(readFileSync(join(archiveDir, notesArchive as string), "utf-8")).toBe(localNotes);
    expect(readFileSync(join(archiveDir, guideArchive as string), "utf-8")).toBe(localGuide);
    expect(readLocal("说明.md")).toBe("cloud 说明 v2\n");
    expect(readLocal("指南.md")).toBe("cloud 指南 v2\n");
  });

  it("失败回滚同时清掉本次留档（措辞「未做任何改动」属实，建议 #2）", async () => {
    seedRemote({ "a.yaml": teamYaml("a"), "README.md": "cloud v1\n" });
    configure();
    await sync(makeHarness().ctx);

    // 本机改 README（非团队 → 覆盖前留档）+ 改团队 YAML（→ 需要构造提交）
    writeLocal("README.md", "本机原内容\n");
    writeLocal("a.yaml", teamYaml("a") + "# local\n");
    remoteCommit({ "README.md": "cloud v2\n" }, "remote readme v2");

    const failingCommit: typeof runGit = async (args, options) => {
      if (args.includes("commit-tree")) {
        return {
          ok: false,
          stdout: "",
          stderr: "fatal: injected commit-tree failure",
          code: 128,
          timedOut: false,
          outputLimitExceeded: false,
          command: "git commit-tree <injected>",
        };
      }
      return runGit(args, options);
    };

    const { ctx, notify } = makeHarness();
    await sync(ctx, { runGit: failingCommit });

    const text = notifyText(notify);
    expect(text).toContain("云同步失败");
    expect(text).toContain("已回滚，未做任何改动");
    // 本机内容被还原（README 与 a.yaml）；本次新建的留档一并清除（不留冗余文件）
    expect(readLocal("README.md")).toBe("本机原内容\n");
    expect(readLocal("a.yaml")).toContain("# local");
    const archiveDir = join(rootDir, "sync-conflicts");
    expect(existsSync(archiveDir) ? readdirSync(archiveDir).length : 0).toBe(0);
  });

  it("keptLocalPaths 只统计仍存在的路径；本机已删除的已跟踪文件不再声称保留（复审建议 #2）", async () => {
    // notes.md 从远端下发并被本地分支跟踪（非团队文件：本机新增的散落文件不会上传）
    seedRemote({ "a.yaml": teamYaml("a"), "notes.md": "notes v1\n" });
    configure();
    await sync(makeHarness().ctx);
    expect(existsSync(join(teamsDir, "notes.md"))).toBe(true);

    // 远端删除 notes.md，本机仍保留 → 同步保留并提示
    const scratch = cloneRemote("main");
    unlinkSync(join(scratch, "notes.md"));
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "remove notes"]);
    gitCli(scratch, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const kept = makeHarness();
    await sync(kept.ctx);
    expect(notifyText(kept.notify)).toContain("保留本地独有已跟踪文件：1（notes.md");
    expect(existsSync(join(teamsDir, "notes.md"))).toBe(true);

    // 远端再次删除 + 本机也删除 → 不得再声称「保留」，且本地树移除该路径
    const scratch2 = cloneRemote("main");
    unlinkSync(join(scratch2, "notes.md"));
    gitCli(scratch2, ["add", "-A"]);
    gitCli(scratch2, [...GIT_ID, "commit", "-qm", "remove notes again"]);
    gitCli(scratch2, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    unlinkSync(join(teamsDir, "notes.md"));

    const dropped = makeHarness();
    await sync(dropped.ctx);
    expect(notifyText(dropped.notify)).not.toContain("保留本地独有已跟踪文件");
    expect(remoteHas("notes.md")).toBe(false);
    const tracked = gitCli(teamsDir, ["ls-tree", "-r", "--name-only", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tracked).not.toContain("notes.md");
  });
});
