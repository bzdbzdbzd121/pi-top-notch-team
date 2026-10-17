/**
 * 统一 git 执行器（方案 §7.A / §7.D 实现纪律）。
 *
 * 所有 git 调用必须经本模块，目的是把「与 git 对话」的底座做扎实：
 *  - 环境硬化：固定 `LC_ALL=C`、禁用一切交互式提示、清除外部注入的
 *    `GIT_DIR` / `GIT_WORK_TREE` 等定位变量（否则 git 会跑到别的仓库去）；
 *  - 统一 `git -C <dir>`：不依赖进程 cwd，路径语义始终相对同一个工作区；
 *  - 网络命令硬超时并 kill（SIGTERM → SIGKILL），不让 ssh/git 挂死 pi；
 *  - 输出捕获带上限，结果结构化为 `{ ok, stdout, stderr, code }`；
 *  - `-z` 解析 helper（路径可能含空格/中文/换行，禁止按行切分）；
 *  - 失败分类纯函数（暂态 / 持久 / 需人工），供启动检测与命令层决定
 *    「静默重试 / 提示修法 / 中止诊断」。
 *
 * 生产代码里除本模块外不得直接使用 child_process（阶段 5 有静态守卫）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";

/** 本地命令默认超时（毫秒）。网络命令（fetch/push/ls-remote）由调用点显式放大。 */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** 单条流（stdout/stderr）默认最多捕获 1 MiB，超出即 kill。 */
export const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

/** SIGTERM 后等待多久升级为 SIGKILL。 */
const KILL_GRACE_MS = 500;

/** SIGKILL 后仍未收到 close 时的最后兜底（防止 promise 永不 settle）。 */
const HARD_STOP_MS = 2_000;

/**
 * 需要从继承环境里清除的 git 定位/配置变量（方案 §7.D 清单 + 审查建议 #7）。
 * 顺序无关；我们自己的临时索引在清除**之后**经 `env` 注入。
 */
export const GIT_ENV_STRIPPED = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
] as const;

/**
 * 动态注入的 git 配置（`GIT_CONFIG_COUNT` + 配对的 `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n`）——可注入 core.sshCommand、core.hooksPath 等任意配置，
 * 必须逐键清除。
 */
export const GIT_ENV_STRIPPED_PATTERNS = [/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/] as const;

export interface GitRunOptions {
  /** 工作区/仓库目录，作为 `git -C <cwd>` 传入。 */
  cwd: string;
  /** 硬超时（毫秒）；到点 SIGTERM→SIGKILL。缺省 DEFAULT_GIT_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 在环境硬化之后追加的环境变量（如临时索引 GIT_INDEX_FILE）。 */
  env?: Record<string, string>;
  /** 单条流的捕获上限（字节）。缺省 DEFAULT_MAX_BUFFER_BYTES。 */
  maxBuffer?: number;
  /** 写入子进程 stdin 的数据（写完后关闭）；缺省关闭 stdin。 */
  stdin?: string;
  /** git 可执行文件，仅测试注入用；缺省 "git"。 */
  binary?: string;
}

export interface SpawnCaptureResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 退出码；被信号杀死或 spawn 失败时为 null。 */
  code: number | null;
  /** 超时被 kill。 */
  timedOut: boolean;
  /** 输出超过 maxBuffer 被 kill。 */
  outputLimitExceeded: boolean;
  /** spawn 失败码（如 "ENOENT"）。 */
  spawnError?: string;
}

export interface GitResult extends SpawnCaptureResult {
  /** 可读的调用串（供诊断；地址脱敏由展示层负责）。 */
  command: string;
}

export interface SpawnCaptureOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  stdin?: string;
}

/**
 * 构造 git 子进程环境（纯函数，便于单测）。
 * `extra` 在硬化之后应用：调用点可覆盖（例如设置自己的临时索引）。
 */
export function buildGitEnv(
  extra?: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of GIT_ENV_STRIPPED) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (GIT_ENV_STRIPPED_PATTERNS.some((pattern) => pattern.test(key))) {
      delete env[key];
    }
  }

  // 稳定错误文案（分类依赖英文关键字）+ 禁止任何交互式提示。
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never"; // Git Credential Manager 不弹窗（非交互封堵）
  env.GIT_PAGER = "cat";
  env.GIT_EDITOR = "true";

  // SSH 默认非交互（BatchMode 同时禁用密码/口令与主机指纹确认）。
  // 用户显式配置的 GIT_SSH_COMMAND / GIT_SSH 不被覆盖；注意 core.sshCommand
  // 会被这里的环境变量压过——需要自定义 ssh 命令的用户应改用 GIT_SSH_COMMAND。
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }

  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

