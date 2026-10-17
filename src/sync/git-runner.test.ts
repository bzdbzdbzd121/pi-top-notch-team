import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGitEnv,
  classifyGitError,
  DEFAULT_GIT_TIMEOUT_MS,
  formatGitCommand,
  GIT_ENV_STRIPPED,
  runGit,
  spawnCapture,
  splitNullTerminated,
  type GitResult,
} from "./git-runner";

const failure = (stderr: string, extra: Partial<GitResult> = {}): GitResult => ({
  ok: false,
  stdout: "",
  stderr,
  code: 128,
  timedOut: false,
  outputLimitExceeded: false,
  command: "git fetch --no-tags origin main",
  ...extra,
});

describe("buildGitEnv（环境硬化）", () => {
  it("清除外部注入的 GIT_* 定位/配置变量（允许我们自己重设临时索引）", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      GIT_DIR: "/injected/.git",
      GIT_WORK_TREE: "/injected",
      GIT_INDEX_FILE: "/injected/index",
      GIT_OBJECT_DIRECTORY: "/injected/objects",
      GIT_COMMON_DIR: "/injected/common",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/injected/alt",
      GIT_CONFIG_GLOBAL: "/injected/gitconfig",
      GIT_CONFIG_SYSTEM: "/injected/system-config",
      GIT_CEILING_DIRECTORIES: "/injected",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.sshCommand",
      GIT_CONFIG_VALUE_0: "/injected/evil-ssh",
    };
    const env = buildGitEnv(undefined, base);
    for (const key of GIT_ENV_STRIPPED) {
      expect(env[key], key).toBeUndefined();
    }
    // 动态注入的 GIT_CONFIG_COUNT/KEY_n/VALUE_n 逐键清除（审查建议 #7）
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("固定 LC_ALL=C 并禁用交互式提示", () => {
    const env = buildGitEnv(undefined, { PATH: "/usr/bin" });
    expect(env.LC_ALL).toBe("C");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_PAGER).toBe("cat");
  });

  it("默认提供非交互 SSH 命令；用户已配置时不覆盖", () => {
    expect(buildGitEnv(undefined, {}).GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(buildGitEnv(undefined, { GIT_SSH_COMMAND: "ssh -i /custom/key" }).GIT_SSH_COMMAND).toBe("ssh -i /custom/key");
    expect(buildGitEnv(undefined, { GIT_SSH: "/custom/ssh" }).GIT_SSH_COMMAND).toBeUndefined();
  });

  it("extra 在硬化之后应用（临时索引等可覆盖）", () => {
    const env = buildGitEnv({ GIT_INDEX_FILE: "/tmp/idx", LC_ALL: "zh_CN.UTF-8" }, { GIT_INDEX_FILE: "/injected" });
    expect(env.GIT_INDEX_FILE).toBe("/tmp/idx");
    expect(env.LC_ALL).toBe("zh_CN.UTF-8");
  });
});

describe("splitNullTerminated（-z 解析）", () => {
  it.each([
    ["", []],
    ["a\0", ["a"]],
    ["a\0b", ["a", "b"]],
    ["a\0b\0", ["a", "b"]],
    ["a\0\0b", ["a", "b"]],
    ["with space\0中的 文字.yaml\0", ["with space", "中的 文字.yaml"]],
    ["line\nbreak\0", ["line\nbreak"]],
  ])("%j → %j", (raw, expected) => {
    expect(splitNullTerminated(raw)).toEqual(expected);
  });
});

describe("formatGitCommand", () => {
  it("无空白参数不加引号", () => {
    expect(formatGitCommand("git", ["-C", "/tmp/repo", "rev-parse", "--show-toplevel"])).toBe(
      "git -C /tmp/repo rev-parse --show-toplevel"
    );
  });

  it("含空白/引号的参数加引号", () => {
    expect(formatGitCommand("git", ["-C", "/tmp/a b", "status"])).toBe('git -C "/tmp/a b" status');
    expect(formatGitCommand("git", ["commit-tree", "x", "-m", 'say "hi"'])).toBe('git commit-tree x -m "say \\"hi\\""');
  });

  it("命令串中的 URL userinfo 被脱敏（审查建议 #4）", () => {
    expect(formatGitCommand("git", ["fetch", "https://user:secret@github.com/u/r.git"])).toBe(
      "git fetch https://***@github.com/u/r.git"
    );
    expect(formatGitCommand("git", ["ls-remote", "ssh://user:secret@github.com/u/r.git"])).toBe(
      "git ls-remote ssh://***@github.com/u/r.git"
    );
    // 双 @（密码含 @）也能被整体遮蔽（authority 内取最后一个 @）
    expect(formatGitCommand("git", ["fetch", "https://user:pa@ss@github.com/u/r.git"])).toBe(
      "git fetch https://***@github.com/u/r.git"
    );
    // 非 URL 参数中的 @ 不受影响
    expect(formatGitCommand("git", ["add", "--", "teams/a@b.yaml"])).toBe("git add -- teams/a@b.yaml");
  });
});

