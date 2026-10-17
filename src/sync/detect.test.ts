import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitResult } from "./git-runner";
import type { GitRun } from "./plan";
import { saveSyncConfig, type SyncConfig } from "./config";
import {
  detectCloudUpdates,
  formatDetectNotification,
  resetCloudDetectionLatchForTests,
  scheduleCloudDetection,
  type DetectOptions,
  type DetectSession,
} from "./detect";

// ── 假执行器（零真实 git / 零网络）────────────────────────────

const okResult = (stdout = "", command = "git"): GitResult => ({
  ok: true,
  stdout,
  stderr: "",
  code: 0,
  timedOut: false,
  outputLimitExceeded: false,
  command,
});

const failResult = (stderr: string, extra?: Partial<GitResult>): GitResult => ({
  ok: false,
  stdout: "",
  stderr,
  code: 128,
  timedOut: false,
  outputLimitExceeded: false,
  command: "git",
  ...extra,
});

const SPAWN_ERROR = (code: string): GitResult => ({
  ok: false,
  stdout: "",
  stderr: "",
  code: null,
  timedOut: false,
  outputLimitExceeded: false,
  command: "git",
  spawnError: code,
});

interface FakeRunner {
  runGit: GitRun;
  calls: string[][];
  commands(): string[];
}

/** 脚本化执行器：路由按参数前缀匹配，未命中的调用返回成功空输出。 */
function makeRunner(routes: (args: string[]) => GitResult | undefined): FakeRunner {
  const calls: string[][] = [];
  const runGit: GitRun = async (args) => {
    calls.push(args);
    return routes(args) ?? okResult();
  };
  return { runGit, calls, commands: () => calls.map((args) => args.join(" ")) };
}

const TEAM_SHA = "1111111111111111111111111111111111111111";
const CONFIG_URL = "git@github.com:me/team-defs.git";

let rootDir: string;
const teamsDir = (): string => join(rootDir, "teams");

/** 标准「一切正常、云端领先 behind 个提交」路由。 */
function routeHealthy(behind: number | string): (args: string[]) => GitResult | undefined {
  const remoteUrl = CONFIG_URL;
  return (args) => {
    if (args[0] === "--version") return okResult("git version 2.43.0\n");
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return okResult(`${teamsDir()}\n`);
    if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return okResult(`${join(teamsDir(), ".git")}\n`);
    if (args[0] === "config" && args[1] === "--get") return okResult(`${remoteUrl}\n`);
    if (args[0] === "symbolic-ref") return okResult("main\n");
    if (args[0] === "ls-remote") return okResult(`${TEAM_SHA}\trefs/heads/main\n`);
    if (args[0] === "fetch") return okResult("");
    if (args[0] === "rev-list") return okResult(`${behind}\t0\n`);
    return undefined;
  };
}

function enabledConfig(): SyncConfig {
  return { enabled: true, remoteUrl: CONFIG_URL, branch: "" };
}

function writeConfig(config: SyncConfig | null): void {
  if (config === null) return;
  saveSyncConfig(config, rootDir);
}

function session(overrides?: Partial<DetectSession>): { session: DetectSession; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  return {
    notify,
    session: {
      mode: "tui",
      hasUI: true,
      reason: "startup",
      notify: notify as unknown as DetectSession["notify"],
      ...overrides,
    },
  };
}

const detectOptions = (runner: FakeRunner, overrides?: Partial<DetectOptions>): DetectOptions => ({
  rootDir,
  runGit: runner.runGit,
  hardTimeoutMs: 5_000,
  ...overrides,
});

/** 等待游离 promise 跑完（自捕获路径没有可 await 的句柄）。 */
const flush = (rounds = 12): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, rounds));

beforeEach(() => {
  resetCloudDetectionLatchForTests();
  rootDir = mkdtempSync(join(tmpdir(), "sync-detect-"));
  mkdirSync(teamsDir(), { recursive: true });
});

afterEach(() => {
  resetCloudDetectionLatchForTests();
  rmSync(rootDir, { recursive: true, force: true });
});

// ── 判定层（纯逻辑，可断言 outcome）──────────────────────────

