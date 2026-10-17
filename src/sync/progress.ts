/**
 * `/team sync` 进行中反馈：阶段文案、秒数与生命周期（方案 §3.3–§3.6 / §7.B）。
 *
 * 设计要点：
 *  - **只写底部状态栏**（键名 `cloud-sync`）：模块内不出现任何聊天区通知原语
 *    （静态断言锁定源码不含该 API 名）——「正在进行」字样只允许出现在状态栏。
 *  - **秒数 = 时间戳差值**：记录当前阶段开始时刻，每秒 tick 时用 `now() - startedAt`
 *    重新计算（不做「每秒 +1」累加，事件循环阻塞后不会漂移）；进入新阶段从 0 重新计。
 *  - **等待态不显示秒数**：用户阅读/思考的时间不该被算进「同步耗时」，等待期间停表。
 *  - **计时器纪律**：1 秒 `setInterval` + `unref()`；`end()` 清除且幂等；结束后
 *    `stage()`/`wait()` 为 no-op（防终态清理后再写回状态栏）。
 *  - **fail-open**：所有 UI 调用都在 try/catch 内；`ui`/`setStatus` 缺失时全部 no-op。
 *  - **可注入**：`now`/`setInterval`/`clearInterval` 可注入，便于单测与假定时器。
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** 状态栏键名（与既有 `team-members-running`、`tl-pre-dispatch-guard` 等互不覆盖）。 */
export const SYNC_PROGRESS_STATUS_KEY = "cloud-sync";

/** 阶段词表（§3.3 v1 定稿）。`checking` 仅用于 `/team sync status` 的网络检查段。 */
export type SyncStage = "prepare" | "connect" | "fetch" | "compare" | "apply" | "checking";

/** 等待态：确认对话框 / 冲突逐个决策（§3.4）。 */
export type SyncWaitKind = "confirm" | "decision";

/** 阶段词（关键词前置，窄终端截断时先保留「云同步」与阶段词）。 */
const STAGE_WORDS: Record<SyncStage, string> = {
  prepare: "准备中…",
  connect: "连接云端…",
  fetch: "获取云端更新…",
  compare: "比对差异…",
  apply: "应用并推送…",
  checking: "正在检查云端状态…",
};

const WAIT_WORDS: Record<SyncWaitKind, string> = {
  confirm: "⏸ 等待你的确认",
  decision: "⏸ 等待你的决策",
};

const PREFIX = "☁️ 云同步：";
const TICK_MS = 1000;

/**
 * 秒数格式化：向下取整（0s/1s/59s/120s）。
 * 非有限值（NaN/Infinity）与负数一律兜底为 0s——注入时钟异常时显示「（0s）」而不是「（NaNs）」。
 */
function formatSeconds(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return "0s";
  const seconds = Math.max(0, Math.floor(elapsedMs / TICK_MS));
  return `${seconds}s`;
}

/** 阶段文本：`☁️ 云同步：<阶段词>（<本阶段已用秒数>s）`（纯函数）。 */
export function formatSyncStageText(stage: SyncStage, elapsedMs: number): string {
  return `${PREFIX}${STAGE_WORDS[stage]}（${formatSeconds(elapsedMs)}）`;
}

/**
 * 等待态文本（纯函数）：**不含秒数**。
 * 决策态在拿到合法计数时显示 `（i/n）`，让用户知道还要回答几次；
 * 计数缺失或越界（`1 ≤ i ≤ n` 之外，如 `0/3`、`5/3`）一律退化为无计数形态——
 * 宁可不显示，也不显示自相矛盾的进度。
 */
export function formatSyncWaitText(kind: SyncWaitKind, index?: number, total?: number): string {
  const word = WAIT_WORDS[kind];
  const validCount =
    Number.isInteger(index) &&
    Number.isInteger(total) &&
    (total as number) > 0 &&
    (index as number) >= 1 &&
    (index as number) <= (total as number);
  if (kind === "decision" && validCount) {
    return `${PREFIX}${word}（${index}/${total}）`;
  }
  return `${PREFIX}${word}`;
}