/**
 * 低层进程捕获原语：执行任意二进制、捕获输出、超时/输出超限即 kill。
 * （git 语义由 runGit 负责，本函数保持通用以便单测注入假二进制。）
 */
export function spawnCapture(
  binary: string,
  args: string[],
  options: SpawnCaptureOptions
): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER_BYTES;

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let code: number | null = null;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: string | undefined;
    let settled = false;

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let hardStopTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        ok: !timedOut && !outputLimitExceeded && !spawnError && code === 0,
        stdout,
        stderr,
        code,
        timedOut,
        outputLimitExceeded,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };

    const terminate = (): void => {
      try {
        child?.kill("SIGTERM");
      } catch {
        /* 进程可能已退出 */
      }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        child?.unref();
        if (!hardStopTimer) {
          hardStopTimer = setTimeout(finish, HARD_STOP_MS);
        }
      }, KILL_GRACE_MS);
    };

    // spawn 对部分错误（cwd 不是目录的 ENOTDIR、参数非法等）是**同步抛错**，
    // 不走 error 事件——必须在此捕获，否则 Promise 会 reject，违反「结构化
    // 结果」契约（调用点不包 try/catch 就会中断整个同步流程）。
    let child: ChildProcess | undefined;
    try {
      child = spawn(binary, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      spawnError = (err as NodeJS.ErrnoException).code ?? "SPAWN_ERROR";
      finish();
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const appendChunk = (which: "stdout" | "stderr", chunk: string): void => {
      if (outputLimitExceeded) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      const used = which === "stdout" ? stdoutBytes : stderrBytes;
      if (used + bytes > maxBuffer) {
        outputLimitExceeded = true;
        const remaining = Math.max(0, maxBuffer - used);
        const head = remaining > 0 ? Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8") : "";
        if (which === "stdout") {
          stdout += head;
          stdoutBytes = maxBuffer;
        } else {
          stderr += head;
          stderrBytes = maxBuffer;
        }
        terminate();
        return;
      }
      if (which === "stdout") {
        stdout += chunk;
        stdoutBytes += bytes;
      } else {
        stderr += chunk;
        stderrBytes += bytes;
      }
    };

    child.stdout?.on("data", (chunk: string) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => appendChunk("stderr", chunk));

    if (child.stdin) {
      child.stdin.on("error", () => {
        /* 子进程提前退出导致的 EPIPE 无需上抛 */
      });
      child.stdin.end(options.stdin, "utf8");
    }

    child.on("error", (err) => {
      spawnError = (err as NodeJS.ErrnoException).code ?? "SPAWN_ERROR";
      finish();
    });
    child.on("close", (exitCode) => {
      code = exitCode;
      finish();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
  });
}

/** 用统一环境与 `git -C <cwd>` 执行 git，返回结构化结果。 */
export async function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
  const binary = options.binary ?? "git";
  // `-c credential.interactive=false`：git 自身不再向 credential helper 要求
  // 交互输入（与 GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never 构成三层封堵）。
  const gitArgs = ["-C", options.cwd, "-c", "credential.interactive=false", ...args];
  // 只有真实目录才能作为子进程 cwd：文件/不存在的路径交给 git 的
  // `cannot change to '<dir>'` 报错（可分类为 workdir-missing），
  // 避免 spawn 同步抛 ENOTDIR/ENOENT 被误判为「git 未安装」。
  const spawnCwd = isDirectory(options.cwd) ? options.cwd : process.cwd();

  const result = await spawnCapture(binary, gitArgs, {
    cwd: spawnCwd,
    env: buildGitEnv(options.env),
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    stdin: options.stdin,
  });

  return { ...result, command: formatGitCommand(binary, gitArgs) };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./*-]+$/;

/**
 * 送入诊断/日志的命令串中的 userinfo 脱敏（审查建议 #4）。
 * 命令参数里可能内嵌 URL（如 `git remote add origin <url>`），一律把所有
 * `scheme://userinfo@` 遮蔽为 `scheme://***@`（比展示层更严格——诊断串不需要
 * 可读的用户名，宁多遮不少遮）；路径中的 `@` 不受影响。
 */
function maskCommandArg(arg: string): string {
  return arg.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/?#]*)/g, (whole, scheme: string, authority: string) => {
    const at = authority.lastIndexOf("@");
    if (at < 0) return whole;
    return `${scheme}***@${authority.slice(at + 1)}`;
  });
}