describe("阶段 3 启动检测：判定层", () => {
  it("未配置 / 未启用 / 缺地址 → 零动作（无任何 git 调用）", async () => {
    for (const config of [null, { enabled: false, remoteUrl: CONFIG_URL, branch: "" }, { enabled: true, remoteUrl: "", branch: "" }]) {
      writeConfig(config as SyncConfig | null);
      const runner = makeRunner(routeHealthy(2));
      const outcome = await detectCloudUpdates(detectOptions(runner));
      expect(outcome.kind).toBe("silent");
      expect(runner.calls.length).toBe(0);
      writeConfig(null);
      rmSync(join(rootDir, "sync.yaml"), { force: true });
    }
  });

  it("数据目录尚不存在（全新机器）→ 静默，零 git 调用（不把目录缺失误报成「没装 git」）", async () => {
    writeConfig(enabledConfig());
    rmSync(teamsDir(), { recursive: true, force: true });
    const runner = makeRunner(routeHealthy(2));
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome).toEqual({ kind: "silent", reason: "no-repo" });
    expect(runner.calls.length).toBe(0);
  });

  it("git 不可用（spawn ENOENT）→ 持久缺陷（带安装修法）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner((args) => (args[0] === "--version" ? SPAWN_ERROR("ENOENT") : undefined));
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("persistent");
    if (outcome.kind === "persistent") {
      expect(outcome.failure.classification.reason).toBe("git-missing");
      expect(outcome.failure.classification.fix).toContain("安装 git");
    }
  });

  it("无仓库 → 静默，且不做任何网络调用（首次接入走命令）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner((args) => {
      if (args[0] === "--version") return okResult("git version 2.43.0\n");
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return failResult("fatal: not a git repository");
      return undefined;
    });
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("silent");
    expect(runner.commands().some((c) => c.startsWith("ls-remote"))).toBe(false);
    expect(runner.commands().some((c) => c.startsWith("fetch"))).toBe(false);
  });

  it("origin 缺失 → 静默（首次接入场景，不误报）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner((args) => {
      if (args[0] === "--version") return okResult("git version 2.43.0\n");
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return okResult(`${teamsDir()}\n`);
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return okResult(`${join(teamsDir(), ".git")}\n`);
      if (args[0] === "config" && args[1] === "--get") return failResult("exit 1");
      if (args[0] === "symbolic-ref") return okResult("main\n");
      return undefined;
    });
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("silent");
    expect(runner.commands().some((c) => c.startsWith("ls-remote"))).toBe(false);
  });

  it("origin 地址与配置不一致 → 持久缺陷（提示一次 + 修法），不自动改写远端", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner((args) => {
      if (args[0] === "--version") return okResult("git version 2.43.0\n");
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return okResult(`${teamsDir()}\n`);
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return okResult(`${join(teamsDir(), ".git")}\n`);
      if (args[0] === "config" && args[1] === "--get") return okResult("git@github.com:other/elsewhere.git\n");
      if (args[0] === "symbolic-ref") return okResult("main\n");
      return undefined;
    });
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("persistent");
    if (outcome.kind === "persistent") {
      expect(outcome.failure.classification.message).toContain("不一致");
    }
    // 一致性判定放宽：尾斜杠差异不算不一致
    const sameWithSlash = makeRunner((args) => {
      if (args[0] === "--version") return okResult("git version 2.43.0\n");
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return okResult(`${teamsDir()}\n`);
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") return okResult(`${join(teamsDir(), ".git")}\n`);
      if (args[0] === "config" && args[1] === "--get") return okResult(`${CONFIG_URL}/\n`);
      if (args[0] === "symbolic-ref") return okResult("main\n");
      if (args[0] === "ls-remote") return okResult(`${TEAM_SHA}\trefs/heads/main\n`);
      if (args[0] === "fetch") return okResult("");
      if (args[0] === "rev-list") return okResult("0\t0\n");
      return undefined;
    });
    const slack = await detectCloudUpdates(detectOptions(sameWithSlash));
    expect(slack.kind).toBe("silent");
  });

  it("空远端 → 静默（无 fetch）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner((args) => {
      const base = routeHealthy(0)(args);
      if (args[0] === "ls-remote") return okResult("");
      return base;
    });
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("silent");
    expect(runner.commands().some((c) => c.startsWith("fetch"))).toBe(false);
  });

  it("云端领先 N 个提交 → updates(N)；fetch 不写 FETCH_HEAD（只读卫生）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner(routeHealthy(3));
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("updates");
    if (outcome.kind === "updates") expect(outcome.behind).toBe(3);
    const fetchCall = runner.calls.find((args) => args[0] === "fetch");
    expect(fetchCall).toContain("--no-write-fetch-head");
  });

  it("无更新（behind = 0）→ 静默", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner(routeHealthy(0));
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("silent");
  });

  it("本地分支不存在 → behind = 远端全部提交（不误报为无更新）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner((args) => {
      if (args[0] === "rev-list") return okResult("4\n");
      return routeHealthy(0)(args);
    });
    const outcome = await detectCloudUpdates(detectOptions(runner));
    expect(outcome.kind).toBe("updates");
    if (outcome.kind === "updates") expect(outcome.behind).toBe(4);
  });

  it("失败分类：认证/仓库不存在 → persistent；网络暂态/锁/需人工/未知 → 静默", async () => {
    writeConfig(enabledConfig());
    const cases: { stderr: string; kind: string }[] = [
      { stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", kind: "persistent" },
      { stderr: "remote: Repository not found.", kind: "persistent" },
      { stderr: "Permission denied (publickey).", kind: "persistent" },
      { stderr: "fatal: could not resolve host: github.com", kind: "silent" },
      { stderr: "fatal: unable to access 'https://x': Could not connect to server", kind: "silent" },
      { stderr: "fatal: Unable to create '.git/index.lock': File exists.", kind: "silent" },
      { stderr: "fatal: detected dubious ownership in repository", kind: "silent" },
      { stderr: "fatal: something nobody has seen before", kind: "silent" },
    ];
    for (const c of cases) {
      const runner = makeRunner((args) => {
        if (args[0] === "ls-remote") return failResult(c.stderr);
        return routeHealthy(0)(args);
      });
      const outcome = await detectCloudUpdates(detectOptions(runner));
      expect(`${c.kind}:${outcome.kind}`).toBe(`${c.kind}:${c.kind}`);
    }
  });

  it("fetch 阶段的持久失败同样上报（auth）；超时（timedOut）静默", async () => {
    writeConfig(enabledConfig());
    const auth = makeRunner((args) => {
      if (args[0] === "fetch") return failResult("fatal: Authentication failed for 'https://x'");
      return routeHealthy(0)(args);
    });
    expect((await detectCloudUpdates(detectOptions(auth))).kind).toBe("persistent");

    const timedOut = makeRunner((args) => {
      if (args[0] === "fetch")
        return failResult("", { ok: false, timedOut: true, code: null, stderr: "timed out" });
      return routeHealthy(0)(args);
    });
    expect((await detectCloudUpdates(detectOptions(timedOut))).kind).toBe("silent");
  });
});

