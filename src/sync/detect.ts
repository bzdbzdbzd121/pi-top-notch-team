/**
 * 阶段 3：启动提醒（方案 §5 阶段 3、§7.E、§7.F）。
 *
 * 目标：pi 启动后**异步**检测一次并提醒——不阻塞、不重复、不误报。
 *
 * 设计要点（与方案的对应关系）：
 *  - **进程级一次**：模块级 latch，同进程内的 `/new`、`/fork`、`/resume` 不重复检测；
 *    `reason === "reload"`（扩展热重载）显式跳过且**不消费**守卫（下一次真实启动仍检测）。
 *  - **fire-and-forget**：`scheduleCloudDetection` 同步返回；网络工作放在游离 promise 中，
 *    自身 `try/catch`（游离 promise 的拒绝无人接住）+ 整体硬超时。上游在会话初始化时会
 *    await `session_start` 的处理链，处理器内直接 await 网络会推迟启动。
 *  - **不推送、不改团队文件与工作区**：仅 `ls-remote` + `fetch --no-write-fetch-head`
 *    （读取云端并更新 `.git` 内对象/远端跟踪引用；不写 FETCH_HEAD、不动分支引用）。
 *  - **失败分类**（§7.E 表）：暂态（网络/超时/锁）与未知 → 静默；持久缺陷（git 未装、
 *    认证/权限、仓库不存在、地址不一致）→ 恰好一次通知 + 修法；需人工 → 静默（留给命令处理）。
 *  - **无用户在场的 UI**（rpc/json/print）→ 静默降级：不检测、不通知、不抛错。
 */
import { existsSync, realpathSync } from "node:fs";
import { getRootDir } from "../config";
import { getTeamsDir } from "../team/store";
import { loadSyncConfig, maskRemoteUrl, type SyncConfig } from "./config";
import { runGit } from "./git-runner";
import {
  discoverRemoteBranch,
  failureFromResult,
  fetchRemote,
  inspectRepo,
  runLocalGit,
  type GitRun,
  type PreparedRepository,
  type SyncContext,
  type SyncFailure,
} from "./plan";

/** 启动检测的网络命令超时（比同步的网络预算短：启动路径只做一次轻量检查）。 */
export const DEFAULT_DETECT_NETWORK_TIMEOUT_MS = 15_000;

/** 整体硬超时：无论内部卡在哪一步，到点静默结束（绝不挂住启动）。 */
export const DEFAULT_DETECT_HARD_TIMEOUT_MS = 20_000;

/** 静默原因（仅用于诊断/测试断言，不面向用户）。 */
export type DetectSilentReason =
  | "not-configured"
  | "no-ui"
  | "no-repo"
  | "no-origin"
  | "empty-remote"
  | "up-to-date"
  | "transient"
  | "manual"
  | "unknown";

export type DetectOutcome =
  | { kind: "silent"; reason: DetectSilentReason }
  | { kind: "updates"; behind: number }
  | { kind: "persistent"; failure: SyncFailure };

export interface DetectOptions {
  /** 数据目录（默认 `getRootDir()`）。 */
  rootDir?: string;
  /** git 执行器（测试注入假执行器；生产用统一执行器）。 */
  runGit?: GitRun;
  /** 配置读取（测试注入；生产读 `<rootDir>/sync.yaml`）。 */
  loadConfig?: (rootDir: string) => SyncConfig | null;
  /** 网络命令超时（默认 15s）。 */
  networkTimeoutMs?: number;
  /** 整体硬超时（默认 20s）。 */
  hardTimeoutMs?: number;
}

export interface DetectSession {
  /** `ctx.mode`（"tui" | "rpc" | "json" | "print"）。 */
  mode?: string;
  /** `ctx.hasUI`。 */
  hasUI?: boolean;
  /** `session_start` 的 reason（"startup" | "reload" | "new" | "resume" | "fork"）。 */
  reason?: string;
  /** 通知出口（`ctx.ui.notify`）。 */
  notify: (text: string, level?: "info" | "warning") => void;
}

// ── 进程级一次守卫 ───────────────────────────────────────────

let detectionLatched = false;

/** 测试用：重置进程级一次守卫（生产不调用）。 */
export function resetCloudDetectionLatchForTests(): void {
  detectionLatched = false;
}

/** 无用户在场的通知出口（rpc/json/print）→ 静默降级。 */
function hasUserFacingUi(session: DetectSession): boolean {
  return session.mode === "tui" && session.hasUI !== false;
}

