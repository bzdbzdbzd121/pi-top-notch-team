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
import { acquireSyncLock } from "./lock";
import { getSyncConfigPath, saveSyncConfig } from "./config";
import { getTeamsDir } from "../team/store";
import { runGit } from "./git-runner";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConflictOption } from "./classify";
import { listTeams } from "../team/store";

// ── 测试硬护栏（阶段 5 复审 #3）：把 git 允许的协议钉死为 file ──
// 本文件所有「云端」都是本地裸仓库路径（零远程 URL）。一旦有人误把远端改成
// https/ssh 地址，git 会立即失败而不是发起真实网络请求 —— 使「测试零真实网络」
// 从人工核对变成持续护栏。（统一执行器会继承 process.env，故这里设置即可生效。）
process.env.GIT_ALLOW_PROTOCOL = "file";

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
    select?: (title: string, labels: string[]) => string | undefined | Promise<string | undefined>;
    mode?: "tui" | "rpc";
    /** 共享事件流（把 cloud-sync 状态写入与 git 调用放进同一条时间线，便于断言先后顺序）。 */
    events?: { kind: "status" | "git"; detail: string }[];
  }): {
    ctx: ExtensionCommandContext;
    notify: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    trace: ProgressTrace;
  } {
    const notify = vi.fn();
    const confirm = vi.fn(options?.confirm ?? (async () => true));
    const input = vi.fn(options?.input ?? (async () => undefined));
    const select = vi.fn(options?.select ?? (async () => undefined));
    const ctx = createMockContext(options?.mode ? ({ mode: options.mode } as never) : undefined);
    ctx.ui.notify = notify as never;
    ctx.ui.confirm = confirm as never;
    ctx.ui.input = input as never;
    ctx.ui.select = select as never;
    const trace = attachProgressTrace(ctx as unknown as ExtensionCommandContext, options?.events);
    return { ctx: ctx as unknown as ExtensionCommandContext, notify, confirm, input, select, trace };
  }

  /** 阶段 2：cloud-sync 状态栏写入追踪（含「对话框打开瞬间的状态值」）。 */
  interface ProgressTrace {
    writes: (string | undefined)[];
    dialogs: { kind: string; text: string | undefined }[];
    current(): string | undefined;
    nonEmpty(): string[];
    hadNoWrite(): boolean;
  }

  function attachProgressTrace(
    ctx: ExtensionCommandContext,
    events?: { kind: "status" | "git"; detail: string }[]
  ): ProgressTrace {
    const writes: (string | undefined)[] = [];
    const dialogs: { kind: string; text: string | undefined }[] = [];
    const trace: ProgressTrace = {
      writes,
      dialogs,
      current: () => (writes.length > 0 ? writes[writes.length - 1] : undefined),
      nonEmpty: () => writes.filter((w): w is string => typeof w === "string" && w.length > 0),
      hadNoWrite: () => writes.length === 0,
    };
    ctx.ui.setStatus = ((key: string, text: string | undefined) => {
      if (key !== "cloud-sync") return;
      writes.push(text);
      events?.push({ kind: "status", detail: text ?? "(clear)" });
    }) as never;
    const wrapDialog = (kind: string, original: unknown): ((...args: unknown[]) => unknown) => async (
      ...args: unknown[]
    ) => {
      dialogs.push({ kind, text: trace.current() });
      return typeof original === "function" ? (original as (...a: unknown[]) => unknown)(...args) : undefined;
    };
    ctx.ui.confirm = wrapDialog("confirm", ctx.ui.confirm) as never;
    ctx.ui.select = wrapDialog("select", ctx.ui.select) as never;
    ctx.ui.custom = wrapDialog("custom", ctx.ui.custom) as never;
    (ctx as unknown as { __progressTrace?: ProgressTrace }).__progressTrace = trace;
    return trace;
  }

  /** TUI 路径的对话框记录（installTuiChoice 会替换 ui.custom，需自行记一笔）。 */
  function recordTuiDialog(ctx: ExtensionCommandContext): void {
    const trace = (ctx as unknown as { __progressTrace?: ProgressTrace }).__progressTrace;
    if (trace) trace.dialogs.push({ kind: "custom", text: trace.current() });
  }

  /** RPC 降级路径的选项 mock：按动作值选中对应标签。 */
  function rpcChoice(choice: ConflictOption): (title: string, labels: string[]) => string {
    return (_title, labels) => {
      const found = labels.find((label) => CHOICE_PREFIX[choice].some((prefix) => label.startsWith(prefix)));
      if (!found) throw new Error(`标签未找到：${choice}（可选：${labels.join(" | ")}）`);
      return found;
    };
  }

  /** 同一 option 值在不同形态下标签不同（保留本地/保持删除/保留本机…），全部登记。 */
  const CHOICE_PREFIX: Record<ConflictOption, string[]> = {
    "keep-local": ["保留本地", "保持删除", "保留本机"],
    "take-remote": ["采用远端", "恢复云端", "接受删除"],
    "keep-both": ["两边都留"],
  };

  /** TUI 路径：模拟用户在差异视图里按数字键选动作并 Enter（走真实组件键盘处理）。 */
  function installTuiChoice(ctx: ExtensionCommandContext, choice: ConflictOption | undefined): void {
    (ctx.ui as any).custom = async (factory: any) => {
      recordTuiDialog(ctx);
      let result: ConflictOption | undefined;
      const done = (value: ConflictOption | undefined): void => {
        result = value;
      };
      const component = factory(
        { requestRender: vi.fn() },
        { fg: (_c: string, s: string) => s, bold: (s: string) => s },
        undefined,
        done
      );
      if (choice === undefined) {
        component.handleInput("\u001b");
        return result;
      }
      const index = component.getState().actions.findIndex((a: { value: ConflictOption }) => a.value === choice);
      if (index < 0) throw new Error(`该形态没有 ${choice} 选项：${JSON.stringify(component.getState().actions)}`);
      component.handleInput(String(index + 1));
      component.handleInput("\r");
      return result;
    };
  }

  async function sync(
    ctx: ExtensionCommandContext,
    deps?: { runGit?: typeof runGit; now?: () => Date; getEditingTeamName?: () => string | null }
  ): Promise<void> {
    await handleSyncCommand(ctx, "", { rootDir, ...deps });
  }

  /** 把团队 YAML 的 description 换掉（内容差异可被 YAML 重新序列化保留，便于断言导入内容）。 */
  function withDesc(yaml: string, desc: string): string {
    return yaml.replace(/description: .*/, `description: ${desc}`);
  }

  /** 建立「两边都改」冲突：基线同步 → 本机改 + 云端改（改的是真实字段，不是注释）。 */
  async function setupBothModified(name = "a.yaml", baseline = teamYaml("a")): Promise<void> {
    seedRemote({ [name]: baseline });
    configure();
    await sync(makeHarness().ctx);
    writeLocal(name, withDesc(baseline, "本机描述"));
    remoteCommit({ [name]: withDesc(baseline, "云端描述") }, "remote edit");
  }

  function archiveFiles(): string[] {
    const dir = join(rootDir, "sync-conflicts");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort();
  }

  function archiveContent(prefix: string): string {
    const file = archiveFiles().find((f) => f.startsWith(prefix));
    if (!file) throw new Error(`归档文件未找到（prefix=${prefix}，现有：${archiveFiles().join("、") || "无"}）`);
    return readFileSync(join(rootDir, "sync-conflicts", file), "utf-8");
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

  // ═══════ 阶段 4：冲突决策与留档（验收 1–7）═══════

  it("阶段4-1 两边都改 → 保留本地（上传本机版本、云端版本归档）", async () => {
    await setupBothModified();
    const { ctx, notify } = makeHarness({ mode: "rpc", select: rpcChoice("keep-local") });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });

    const text = notifyText(notify);
    expect(text).toContain("冲突决策：1");
    expect(text).toContain("保留本地");
    expect(readLocal("a.yaml")).toContain("本机描述");
    expect(remoteFile("a.yaml")).toContain("本机描述"); // 本机版本已上传
    expect(archiveContent("a.yaml-")).toContain("云端描述"); // 被放弃的云端版本留档
  });

  it("阶段4-2 两边都改 → 采用远端（本机版本归档、云端版本落地）", async () => {
    await setupBothModified();
    const { ctx } = makeHarness({ mode: "rpc", select: rpcChoice("take-remote") });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });

    expect(readLocal("a.yaml")).toContain("云端描述");
    expect(archiveContent("a.yaml-")).toContain("本机描述"); // 被放弃的本机版本留档
    expect(remoteFile("a.yaml")).toContain("云端描述");
  });

  it("阶段4-3 两边都改 → 两边都留（导为新团队、内部 name 改写、随下一次同步传播）", async () => {
    await setupBothModified();
    const { ctx, notify } = makeHarness({ mode: "rpc", select: rpcChoice("keep-both") });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });

    const imported = "a-remote-20261017";
    expect(existsSync(join(teamsDir, `${imported}.yaml`))).toBe(true);
    const content = readLocal(`${imported}.yaml`);
    expect(content).toContain(`name: ${imported}`); // 内部 name 同步改写
    expect(content).toContain("云端描述"); // 内容来自云端版本
    expect(readLocal("a.yaml")).toContain("本机描述"); // 本机版本继续作为该团队
    expect(archiveContent("a.yaml-")).toContain("云端描述"); // 云端版本另存一份归档
    expect(remoteHas(`${imported}.yaml`)).toBe(true); // 已随本次提交推送
    expect(notifyText(notify)).toContain(`新团队导入：${imported}`);
    expect(notifyText(notify)).toContain("已随本次提交推送，其它机器下次同步可见");

    // 归档目录不被当团队、不参与下一轮同步
    expect(listTeams(rootDir)).not.toContain("sync-conflicts");
    const next = makeHarness();
    await sync(next.ctx);
    expect(notifyText(next.notify)).toContain("已是最新");
  });

  it("阶段4-4 两边都留且已有同名团队/`X.remote` → 唯一名，不覆盖任何文件", async () => {
    writeLocal("a-remote-20261017.yaml", teamYaml("a-remote-20261017"));
    writeLocal("a.remote.yaml", teamYaml("a.remote")); // 合法团队名，必须保留
    const beforeRemote = teamYaml("a");
    seedRemote({ "a.yaml": beforeRemote, "a-remote-20261017.yaml": teamYaml("a-remote-20261017") });
    configure();
    await sync(makeHarness().ctx);
    writeLocal("a.yaml", withDesc(beforeRemote, "本机描述"));
    remoteCommit({ "a.yaml": withDesc(beforeRemote, "云端描述") }, "remote edit");

    const { ctx, notify } = makeHarness({ mode: "rpc", select: rpcChoice("keep-both") });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });

    expect(notifyText(notify)).toContain("a-remote-20261017-2");
    expect(existsSync(join(teamsDir, "a-remote-20261017-2.yaml"))).toBe(true);
    expect(readLocal("a.remote.yaml")).toContain("name: a.remote"); // 既有合法团队未被覆盖
    expect(remoteFile("a-remote-20261017.yaml")).toContain("a-remote-20261017"); // 未被改写
  });

  it("阶段4-5 两边都留但云端版本不合法 → 拒绝导入（只留档）+ 明确报告", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    writeLocal("a.yaml", withDesc(teamYaml("a"), "本机描述"));
    remoteCommit({ "a.yaml": "name: a\ndescription: x\nmembers: []\n" }, "remote invalid");

    const { ctx, notify } = makeHarness({ mode: "rpc", select: rpcChoice("keep-both") });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });

    const text = notifyText(notify);
    expect(text).toContain("未导入");
    expect(text).toContain("团队校验失败");
    expect(existsSync(join(teamsDir, "a-remote-20261017.yaml"))).toBe(false); // 不写入 teams/
    expect(archiveContent("a.yaml-")).toContain("members: []"); // 只留档
    expect(readLocal("a.yaml")).toContain("本机描述");
  });

  it("阶段4-6 本机删+云端改：保持删除（云端版本归档、提交树删除）；恢复云端（取回）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    unlinkSync(join(teamsDir, "a.yaml"));
    remoteCommit({ "a.yaml": withDesc(teamYaml("a"), "云端描述") }, "remote edit");

    const keepDeleted = makeHarness({ mode: "rpc", select: rpcChoice("keep-local") });
    await sync(keepDeleted.ctx, { now: () => new Date(2026, 9, 17) });
    expect(existsSync(join(teamsDir, "a.yaml"))).toBe(false); // 保持删除
    expect(archiveContent("a.yaml-")).toContain("云端描述"); // 云端版本归档
    expect(remoteHas("a.yaml")).toBe(false); // 删除已传播

    // 恢复云端
    remoteCommit({ "a.yaml": withDesc(teamYaml("a"), "云端再来描述") }, "remote again");
    const restore = makeHarness({ mode: "rpc", select: rpcChoice("take-remote") });
    await sync(restore.ctx, { now: () => new Date(2026, 9, 17) });
    expect(readLocal("a.yaml")).toContain("云端再来描述");
  });

  it("阶段4-7 本机改+云端删：保留本机（重新上传）；接受删除（本机版本归档后删除）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    writeLocal("a.yaml", withDesc(teamYaml("a"), "本机描述"));
    // 云端删除
    const scratch = cloneRemote("main");
    unlinkSync(join(scratch, "a.yaml"));
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "remove a"]);
    gitCli(scratch, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    const keepLocal = makeHarness({ mode: "rpc", select: rpcChoice("keep-local") });
    await sync(keepLocal.ctx, { now: () => new Date(2026, 9, 17) });
    expect(readLocal("a.yaml")).toContain("本机描述");
    expect(remoteFile("a.yaml")).toContain("本机描述"); // 重新上传

    // 再次制造 modify/delete → 接受删除
    writeLocal("a.yaml", withDesc(teamYaml("a"), "本机描述2"));
    const scratch2 = cloneRemote("main");
    unlinkSync(join(scratch2, "a.yaml"));
    gitCli(scratch2, ["add", "-A"]);
    gitCli(scratch2, [...GIT_ID, "commit", "-qm", "remove a again"]);
    gitCli(scratch2, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const acceptDelete = makeHarness({ mode: "rpc", select: rpcChoice("take-remote") });
    await sync(acceptDelete.ctx, { now: () => new Date(2026, 9, 17) });
    expect(existsSync(join(teamsDir, "a.yaml"))).toBe(false);
    expect(archiveContent("a.yaml-")).toContain("本机描述2");
  });

  it("阶段4-8 取消任一步 → 零改动（归档目录未写、引用未动）", async () => {
    await setupBothModified();
    const headBefore = localSha();
    // RPC 取消 = select 返回 undefined
    const { ctx, notify } = makeHarness({ mode: "rpc", select: undefined });
    await sync(ctx);
    expect(notifyText(notify)).toContain("已取消，未做任何改动");
    expect(archiveFiles()).toHaveLength(0);
    expect(localSha()).toBe(headBefore);
    expect(readLocal("a.yaml")).toContain("本机描述");

    // TUI 取消 = Esc
    const tui = makeHarness();
    installTuiChoice(tui.ctx, undefined);
    await sync(tui.ctx);
    expect(archiveFiles()).toHaveLength(0);
    expect(localSha()).toBe(headBefore);

    // 最终计划确认拒绝（选择动作之后、应用之前）
    const rejected = makeHarness({ mode: "rpc", select: rpcChoice("take-remote"), confirm: async () => false });
    await sync(rejected.ctx);
    expect(notifyText(rejected.notify)).toContain("已取消，未做任何改动");
    expect(archiveFiles()).toHaveLength(0);
    expect(localSha()).toBe(headBefore);
    expect(readLocal("a.yaml")).toContain("本机描述"); // 云端版本未落地
  });

  it("阶段4-9 TUI 路径：差异视图按数字键选动作 → 决策生效", async () => {
    await setupBothModified();
    const { ctx } = makeHarness();
    installTuiChoice(ctx, "take-remote");
    await sync(ctx, { now: () => new Date(2026, 9, 17) });
    expect(readLocal("a.yaml")).toContain("云端描述");
    expect(archiveContent("a.yaml-")).toContain("本机描述");
  });

  it("阶段4-10 编辑模式确认：正在编辑的团队被同步触及 → 先确认；拒绝则零改动", async () => {
    await setupBothModified();
    const headBefore = localSha();
    const rejected = makeHarness({ mode: "rpc", select: rpcChoice("take-remote"), confirm: async () => false });
    await sync(rejected.ctx, { getEditingTeamName: () => "a" });
    expect(rejected.confirm).toHaveBeenCalled();
    expect(notifyText(rejected.notify)).toContain("已取消，未做任何改动");
    expect(archiveFiles()).toHaveLength(0);
    expect(localSha()).toBe(headBefore);

    // 编辑的是别的团队 → 不额外确认（仍走冲突决策与计划确认）
    const other = makeHarness({ mode: "rpc", select: rpcChoice("take-remote") });
    await sync(other.ctx, { getEditingTeamName: () => "其他团队" });
    expect(readLocal("a.yaml")).toContain("云端描述");
  });

  it("阶段4-11 无 UI 模式 → 明确拒绝 + 人工命令（不静默 no-op）", async () => {
    await setupBothModified();
    const headBefore = localSha();
    const { ctx, notify } = makeHarness({ mode: "json" as never });
    await sync(ctx);
    const text = notifyText(notify);
    expect(text).toContain("冲突");
    expect(text).toContain("/team sync status");
    expect(text).toContain("git --git-dir");
    expect(localSha()).toBe(headBefore);
    expect(archiveFiles()).toHaveLength(0);
  });

  it("阶段4-12 无冲突的普通计划不受影响（零额外确认，阶段 2 行为保持）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    writeLocal("a.yaml", withDesc(teamYaml("a"), "本机描述"));

    const { ctx, confirm, notify } = makeHarness();
    await sync(ctx);
    expect(confirm).not.toHaveBeenCalled(); // 仅本机改 → 不确认
    expect(notifyText(notify)).toContain("云同步完成");
    expect(archiveFiles()).toHaveLength(0);
  });

  it("阶段4-13 add/add 冲突（两边各自新增同名、内容不同）→ 提问并三选项", async () => {
    writeLocal("new.yaml", withDesc(teamYaml("new"), "本机新增描述"));
    seedRemote({ "new.yaml": withDesc(teamYaml("new"), "云端新增描述") });
    configure();

    const { ctx, notify, select } = makeHarness({ mode: "rpc", select: rpcChoice("keep-local") });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });
    expect(select).toHaveBeenCalled(); // 提问
    expect(notifyText(notify)).toContain("冲突决策：1");
    expect(readLocal("new.yaml")).toContain("本机新增描述");
    expect(archiveContent("new.yaml-")).toContain("云端新增描述");
    expect(remoteFile("new.yaml")).toContain("本机新增描述");
  });

  it("阶段4-14 两边新增且内容相同 → 不提问、零决策界面", async () => {
    const same = teamYaml("same");
    writeLocal("same.yaml", same);
    seedRemote({ "same.yaml": same });
    configure();

    const { ctx, notify, select } = makeHarness({ mode: "rpc" });
    await sync(ctx);
    expect(select).not.toHaveBeenCalled();
    expect(notifyText(notify)).not.toContain("冲突决策");
    expect(readLocal("same.yaml")).toBe(same);
  });

  it("阶段4-15 复审#1：远端已有同名导入团队且本机无 → 生成唯一名、绝不覆盖（端到端）", async () => {
    const remoteOwn = teamYaml("a-remote-20261017") + "# REMOTE-OWN-TEAM-CONTENT\n";
    seedRemote({
      "a.yaml": withDesc(teamYaml("a"), "云端描述"),
      "a-remote-20261017.yaml": remoteOwn, // 模拟 A 机同日 keep-both 推送的团队
    });
    configure();
    writeLocal("a.yaml", withDesc(teamYaml("a"), "本机描述")); // 本机没有 a-remote-20261017.yaml

    const { ctx, notify } = makeHarness({ mode: "rpc", select: rpcChoice("keep-both") });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });

    const text = notifyText(notify);
    // 唯一名避开了远端已有的名字
    expect(text).toContain("a-remote-20261017-2");
    expect(existsSync(join(teamsDir, "a-remote-20261017-2.yaml"))).toBe(true);
    expect(readLocal("a-remote-20261017-2.yaml")).toContain("云端描述");
    // 刚下载的远端团队文件未被顶掉（本机与远端都保持 A 机的内容）
    expect(readLocal("a-remote-20261017.yaml")).toContain("REMOTE-OWN-TEAM-CONTENT");
    expect(remoteFile("a-remote-20261017.yaml")).toContain("REMOTE-OWN-TEAM-CONTENT");
    // 摘要不再自相矛盾：下载与导入是两个不同的团队名
    expect(text).toContain("下载：1（a-remote-20261017）");
    expect(text).toContain("新团队导入：a-remote-20261017-2");
  });

  it("阶段4-16 复审#2：人工查看命令真实可执行（树路径无 teams/ 前缀 + 引号）", async () => {
    await setupBothModified();
    const { ctx, notify } = makeHarness({ mode: "rpc", select: rpcChoice("keep-local") });
    await sync(ctx);

    const text = notifyText(notify);
    const cloudLine = text.split("\n").find((l) => l.includes("查看云端版本："));
    const localLine = text.split("\n").find((l) => l.includes("查看本机版本："));
    expect(cloudLine).toBeDefined();
    expect(localLine).toBeDefined();
    const cloudCmd = String(cloudLine).split("查看云端版本：")[1]!.trim();
    const localCmd = String(localLine).split("查看本机版本：")[1]!.trim();
    expect(cloudCmd).not.toContain(":teams/");
    expect(cloudCmd).toContain("'"); // 路径加引号可直接粘贴

    // 真实执行（照抄用户路径）：云端版本内容与文件内容都能取到
    expect(execFileSync("/bin/sh", ["-c", cloudCmd], { encoding: "utf-8" })).toContain("云端描述");
    expect(execFileSync("/bin/sh", ["-c", localCmd], { encoding: "utf-8" })).toContain("本机描述");
  });

  it("阶段4-17 复审#5：编辑中的团队被普通下载触及时同样先确认（拒绝零改动）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    remoteCommit({ "a.yaml": withDesc(teamYaml("a"), "云端描述") }, "remote edit");

    const rejected = makeHarness({ confirm: async () => false });
    await sync(rejected.ctx, { getEditingTeamName: () => "a" });
    expect(rejected.confirm).toHaveBeenCalled();
    expect(String(rejected.confirm.mock.calls[0][1])).toContain("正在编辑团队「a」");
    expect(notifyText(rejected.notify)).toContain("已取消，未做任何改动");
    expect(readLocal("a.yaml")).not.toContain("云端描述");

    const accepted = makeHarness();
    await sync(accepted.ctx, { getEditingTeamName: () => "a" });
    expect(readLocal("a.yaml")).toContain("云端描述");

    // 本机改动（上传）不打断编辑：不额外确认
    writeLocal("a.yaml", withDesc(teamYaml("a"), "本机再改"));
    const uploadOnly = makeHarness();
    await sync(uploadOnly.ctx, { getEditingTeamName: () => "a" });
    expect(uploadOnly.confirm).not.toHaveBeenCalled();
  });

  it("阶段4-18 复审#8：未跟踪但同名会被覆盖的非团队文件进入最终清单", async () => {
    writeLocal("a.yaml", withDesc(teamYaml("a"), "本机描述"));
    writeLocal("notes.md", "本机未跟踪笔记\n");
    seedRemote({ "a.yaml": withDesc(teamYaml("a"), "云端描述"), "notes.md": "云端笔记\n" });
    configure();

    let planMessage = "";
    const { ctx, notify } = makeHarness({
      mode: "rpc",
      select: rpcChoice("keep-local"),
      confirm: async (_title, message) => {
        planMessage = message;
        return true;
      },
    });
    await sync(ctx, { now: () => new Date(2026, 9, 17) });

    expect(planMessage).toContain("非团队文件（云端为准，将覆盖本机版本并留档）：notes.md");
    expect(readLocal("notes.md")).toBe("云端笔记\n");
    expect(archiveContent("notes.md-")).toBe("本机未跟踪笔记\n"); // 覆盖前留档
    expect(notifyText(notify)).toContain("留档：1 个非团队文件的本机版本");
  });

  // ═══════ 阶段 2：/team sync 进度接线（进行中反馈）═══════

  it("阶段2-1 网络调用之前先写状态；阶段文本与真实步骤对齐（连接→获取→比对→应用）", async () => {
    const events: { kind: "status" | "git"; detail: string }[] = [];
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    const { ctx } = makeHarness({ events });
    const recordingRunGit: typeof runGit = async (args, options) => {
      events.push({ kind: "git", detail: args.join(" ") });
      return runGit(args, options);
    };
    await sync(ctx, { runGit: recordingRunGit });

    const firstStatus = events.findIndex((e) => e.kind === "status" && e.detail !== "(clear)");
    const firstNetwork = events.findIndex((e) => e.kind === "git" && /(^|\s)(ls-remote|fetch)(\s|$)/.test(e.detail));
    expect(firstStatus).toBeGreaterThanOrEqual(0);
    expect(firstNetwork).toBeGreaterThan(firstStatus); // ① 首个非空状态在任何网络调用之前

    // ② 阶段词按真实步骤推进（顺序 + 每个网络调用前的那一刻状态）
    const stageWrites = events
      .filter((e) => e.kind === "status" && e.detail !== "(clear)")
      .map((e) => e.detail);
    const idx = (word: string): number => stageWrites.findIndex((t) => t.includes(word));
    expect(idx("准备中…")).toBe(0);
    expect(idx("连接云端…")).toBeGreaterThan(idx("准备中…"));
    expect(idx("获取云端更新…")).toBeGreaterThan(idx("连接云端…"));
    expect(idx("比对差异…")).toBeGreaterThan(idx("获取云端更新…"));
    expect(idx("应用并推送…")).toBeGreaterThan(idx("比对差异…"));

    const statusBefore = (limit: number): string | undefined => {
      for (let i = limit - 1; i >= 0; i--) {
        const event = events[i];
        if (event.kind === "status" && event.detail !== "(clear)") return event.detail;
      }
      return undefined;
    };
    const lsRemoteAt = events.findIndex((e) => e.kind === "git" && e.detail.includes("ls-remote"));
    const fetchAt = events.findIndex((e) => e.kind === "git" && e.detail.includes("fetch"));
    const readTreeAt = events.findIndex((e) => e.kind === "git" && e.detail.includes("read-tree"));
    expect(statusBefore(lsRemoteAt)).toContain("连接云端…");
    expect(statusBefore(fetchAt)).toContain("获取云端更新…");
    expect(statusBefore(readTreeAt)).toContain("应用并推送…");
  });

  it("阶段2-2 成功路径出口闭合：状态被清除、且曾有非空状态；通知不含进度类文本", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx); // 首次接入（建立基线）
    writeLocal("a.yaml", teamYaml("a") + "# 本机改\n"); // 仅本机改 → 零交互上传
    const { ctx, notify, trace } = makeHarness();
    await sync(ctx);

    expect(trace.nonEmpty().length).toBeGreaterThan(0); // ⑥ 回归护栏
    expect(trace.current()).toBeUndefined(); // ④ 出口闭合
    expect(trace.writes.at(-1)).toBeUndefined();

    // ⑤ 零新增聊天输出：进度类文本不得进入聊天区
    const chat = notifyText(notify);
    expect(chat).toContain("云同步完成");
    expect(chat).not.toMatch(/准备中|连接云端|获取云端更新|比对差异|应用并推送|等待你的确认|等待你的决策/);
  });

  it("阶段2-3 无事可做出口闭合（已是最新）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx); // 首次接入
    const { ctx, notify, trace } = makeHarness();
    await sync(ctx);

    expect(notifyText(notify)).toContain("已是最新");
    expect(trace.nonEmpty().length).toBeGreaterThan(0);
    expect(trace.current()).toBeUndefined();
  });

  /** 等待态断言助手：对话框打开瞬间必须是「⏸ 等待…」且不含秒数。 */
  function expectWaiting(dialog: { kind: string; text: string | undefined } | undefined, expected: string): void {
    expect(dialog?.text).toBe(expected);
    expect(dialog?.text ?? "").not.toMatch(/\d+s/);
  }

  it("阶段2-4a 首次接入上传确认：打开时为等待态且无秒数", async () => {
    writeLocal("local.yaml", teamYaml("local"));
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    const { ctx, trace } = makeHarness();
    await sync(ctx);
    expectWaiting(trace.dialogs.find((d) => d.kind === "confirm"), "☁️ 云同步：⏸ 等待你的确认");
  });

  it("阶段2-4b 删除传播确认：打开时为等待态且无秒数", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    const scratch = cloneRemote("main");
    unlinkSync(join(scratch, "a.yaml"));
    gitCli(scratch, ["add", "-A"]);
    gitCli(scratch, [...GIT_ID, "commit", "-qm", "remove a"]);
    gitCli(scratch, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

    const { ctx, trace } = makeHarness();
    await sync(ctx);
    expectWaiting(trace.dialogs.find((d) => d.kind === "confirm"), "☁️ 云同步：⏸ 等待你的确认");
  });

  it("阶段2-4c 冲突决策（RPC）与最终计划确认：均为等待态且无秒数", async () => {
    await setupBothModified();
    const { ctx, trace } = makeHarness({ mode: "rpc", select: rpcChoice("keep-local") });
    await sync(ctx);
    expectWaiting(trace.dialogs.find((d) => d.kind === "select"), "☁️ 云同步：⏸ 等待你的决策（1/1）");
    expectWaiting(trace.dialogs.find((d) => d.kind === "confirm"), "☁️ 云同步：⏸ 等待你的确认");
  });

  it("阶段2-4d 编辑模式确认：打开时为等待态且无秒数", async () => {
    await setupBothModified();
    const { ctx, trace } = makeHarness({ mode: "rpc", select: rpcChoice("keep-local") });
    await sync(ctx, { getEditingTeamName: () => "a" });
    expectWaiting(trace.dialogs.find((d) => d.kind === "confirm"), "☁️ 云同步：⏸ 等待你的确认");
  });

  it("阶段2-5 TUI 差异视图路径：打开对话框时也是等待态且无秒数", async () => {
    await setupBothModified();
    const { ctx, trace } = makeHarness();
    installTuiChoice(ctx, "take-remote");
    await sync(ctx);
    const custom = trace.dialogs.find((d) => d.kind === "custom");
    expect(custom?.text).toBe("☁️ 云同步：⏸ 等待你的决策（1/1）");
    expect(trace.current()).toBeUndefined();
  });

  it("阶段2-6 远端地址变更确认：确认前为等待态（回到连接阶段由后续挂点负责）", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx); // 建立本机仓库与 origin
    configure(join(base, "another-remote.git")); // 配置地址与仓库 origin 不一致 → 触发换地址确认

    const { ctx, trace } = makeHarness();
    await sync(ctx);
    expect(trace.dialogs.find((d) => d.kind === "confirm")?.text).toBe("☁️ 云同步：⏸ 等待你的确认");
    expect(trace.current()).toBeUndefined();
  });

  it("阶段2-7a 出口闭合（应用失败 / index.lock 中止 → 最终为空；锁占用与非交互 → 从未设置）", async () => {
    // 应用失败（注入 commit-tree 失败）
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    writeLocal("a.yaml", teamYaml("a") + "# 本机改\n");
    const applyFail = makeHarness();
    const failingCommit: typeof runGit = async (args, options) => {
      if (args.includes("commit-tree")) {
        return {
          ok: false,
          stdout: "",
          stderr: "fatal: injected",
          code: 128,
          timedOut: false,
          outputLimitExceeded: false,
          command: "git commit-tree <injected>",
        };
      }
      return runGit(args, options);
    };
    await sync(applyFail.ctx, { runGit: failingCommit });
    expect(notifyText(applyFail.notify)).toContain("云同步失败");
    expect(applyFail.trace.nonEmpty().length).toBeGreaterThan(0);
    expect(applyFail.trace.current()).toBeUndefined();

    // index.lock 中止（进度已开启，必须清除）
    writeFileSync(join(teamsDir, ".git", "index.lock"), "", "utf-8");
    const lockedIndex = makeHarness();
    await sync(lockedIndex.ctx);
    expect(notifyText(lockedIndex.notify)).toContain("index.lock");
    expect(lockedIndex.trace.nonEmpty().length).toBeGreaterThan(0);
    expect(lockedIndex.trace.current()).toBeUndefined();
    rmSync(join(teamsDir, ".git", "index.lock"), { force: true });

    // 锁被占用 → 从未设置
    const held = makeHarness();
    const outer = acquireSyncLock(rootDir);
    expect(outer.ok).toBe(true);
    try {
      await sync(held.ctx);
      expect(notifyText(held.notify)).toContain("另一个同步实例正在运行");
      expect(held.trace.hadNoWrite()).toBe(true);
    } finally {
      if (outer.ok) outer.lock.release();
    }

    // 非交互模式 → 从未设置
    const nonInteractive = makeHarness({ mode: "json" as never });
    await sync(nonInteractive.ctx);
    expect(notifyText(nonInteractive.notify)).toContain("需要交互式界面");
    expect(nonInteractive.trace.hadNoWrite()).toBe(true);
  });

  it("阶段2-7b 取消（首次接入上传确认拒绝）→ 最终为空", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    writeLocal("a.yaml", teamYaml("a") + "# 本机改\n");
    configure();
    const { ctx, notify, trace } = makeHarness({ confirm: async () => false });
    await sync(ctx);
    expect(notifyText(notify)).toContain("已取消，未做任何改动");
    expect(trace.nonEmpty().length).toBeGreaterThan(0);
    expect(trace.current()).toBeUndefined();
  });

  it("阶段2-7c 取消（冲突决策时取消）→ 最终为空", async () => {
    await setupBothModified();
    const { ctx, trace } = makeHarness({ mode: "rpc", select: async () => undefined });
    await sync(ctx);
    expect(trace.nonEmpty().length).toBeGreaterThan(0);
    expect(trace.current()).toBeUndefined();
    expect(trace.dialogs.find((d) => d.kind === "select")?.text).toContain("⏸ 等待你的决策（1/1）");
  });

  it("阶段2-7d 取消（最终计划确认拒绝）→ 最终为空", async () => {
    await setupBothModified();
    const { ctx, notify, trace } = makeHarness({
      mode: "rpc",
      select: rpcChoice("keep-local"),
      confirm: async () => false,
    });
    await sync(ctx);
    expect(notifyText(notify)).toContain("已取消，未做任何改动");
    expect(trace.nonEmpty().length).toBeGreaterThan(0);
    expect(trace.current()).toBeUndefined();
  });

  // ═══════ 阶段 3：/team sync status 进度接线（进行中反馈）═══════

  it("阶段3-1 status 网络检查：进入前写「正在检查云端状态…」（早于任何网络调用），结束后清空", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    const events: { kind: "status" | "git"; detail: string }[] = [];
    const { ctx, notify, trace, confirm, select, input } = makeHarness({ events });
    const recordingRunGit: typeof runGit = async (args, options) => {
      events.push({ kind: "git", detail: args.join(" ") });
      return runGit(args, options);
    };
    await handleSyncCommand(ctx, "status", { rootDir, runGit: recordingRunGit, statusTimeoutMs: 15_000 });

    const firstStatus = events.findIndex((e) => e.kind === "status" && e.detail !== "(clear)");
    const firstNetwork = events.findIndex(
      (e) => e.kind === "git" && /(^|\s)(ls-remote|fetch)(\s|$)/.test(e.detail)
    );
    expect(firstStatus).toBeGreaterThanOrEqual(0);
    expect(events[firstStatus].detail).toContain("正在检查云端状态…");
    expect(firstNetwork).toBeGreaterThan(firstStatus); // ① 网络调用之前已有非空状态

    // 出口闭合：命令返回时该键为空（成功路径）
    expect(trace.nonEmpty().length).toBeGreaterThan(0);
    expect(trace.current()).toBeUndefined();
    expect(trace.writes.at(-1)).toBeUndefined();

    // 结果照旧；无新增聊天输出；无新增对话框（status 从不问问题）
    expect(notifyText(notify)).toContain("云同步状态");
    expect(notifyText(notify)).not.toMatch(/正在检查云端状态|准备中|连接云端|获取云端更新|比对差异|应用并推送|等待你的/);
    expect(confirm).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

  it("阶段3-2 status 未配置 / 已配置但尚未接入 → 不发起网络检查，该键从未被设置", async () => {
    // 未配置（无 sync.yaml）
    const unconfigured = makeHarness();
    await handleSyncCommand(unconfigured.ctx, "status", { rootDir });
    expect(notifyText(unconfigured.notify)).toContain("未配置");
    expect(unconfigured.trace.hadNoWrite()).toBe(true);

    // 已配置但尚未接入（无本机仓库）→ 走 unchecked 分支，无网络调用
    saveSyncConfig({ enabled: true, remoteUrl: remoteDir, branch: "" }, rootDir);
    const notAttached = makeHarness();
    await handleSyncCommand(notAttached.ctx, "status", { rootDir, statusTimeoutMs: 1000 });
    expect(notifyText(notAttached.notify)).toContain("尚未接入");
    expect(notAttached.trace.hadNoWrite()).toBe(true);
  });

  it("阶段3-3 status 检查失败（远端不可达）→ 曾写入非空状态且已清空，失败文案照旧", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);
    // 配置地址改为不存在的本地路径 → ls-remote 立即失败（走错误分支）
    saveSyncConfig({ enabled: true, remoteUrl: join(base, "no-such-remote.git"), branch: "" }, rootDir);

    const { ctx, notify, trace } = makeHarness();
    await handleSyncCommand(ctx, "status", { rootDir, statusTimeoutMs: 1500 });

    expect(trace.nonEmpty().length).toBeGreaterThan(0);
    expect(trace.nonEmpty().every((t) => t.includes("正在检查云端状态…"))).toBe(true);
    expect(trace.current()).toBeUndefined(); // 失败路径同样清空
    expect(trace.writes.at(-1)).toBeUndefined();
    expect(notifyText(notify)).toContain("云同步状态");
    expect(notifyText(notify)).not.toMatch(/正在检查云端状态/);
  });

  it("阶段3-4 status 出口闭合不依赖网络结果（远端为空仓库路径）", async () => {
    const emptyRemote = join(base, "empty-remote.git");
    gitCli(base, ["init", "--bare", "-q", emptyRemote]); // 空远端：走 empty 分支
    saveSyncConfig({ enabled: true, remoteUrl: emptyRemote, branch: "" }, rootDir);
    gitCli(teamsDir, ["init", "-q"]);
    gitCli(teamsDir, ["remote", "add", "--", "origin", emptyRemote]);
    gitCli(teamsDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    const { ctx, trace } = makeHarness();
    await handleSyncCommand(ctx, "status", { rootDir, statusTimeoutMs: 5_000 });
    expect(trace.nonEmpty().length).toBeGreaterThan(0);
    expect(trace.current()).toBeUndefined();
  });

  it("阶段3-5 替代验证（§6.3 第 5 项）：注入延迟假 git 执行器模拟网络窗口——在飞期间聊天区零新增行、状态栏秒数递增", async () => {
    seedRemote({ "a.yaml": teamYaml("a") });
    configure();
    await sync(makeHarness().ctx);

    const harness = makeHarness();
    const notify = harness.notify;
    const trace = harness.trace;
    const inFlight: { call: string; status: string | undefined; chatLines: number }[] = [];
    let networkCalls = 0;

    const delayedRunGit: typeof runGit = async (args, options) => {
      const isNetwork = args.includes("ls-remote") || args.includes("fetch");
      if (!isNetwork) return runGit(args, options);
      networkCalls += 1;
      // 模拟真实网络窗口：命令在飞期间进度必须已经可见，而聊天区必须零新增行
      if (networkCalls === 2) await new Promise((resolve) => setTimeout(resolve, 1_200));
      const result = await runGit(args, options);
      inFlight.push({
        call: args.join(" "),
        status: trace.current(),
        chatLines: notify.mock.calls.length,
      });
      return result;
    };

    await handleSyncCommand(harness.ctx, "status", {
      rootDir,
      runGit: delayedRunGit,
      statusTimeoutMs: 15_000,
    });

    expect(inFlight.length).toBeGreaterThanOrEqual(2); // ls-remote + fetch 两次网络调用
    for (const sample of inFlight) {
      expect(sample.status).toContain("正在检查云端状态…（");
      expect(sample.status).toMatch(/（\d+s）/); // 秒数格式在位（真机递增性由 progress 单测的注入时钟覆盖）
      expect(sample.chatLines).toBe(0); // 在飞期间聊天区零新增行（唯一反馈通道 = 状态栏）
    }
    // 延迟 1.2s 的那次网络调用时，秒数已推进到 ≥1s（时间戳差值 + 1s 刷新）
    const seconds = inFlight.map((s) => Number.parseInt(/（(\d+)s）/.exec(s.status ?? "")?.[1] ?? "0", 10));
    expect(Math.max(...seconds)).toBeGreaterThanOrEqual(1);

    // 结束：状态栏清除、聊天区只出现既有的结果行
    expect(trace.current()).toBeUndefined();
    expect(notifyText(notify)).toContain("云同步状态");
  });
});