// ── 通知文案（§7.F 定稿）────────────────────────────────────

describe("阶段 3 通知文案（§7.F）", () => {
  it("云端有更新 → 固定句式（不列团队名、不兼报本机未备份）", () => {
    expect(formatDetectNotification({ kind: "updates", behind: 2 })).toBe(
      "☁️ 云端有 2 个提交尚未同步到本机（运行 /team sync 查看并同步）"
    );
  });

  it("持久缺陷 → 原因 + 修法 + 详情指引", () => {
    const text = formatDetectNotification({
      kind: "persistent",
      failure: {
        classification: {
          kind: "persistent",
          reason: "auth",
          message: "认证失败或凭据缺失",
          fix: "配置 git 凭据（SSH key / credential helper）后重试",
        },
      },
    });
    expect(text).toBe(
      "☁️ 云同步暂不可用：认证失败或凭据缺失。配置 git 凭据（SSH key / credential helper）后重试（运行 /team sync status 查看详情）"
    );
  });

  it("无修法的持久缺陷 → 不出现空修法段", () => {
    const text = formatDetectNotification({
      kind: "persistent",
      failure: {
        classification: { kind: "persistent", reason: "unknown", message: "未识别的 git 失败", fix: null },
      },
    });
    expect(text).toBe("☁️ 云同步暂不可用：未识别的 git 失败（运行 /team sync status 查看详情）");
  });

  it("静默结果 → 无通知文案", () => {
    expect(formatDetectNotification({ kind: "silent", reason: "up-to-date" })).toBeNull();
  });
});

// ── 挂载层（进程级一次、非阻塞、自捕获、机械降级）───────────