/** 进度写入出口（`ctx.ui` 的子集；只要求 setStatus）。 */
export interface SyncProgressUi {
  setStatus?: ExtensionUIContext["setStatus"];
}

export interface SyncProgressOptions {
  /** 时钟（默认 `Date.now`）——测试注入以推进「时间」。 */
  now?: () => number;
  /** 定时器（默认全局；测试注入假定时器）。 */
  setInterval?: (callback: () => void, ms: number) => unknown;
  /** 清除定时器（默认全局）。 */
  clearInterval?: (handle: unknown) => void;
}

export interface SyncProgressHandle {
  /** 进入阶段（写入非空状态并起表）；`end()` 之后为 no-op。 */
  stage(stage: SyncStage): void;
  /** 进入等待态（写入无秒数状态并停表）；`end()` 之后为 no-op。 */
  wait(kind: SyncWaitKind, index?: number, total?: number): void;
  /** 清除状态与计时器（幂等）。 */
  end(): void;
}

/**
 * 创建进度句柄（方案 §3.6：入口统一开启 + 出口统一清除）。
 *
 * 调用方约定：取得同步锁之后、`try` 块内第一件事创建；终态提示前调用一次 `end()`，
 * 既有 `finally` 再兜底一次（幂等）。取锁失败/非交互拒绝等出口**不要**创建本句柄，
 * 也就不存在残留。
 */
export function createSyncProgress(ui: SyncProgressUi, options?: SyncProgressOptions): SyncProgressHandle {
  const now = options?.now ?? (() => Date.now());
  const setIntervalFn = options?.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const clearIntervalFn = options?.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

  let timer: unknown;
  let ended = false;
  let currentStage: SyncStage | null = null;
  let stageStartedAt = 0;

  /** 是否存在可用的状态栏出口（无 UI 时进度无处可去，不起任何定时器）。 */
  const hasStatusUi = (): boolean => typeof ui?.setStatus === "function";

  const write = (text: string | undefined): void => {
    try {
      const setStatus = ui?.setStatus;
      if (typeof setStatus !== "function") return; // 无 UI：静默降级
      setStatus.call(ui, SYNC_PROGRESS_STATUS_KEY, text);
    } catch {
      /* fail-open：UI 抛错不影响同步流程 */
    }
  };

  const stopTimer = (): void => {
    if (timer === undefined) return;
    try {
      clearIntervalFn(timer);
    } catch {
      /* fail-open */
    }
    timer = undefined;
  };

  const startTimer = (): void => {
    if (timer !== undefined) return; // 已在计时（重复进入同一阶段不堆定时器）
    let handle: unknown;
    try {
      handle = setIntervalFn(() => {
        if (currentStage === null) return;
        // 时间戳差值：阻塞后一次 tick 就跳到真实耗时（不漂移）
        write(formatSyncStageText(currentStage, now() - stageStartedAt));
      }, TICK_MS);
    } catch {
      timer = undefined; // setInterval 本身不可用：进度仍可见（只是不刷新秒数）
      return;
    }
    // 句柄先登记再 unref：unref 抛错时定时器仍可被 end()/wait() 清理
    //（否则未 unref 的 interval 会阻止进程退出，且再无句柄可清）。
    timer = handle;
    try {
      (handle as { unref?: () => void } | undefined)?.unref?.();
    } catch {
      /* unref 失败：句柄已登记，clearInterval 仍然有效 */
    }
  };

  return {
    stage(stage: SyncStage): void {
      if (ended) return;
      if (!hasStatusUi()) return; // 无 UI：不写状态、不起表（避免无用定时器）
      currentStage = stage;
      stageStartedAt = now();
      write(formatSyncStageText(stage, 0));
      startTimer();
    },
    wait(kind: SyncWaitKind, index?: number, total?: number): void {
      if (ended) return;
      currentStage = null; // 等待态不显示秒数 → 停表（下一个阶段挂点显式设置新阶段）
      stopTimer();
      write(formatSyncWaitText(kind, index, total));
    },
    end(): void {
      if (ended) return; // 幂等：重复调用无额外写入
      ended = true;
      currentStage = null;
      stopTimer();
      write(undefined); // setStatus(key, undefined) = 删除该键
    },
  };
}