/** 可读的调用串（含空白/引号的参数加引号；URL userinfo 已脱敏）。 */
export function formatGitCommand(binary: string, args: string[]): string {
  return [binary, ...args]
    .map((raw) => {
      const arg = maskCommandArg(raw);
      return SAFE_ARG.test(arg) ? arg : `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

/**
 * 解析 `-z` 输出（NUL 分隔记录；空记录丢弃）。
 * 路径可能含空格、中文、换行——禁止按行/空白切分。
 */
export function splitNullTerminated(raw: string): string[] {
  return raw.split("\0").filter((entry) => entry.length > 0);
}

export type GitErrorClass = "transient" | "persistent" | "manual" | "unknown";

export type GitErrorReason =
  | "git-missing"
  | "spawn-denied"
  | "spawn-failed"
  | "timeout"
  | "output-limit"
  | "network"
  | "auth"
  | "ssh-host-key"
  | "repo-not-found"
  | "not-a-repo"
  | "workdir-missing"
  | "lock"
  | "manual"
  | "unknown";

export interface GitErrorClassification {
  /** transient = 可重试；persistent = 需修环境；manual = 需人工处置；unknown = 原始输出兜底。 */
  kind: GitErrorClass;
  reason: GitErrorReason;
  /** 简短可读的原因（不含地址/凭据，可安全展示）。 */
  message: string;
  /** 修法建议；无建议时为 null。 */
  fix: string | null;
}

interface GitErrorPattern {
  pattern: RegExp;
  reason: GitErrorReason;
  kind: GitErrorClass;
  message: string;
  fix: string;
}

/**
 * 失败分类表（方案 §7.E；判据优先结构化，其次 `LC_ALL=C` 英文文案）。
 * 顺序即优先级：越具体越靠前。文案匹配统一大小写不敏感。
 */
const GIT_ERROR_PATTERNS: GitErrorPattern[] = [
  {
    pattern: /terminal prompts disabled|could not read (username|password)|authentication failed|invalid username or password|permission denied \(publickey\)|support for password authentication was removed/i,
    reason: "auth",
    kind: "persistent",
    message: "认证失败或凭据缺失",
    fix: "配置 git 凭据（SSH key / credential helper）后重试；可在终端手动执行一次 git fetch 验证",
  },
  {
    pattern: /host key verification failed/i,
    reason: "ssh-host-key",
    kind: "persistent",
    message: "SSH 主机指纹未信任",
    fix: "先在终端执行 ssh -T git@<主机> 并确认主机指纹，然后重试",
  },
  {
    pattern: /repository not found|does not appear to be a git repository|did you run git update-server-info/i,
    reason: "repo-not-found",
    kind: "persistent",
    message: "远端仓库不存在或无权访问",
    fix: "核对仓库地址与访问权限（私有仓库需已授权）",
  },
  {
    pattern: /could not resolve host|name or service not known|temporary failure in name resolution|nodename nor servname provided|no address associated with hostname/i,
    reason: "network",
    kind: "transient",
    message: "无法解析仓库主机（网络/DNS 问题）",
    fix: "检查网络连接后重试",
  },
  {
    pattern: /failed to connect to|connection refused|connection timed out|connection reset|network is unreachable|no route to host|operation timed out|unexpected disconnect|early eof/i,
    reason: "network",
    kind: "transient",
    message: "网络连接失败",
    fix: "检查网络连接后重试",
  },
  {
    pattern: /ssl certificate problem|ssl_error_syscall|gnutls_handshake|schannel|certificate verify failed/i,
    reason: "network",
    kind: "transient",
    message: "TLS/证书校验失败",
    fix: "检查网络环境（代理/证书）后重试",
  },
  {
    pattern: /index\.lock|unable to create '[^']*\.lock'/i,
    reason: "lock",
    kind: "manual",
    message: "仓库锁文件冲突（另一个 git/同步进程正在运行，或上次异常退出）",
    fix: "确认没有其它 git/sync 进程在运行（不要删除正在被使用的锁）；仅当确认是上次异常退出留下的残留时，才手动删除 .git/index.lock 后重试",
  },
  {
    pattern: /detected dubious ownership/i,
    reason: "manual",
    kind: "manual",
    message: "git 认为仓库所有权可疑（目录属主与当前用户不一致）",
    fix: "用 git config --global --add safe.directory <仓库路径> 明确信任该目录，或修正目录属主",
  },
  {
    pattern: /not currently on a branch|detached head/i,
    reason: "manual",
    kind: "manual",
    message: "仓库处于游离 HEAD 状态（不在任何分支上）",
    fix: "先手工切回目标分支（git switch <分支>）后重试",
  },
  {
    pattern: /not concluded your merge|not concluded your rebase|in the middle of an? (merge|rebase|cherry-pick|revert)|rebase in progress|merge in progress|cherry-pick in progress/i,
    reason: "manual",
    kind: "manual",
    message: "仓库存在未完成的合并/变基/拣选操作",
    fix: "先手工完成或中止该操作（git merge --abort / git rebase --abort）后重试",
  },
  {
    pattern: /not a git repository/i,
    reason: "not-a-repo",
    kind: "persistent",
    message: "目录尚未初始化为 git 仓库",
    fix: "运行 /team sync 完成首次接入（插件会初始化仓库并连接远端）",
  },
  {
    pattern: /cannot change to '[^']*'/i,
    reason: "workdir-missing",
    kind: "persistent",
    message: "工作目录不存在或不可进入",
    fix: "确认数据目录存在且可访问（顶层 --teams 目录会被自动创建）",
  },
  {
    pattern: /could not read from remote repository/i,
    reason: "auth",
    kind: "persistent",
    message: "无法读取远端仓库（通常是凭据或权限问题）",
    fix: "检查 git 凭据与仓库地址后重试",
  },
];

const UNKNOWN_CLASSIFICATION: GitErrorClassification = {
  kind: "unknown",
  reason: "unknown",
  message: "未识别的 git 失败",
  fix: null,
};

/**
 * 失败分类（纯函数，零 IO）。只在失败结果上有意义；
 * 成功结果按 unknown 返回（调用方只应分类失败）。
 */
export function classifyGitError(result: GitResult): GitErrorClassification {
  if (result.spawnError) {
    // spawn 错误按码分流（审查建议 #6）：ENOENT 才是「没装 git」；ENOTDIR 是
    // cwd 指向了文件；EACCES/EPERM 是权限问题；其余不冒充 git-missing。
    switch (result.spawnError) {
      case "ENOENT":
        return {
          kind: "persistent",
          reason: "git-missing",
          message: "未找到 git 命令或无法启动 git",
          fix: "安装 git 后重试（Debian/Ubuntu：sudo apt install git）",
        };
      case "ENOTDIR":
      case "EISDIR":
        return {
          kind: "persistent",
          reason: "workdir-missing",
          message: "工作目录不存在或不可进入",
          fix: "确认数据目录存在且可访问（顶层 --teams 目录会被自动创建）",
        };
      case "EACCES":
      case "EPERM":
        return {
          kind: "persistent",
          reason: "spawn-denied",
          message: "无法启动 git 进程（权限不足）",
          fix: "检查 git 可执行文件与工作目录的访问权限后重试",
        };
      default:
        return {
          kind: "persistent",
          reason: "spawn-failed",
          message: `无法启动 git 进程（${result.spawnError}）`,
          fix: "检查 git 安装与运行环境后重试",
        };
    }
  }
  if (result.timedOut) {
    return {
      kind: "transient",
      reason: "timeout",
      message: "git 命令超时（网络慢或主机不可达）",
      fix: "检查网络连接后重试",
    };
  }
  if (result.outputLimitExceeded) {
    return {
      kind: "persistent",
      reason: "output-limit",
      message: "git 输出超过大小上限（仓库可能存在异常超大对象）",
      fix: "手工检查仓库内容与体积；确认没有超大文件被纳入版本控制",
    };
  }
  if (result.ok) {
    return UNKNOWN_CLASSIFICATION;
  }

  for (const entry of GIT_ERROR_PATTERNS) {
    if (entry.pattern.test(result.stderr)) {
      return {
        kind: entry.kind,
        reason: entry.reason,
        message: entry.message,
        fix: entry.fix,
      };
    }
  }
  return UNKNOWN_CLASSIFICATION;
}