describe("阶段 3 挂载层：scheduleCloudDetection", () => {
  it("进程级一次：首次 session_start 检测；/new、/fork、/resume 不重复", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner(routeHealthy(2));
    const inform = vi.fn();
    const first: DetectSession = { mode: "tui", hasUI: true, reason: "startup", notify: inform as never };

    scheduleCloudDetection(first, detectOptions(runner));
    await flush();
    const callsAfterFirst = runner.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(inform).toHaveBeenCalledTimes(1);
    expect(inform.mock.calls[0][1]).toBe("info"); // 有更新 = 提示级
    expect(String(inform.mock.calls[0][0])).toContain("☁️ 云端有 2 个提交尚未同步到本机");

    for (const reason of ["new", "fork", "resume", "startup"]) {
      const { session: s, notify } = session({ reason });
      scheduleCloudDetection(s, detectOptions(runner));
      await flush(4);
      expect(notify).not.toHaveBeenCalled(); // 同进程内不重复检测/通知
    }
    expect(runner.calls.length).toBe(callsAfterFirst); // 零新增调用
  });

  it("reason === 'reload' 显式跳过，且不消费一次守卫（随后真实启动仍检测）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner(routeHealthy(1));
    const { session: s, notify } = session();

    scheduleCloudDetection({ ...s, reason: "reload" }, detectOptions(runner));
    await flush(4);
    expect(runner.calls.length).toBe(0);

    scheduleCloudDetection(s, detectOptions(runner));
    await flush();
    expect(runner.calls.length).toBeGreaterThan(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("非 TUI（rpc/json/print）→ 静默降级：零调用、零通知、不抛错", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner(routeHealthy(2));
    for (const s of [{ mode: "rpc", hasUI: true }, { mode: "json", hasUI: false }, { mode: "print", hasUI: false }]) {
      const { session: sess, notify } = session(s);
      expect(() => scheduleCloudDetection(sess, detectOptions(runner))).not.toThrow();
      await flush(4);
      expect(notify).not.toHaveBeenCalled();
    }
    expect(runner.calls.length).toBe(0);
    // 未消费守卫：真正的 TUI 启动仍可检测
    const { session: tui, notify: tuiNotify } = session();
    scheduleCloudDetection(tui, detectOptions(runner));
    await flush();
    expect(tuiNotify).toHaveBeenCalledTimes(1);
  });

  it("不阻塞：处理器同步返回，网络工作在游离 promise 中", async () => {
    writeConfig(enabledConfig());
    let releaseRunner: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runner = makeRunner(routeHealthy(2));
    const slowRunGit: GitRun = async (args, options) => {
      await gate; // 卡住整个检测
      return runner.runGit(args, options);
    };
    const { session: s, notify } = session();

    const before = Date.now();
    scheduleCloudDetection(s, { rootDir, runGit: slowRunGit, hardTimeoutMs: 5_000 });
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(100); // 同步返回，未等待网络
    expect(notify).not.toHaveBeenCalled();
    releaseRunner?.();
    await flush(50);
    expect(notify).toHaveBeenCalledTimes(1); // 放行后正常出结果
  });

  it("自捕获：执行器同步抛错不会外泄（不阻断会话初始化、不产生未处理拒绝）", async () => {
    writeConfig(enabledConfig());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const throwing: GitRun = () => {
      throw new Error("boom: git 执行器同步抛错");
    };
    const { session: s, notify } = session();

    expect(() => scheduleCloudDetection(s, { rootDir, runGit: throwing })).not.toThrow();
    await flush(20);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(notify).not.toHaveBeenCalled(); // 未知失败 → 静默
  });

  it("硬超时：内部卡死也能静默结束（无通知、无未处理拒绝）", async () => {
    writeConfig(enabledConfig());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const hanging: GitRun = () => new Promise<GitResult>(() => {});
    const { session: s, notify } = session();

    scheduleCloudDetection(s, { rootDir, runGit: hanging, hardTimeoutMs: 30 });
    await flush(80);
    process.off("unhandledRejection", onUnhandled);
    expect(notify).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("notify 抛错不外泄（UI 桩异常时静默）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner(routeHealthy(1));
    const notify = vi.fn(() => {
      throw new Error("ui stub exploded");
    });
    const s: DetectSession = { mode: "tui", hasUI: true, reason: "startup", notify: notify as never };
    expect(() => scheduleCloudDetection(s, detectOptions(runner))).not.toThrow();
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("持久缺陷恰好一次通知（同一次检测内不重复）", async () => {
    writeConfig(enabledConfig());
    const runner = makeRunner((args) => {
      if (args[0] === "ls-remote") return failResult("fatal: could not read Username for 'https://x': terminal prompts disabled");
      return routeHealthy(0)(args);
    });
    const { session: s, notify } = session();
    scheduleCloudDetection(s, detectOptions(runner));
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain("☁️ 云同步暂不可用");
    expect(String(notify.mock.calls[0][0])).toContain("配置 git 凭据"); // 修法原文
    expect(notify.mock.calls[0][1]).toBe("warning"); // 持久缺陷 = 警告级
  });
});

// ── 真实配置读取（不覆盖 loadConfig 注入）─────────────────────

describe("阶段 3 配置读取守卫", () => {
  it("注入 loadConfig 时以注入为准（测试可禁用真实配置读取）", async () => {
    writeFileSync(join(rootDir, "sync.yaml"), "enabled: false\n", "utf-8");
    const runner = makeRunner(routeHealthy(1));
    const outcome = await detectCloudUpdates({
      ...detectOptions(runner),
      loadConfig: () => enabledConfig(),
    });
    expect(outcome.kind).toBe("updates");
  });
});