/**
 * `session_start` 挂载点：**同步返回**，检测在游离 promise 中进行。
 * 幂等：同进程内只有首次真实启动会检测（`reload` 不消费守卫）。
 */
export function scheduleCloudDetection(session: DetectSession, options?: DetectOptions): void {
  if (detectionLatched) return;
  if (session.reason === "reload") return; // 扩展热重载不触发新检测（也不消费守卫）
  if (!hasUserFacingUi(session)) return; // 非 TUI：静默降级（零网络、零通知、不抛错）
  detectionLatched = true;
  void runDetached(session, options ?? {});
}

/** 游离执行体：自捕获 + 硬超时（这两条是「不阻塞、不误终止进程」的结构保证）。 */
async function runDetached(session: DetectSession, options: DetectOptions): Promise<void> {
  const hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_DETECT_HARD_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, hardTimeoutMs);
    // 不持有事件循环（与批屏障/等待轮询同一纪律）
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  try {
    const outcome = await Promise.race([detectCloudUpdates(options), deadline]);
    if (outcome !== undefined) notifyOutcome(session, outcome);
  } catch {
    // 游离 promise 无人接住拒绝：任何异常（含执行器同步抛错、配置读取抛错）都在此吞掉
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function notifyOutcome(session: DetectSession, outcome: DetectOutcome): void {
  const text = formatDetectNotification(outcome);
  if (text === null) return;
  try {
    session.notify(text, outcome.kind === "persistent" ? "warning" : "info");
  } catch {
    /* UI 桩异常（无 UI 模式的桩实现）→ 静默 */
  }
}

/** 通知文案（纯函数，方案 §7.F 定稿）。静默结果返回 null。 */
export function formatDetectNotification(outcome: DetectOutcome): string | null {
  if (outcome.kind === "updates") {
    return `☁️ 云端有 ${outcome.behind} 个提交尚未同步到本机（运行 /team sync 查看并同步）`;
  }
  if (outcome.kind === "persistent") {
    const { message, fix } = outcome.failure.classification;
    const detail = fix ? `${message}。${fix}` : message;
    return `☁️ 云同步暂不可用：${detail}（运行 /team sync status 查看详情）`;
  }
  return null;
}

// ── 判定逻辑（不推送、不改团队文件与工作区；可注入执行器）──────

/**
 * 检测一次（不通知、不写任何文件）。
 *
 * 流程（§7.E）：配置未启用 → 返回；git 不可用 → 持久提示；无仓库 → 静默（首次接入走命令）；
 * 地址不一致 → 提示一次；`ls-remote --heads` → 分类；空远端 → 静默；`fetch`（不写
 * FETCH_HEAD）→ 图关系比较 → 落后 > 0 才报「有更新」（保持 D14：不列团队名、不兼报本机未备份）。
 */
export async function detectCloudUpdates(options: DetectOptions = {}): Promise<DetectOutcome> {
  const rootDir = options.rootDir ?? getRootDir();
  const config = (options.loadConfig ?? loadSyncConfig)(rootDir);
  if (config === null || config.enabled !== true || config.remoteUrl.length === 0) {
    return { kind: "silent", reason: "not-configured" };
  }

  const ctx: SyncContext = {
    rootDir,
    teamsDir: getTeamsDir(rootDir),
    config,
    runGit: options.runGit ?? runGit,
    networkTimeoutMs: options.networkTimeoutMs ?? DEFAULT_DETECT_NETWORK_TIMEOUT_MS,
  };

  // 0. 数据目录尚不存在（全新机器）→ 静默：首次接入走 /team sync。
  //    放在 git 调用之前：cwd 不存在时 spawn 失败码与「没装 git」同为 ENOENT，
  //    先判定可避免误报「未找到 git 命令」。
  if (!existsSync(ctx.teamsDir)) return { kind: "silent", reason: "no-repo" };

  // 1. git 是否可用（未安装/无法启动 = 持久缺陷，带安装指引）
  const version = await runLocalGit(ctx, ["--version"]);
  if (!version.ok) return startupOutcome(failureFromResult(version));

  // 2. 仓库探测（无仓库 → 静默：首次接入交给 /team sync 的引导流程）
  const state = await inspectRepo(ctx);
  if (!state.hasRepo) return { kind: "silent", reason: "no-repo" };

  // 3. origin 与配置的一致性
  if (state.originUrl === null) {
    // 仓库里还没有 origin（首次接入/手工建仓）→ 静默，交给命令补
    return { kind: "silent", reason: "no-origin" };
  }
  if (!sameRemoteUrl(state.originUrl, config.remoteUrl)) {
    // 不一致需要用户确认才改地址（/team sync 会问），启动只提示一次、绝不自动改写
    return {
      kind: "persistent",
      failure: {
        classification: {
          kind: "persistent",
          reason: "manual",
          message: `本机仓库的 origin 地址与同步配置不一致（origin: ${maskRemoteUrl(state.originUrl)}）`,
          fix: "运行 /team sync 按提示确认改用配置地址，或在 /team setting → 云同步（机器级）中更新地址",
        },
      },
    };
  }

  // 4. 远端分支发现（ls-remote；空远端 → 没有可同步的内容）
  const discovery = await discoverRemoteBranch(ctx, config.branch);
  if (!discovery.ok) return startupOutcome(discovery.failure);
  if (discovery.emptyRemote) return { kind: "silent", reason: "empty-remote" };

  // 5. 真实取回（只写 .git；不写 FETCH_HEAD——不与进行中的 sync/status 互相干扰）
  const prepared: PreparedRepository = {
    branch: discovery.branch,
    branchSource: discovery.source,
    emptyRemote: false,
    remoteSha: discovery.remoteSha,
    remoteUrlChanged: false,
    state,
  };
  const fetched = await fetchRemote(ctx, prepared, { noWriteFetchHead: true });
  if (!fetched.ok) return startupOutcome(fetched.failure);

  // 6. 图关系比较（§4.6：不是「SHA 不同」，而是「远端有本机没有的提交」）
  const behind = await countCommitsBehind(ctx, fetched.remoteSha, discovery.branch);
  return behind > 0 ? { kind: "updates", behind } : { kind: "silent", reason: "up-to-date" };
}

/** 失败 → 启动判定：持久缺陷提示一次；暂态/需人工/未知一律静默（§7.E 表）。 */
function startupOutcome(failure: SyncFailure): DetectOutcome {
  const { kind } = failure.classification;
  if (kind === "persistent") return { kind: "persistent", failure };
  if (kind === "transient") return { kind: "silent", reason: "transient" };
  if (kind === "manual") return { kind: "silent", reason: "manual" };
  return { kind: "silent", reason: "unknown" };
}

/**
 * 本机落后远端的提交数（远端可达、本机分支不可达）。
 * 读不到任何一侧就返回 0：启动提醒宁可漏报，绝不误报。
 */
async function countCommitsBehind(ctx: SyncContext, remoteSha: string, branch: string): Promise<number> {
  const localRef = `refs/heads/${branch}`;
  const exists = await runLocalGit(ctx, ["rev-parse", "--verify", "--quiet", localRef]);
  if (exists.ok && exists.stdout.trim().length > 0) {
    const counts = await runLocalGit(ctx, ["rev-list", "--left-right", "--count", `${remoteSha}...${localRef}`]);
    if (!counts.ok) return 0;
    const [behindRaw] = counts.stdout.trim().split(/\s+/);
    const behind = Number.parseInt(behindRaw ?? "0", 10);
    return Number.isFinite(behind) && behind > 0 ? behind : 0;
  }
  // 本地尚无该分支：远端全部提交都是本机没有的（首次接入前也会如实提醒「云端有 N 个提交」）
  const all = await runLocalGit(ctx, ["rev-list", "--count", remoteSha]);
  if (!all.ok) return 0;
  const behind = Number.parseInt(all.stdout.trim(), 10);
  return Number.isFinite(behind) && behind > 0 ? behind : 0;
}

/**
 * 地址等价判定（尾斜杠与本地路径 realpath 归一）。
 * 与 `plan.ts` 的 `normalizeRemoteUrlForComparison` 同一规则；本阶段不改 plan.ts，
 * 故此处保留同规则实现（后续若提取共享工具，两处需一起迁移）。
 */
function sameRemoteUrl(a: string, b: string): boolean {
  return normalizeComparableUrl(a) === normalizeComparableUrl(b);
}

function normalizeComparableUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("/")) {
    try {
      return realpathSync(trimmed);
    } catch {
      return trimmed; // 路径尚不存在：保持字面值
    }
  }
  return trimmed;
}