describe("runGit（真实 git 集成）", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = realpathSync(mkdtempSync(join(tmpdir(), "git-runner-test-")));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("默认超时为 30s（网络命令由调用点显式放大）", () => {
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(30_000);
  });

  it("统一以 git -C <cwd> 执行并返回结构化结果", async () => {
    const res = await runGit(["--version"], { cwd: rootDir });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("git version");
    expect(res.stderr).toBe("");
    expect(res.timedOut).toBe(false);
    expect(res.command).toContain(`-C ${rootDir}`);
    expect(res.command).toContain("credential.interactive=false");
    expect(res.command).toContain("--version");
  });

  it("子进程继承硬化后的环境（LC_ALL=C / GCM_INTERACTIVE=never）", async () => {
    const res = await spawnCapture(
      process.execPath,
      ["-e", "console.log(process.env.LC_ALL); console.log(process.env.GIT_DIR === undefined ? 'no-git-dir' : process.env.GIT_DIR); console.log(process.env.GCM_INTERACTIVE)"],
      { cwd: rootDir, env: buildGitEnv(undefined, { GIT_DIR: "/should-be-stripped" }) }
    );
    expect(res.stdout).toBe("C\nno-git-dir\nnever\n");
  });

  it("-C 生效：可在仓库外初始化仓库并读回顶层路径", async () => {
    expect((await runGit(["init", "--quiet"], { cwd: rootDir })).ok).toBe(true);
    const res = await runGit(["rev-parse", "--show-toplevel"], { cwd: rootDir });
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe(rootDir);
  });

  it("stdin 被写入并关闭（hash-object）", async () => {
    const res = await runGit(["hash-object", "--stdin"], { cwd: rootDir, stdin: "hello\n" });
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("非仓库目录 → 结构化失败 + 分类 not-a-repo", async () => {
    const res = await runGit(["rev-parse", "--show-toplevel"], { cwd: rootDir });
    expect(res.ok).toBe(false);
    expect(res.code).not.toBe(0);
    expect(classifyGitError(res).reason).toBe("not-a-repo");
  });

  it("git 不存在（spawn ENOENT）→ 结构化失败 + 分类 git-missing", async () => {
    const res = await runGit(["--version"], { cwd: rootDir, binary: "/nonexistent/definitely-not-git" });
    expect(res.ok).toBe(false);
    expect(res.spawnError).toBe("ENOENT");
    const cls = classifyGitError(res);
    expect(cls.kind).toBe("persistent");
    expect(cls.reason).toBe("git-missing");
    expect(cls.fix).toContain("git");
  });

  it("cwd 指向普通文件 → 不 reject，结构化失败 + 分类 workdir-missing（审查 #1）", async () => {
    const filePath = join(rootDir, "not-a-directory");
    writeFileSync(filePath, "x", "utf-8");

    // 旧实现：spawn 同步抛 ENOTDIR → Promise reject（契约破坏）。
    // 现在必须 resolve 为结构化结果。
    const res = await runGit(["--version"], { cwd: filePath });
    expect(res.ok).toBe(false);
    const cls = classifyGitError(res);
    expect(cls.kind).toBe("persistent");
    expect(cls.reason).toBe("workdir-missing");
  });

  it("cwd 不存在 → 结构化失败 + 分类 workdir-missing（不误报 git-missing）", async () => {
    const res = await runGit(["--version"], { cwd: join(rootDir, "no-such-dir") });
    expect(res.ok).toBe(false);
    expect(res.spawnError).toBeUndefined();
    expect(classifyGitError(res).reason).toBe("workdir-missing");
  });
});

describe("spawnCapture（超时与输出上限）", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "spawn-capture-test-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("超时 → kill 进程并返回 timedOut", async () => {
    const started = Date.now();
    const res = await spawnCapture(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      cwd: rootDir,
      env: buildGitEnv(),
      timeoutMs: 200,
    });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const cls = classifyGitError({ ...res, command: "git fetch" } as GitResult);
    expect(cls.kind).toBe("transient");
    expect(cls.reason).toBe("timeout");
  });

  it("输出超上限 → kill 进程并返回 outputLimitExceeded", async () => {
    const res = await spawnCapture(process.execPath, ["-e", "process.stdout.write('x'.repeat(500000))"], {
      cwd: rootDir,
      env: buildGitEnv(),
      maxBuffer: 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.outputLimitExceeded).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("正常命令捕获 stdout/stderr 与退出码", async () => {
    const res = await spawnCapture(
      process.execPath,
      ["-e", "console.log('out'); console.error('err'); process.exitCode = 3"],
      { cwd: rootDir, env: buildGitEnv() }
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe(3);
    expect(res.stdout).toBe("out\n");
    expect(res.stderr).toBe("err\n");
  });

  it("spawn 同步抛错（cwd 为文件 ENOTDIR）→ 结构化 spawnError，绝不 reject（审查 #1）", async () => {
    const filePath = join(rootDir, "not-a-directory");
    writeFileSync(filePath, "x", "utf-8");

    const res = await spawnCapture(process.execPath, ["-e", ""], { cwd: filePath, env: buildGitEnv() });
    expect(res.ok).toBe(false);
    expect(res.spawnError).toBe("ENOTDIR");

    const cls = classifyGitError({ ...res, command: "git --version" } as GitResult);
    expect(cls.reason).toBe("workdir-missing");
  });
});

describe("classifyGitError（失败分类表，方案 §7.E）", () => {
  it.each([
    [
      "could not read Username（terminal prompts disabled）",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "auth",
      "persistent",
    ],
    ["Authentication failed", "fatal: Authentication failed for 'https://github.com/u/r.git/'", "auth", "persistent"],
    ["Permission denied (publickey)", "git@github.com: Permission denied (publickey),\nfatal: Could not read from remote repository.", "auth", "persistent"],
    ["大小写不敏感", "FATAL: AUTHENTICATION FAILED FOR 'HTTPS://GITHUB.COM/U/R.GIT/'", "auth", "persistent"],
    ["SSH 主机指纹未信任", "Host key verification failed.\nfatal: Could not read from remote repository.", "ssh-host-key", "persistent"],
    ["仓库不存在（GitHub 文案）", "remote: Repository not found.\nfatal: repository 'https://github.com/me/x.git/' not found", "repo-not-found", "persistent"],
    ["远端不是 git 仓库", "fatal: 'https://example.com/x.git' does not appear to be a git repository", "repo-not-found", "persistent"],
    ["DNS 解析失败", "fatal: unable to access 'https://github.com/u/r.git/': Could not resolve host: github.com", "network", "transient"],
    ["连接失败", "fatal: unable to access 'https://github.com/u/r.git/': Failed to connect to github.com port 443 after 30000 ms: Couldn't connect to server", "network", "transient"],
    ["连接被拒", "ssh: connect to host github.com port 22: Connection refused", "network", "transient"],
    ["TLS 失败", "fatal: unable to access 'https://github.com/u/r.git/': SSL certificate problem: unable to get local issuer certificate", "network", "transient"],
    ["index.lock 冲突", "fatal: Unable to create '/x/.git/index.lock': File exists.", "lock", "manual"],
    ["可疑所有权", "fatal: detected dubious ownership in repository at '/x'", "manual", "manual"],
    ["游离 HEAD", "fatal: You are not currently on a branch.", "manual", "manual"],
    ["未完成的合并", "fatal: You have not concluded your merge (MERGE_HEAD exists).", "manual", "manual"],
    ["未知失败", "fatal: something nobody has seen before", "unknown", "unknown"],
    ["workdir 不存在（cannot change to）", "fatal: cannot change to '/x/teams': No such file or directory", "workdir-missing", "persistent"],
    ["远端读取失败兜底", "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights", "auth", "persistent"],
    ["未完成的变基", "fatal: You have not concluded your rebase (REBASE_HEAD exists).", "manual", "manual"],
    ["拣选进行中", "fatal: You are in the middle of a cherry-pick", "manual", "manual"],
  ])("%s → %s/%s", (_desc, stderr, reason, kind) => {
    const cls = classifyGitError(failure(stderr as string));
    expect(cls.reason).toBe(reason);
    expect(cls.kind).toBe(kind);
    expect(cls.message.length).toBeGreaterThan(0);
  });

  it("超时优先于文案（timedOut=true）", () => {
    const cls = classifyGitError(failure("fatal: could not read Username: terminal prompts disabled", { timedOut: true, code: null }));
    expect(cls.reason).toBe("timeout");
    expect(cls.kind).toBe("transient");
  });

  it("spawn ENOENT 优先于空 stderr", () => {
    const cls = classifyGitError(failure("", { code: null, spawnError: "ENOENT" }));
    expect(cls.reason).toBe("git-missing");
  });

  it.each([
    ["ENOTDIR", "workdir-missing"],
    ["EISDIR", "workdir-missing"],
    ["EACCES", "spawn-denied"],
    ["EPERM", "spawn-denied"],
    ["EAGAIN", "spawn-failed"],
  ])("spawnError %s → %s（不冒充 git-missing，审查 #6）", (code, reason) => {
    const cls = classifyGitError(failure("", { code: null, spawnError: code }));
    expect(cls.reason).toBe(reason);
    expect(cls.kind).toBe("persistent");
    expect(cls.fix).toBeTruthy();
  });

  it("输出超上限 → 明确诊断（不做文案猜测）", () => {
    const cls = classifyGitError(failure("fatal: Authentication failed", { outputLimitExceeded: true }));
    expect(cls.reason).toBe("output-limit");
  });

  it("成功结果不参与分类（tolerant → unknown，无修法建议）", () => {
    const cls = classifyGitError({ ...failure(""), ok: true, code: 0 });
    expect(cls.reason).toBe("unknown");
    expect(cls.fix).toBeNull();
  });

  it("persistent/manual 分类带修法，transient 给出重试建议", () => {
    expect(classifyGitError(failure("fatal: Unable to create '/x/.git/index.lock': File exists.")).fix).toBeTruthy();
    expect(classifyGitError(failure("fatal: could not read Username: terminal prompts disabled")).fix).toContain("凭据");
    expect(classifyGitError(failure("fatal: unable to access 'x': Could not resolve host: github.com")).fix).toContain("重试");
  });
});
