import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createSyncProgress,
  formatSyncStageText,
  formatSyncWaitText,
  SYNC_PROGRESS_STATUS_KEY,
  type SyncStage,
  type SyncWaitKind,
} from "./progress";

// ── 夹具 ───────────────────────────────────────────────────

interface FakeUi {
  calls: { key: string; text: string | undefined }[];
  ui: { setStatus: (key: string, text: string | undefined) => void };
}

function fakeUi(impl?: (key: string, text: string | undefined) => void): FakeUi {
  const calls: FakeUi["calls"] = [];
  return {
    calls,
    ui: {
      setStatus: (key, text) => {
        calls.push({ key, text });
        impl?.(key, text);
      },
    },
  };
}

interface FakeTimers {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  activeCount: () => number;
  unrefCounts: number[];
  tick: () => void;
  intervalMs: number[];
}

function fakeTimers(options?: { unrefThrows?: boolean; clearThrows?: boolean }): FakeTimers {
  let nextId = 1;
  const active = new Map<number, { cb: () => void; id: number }>();
  const unrefCounts: number[] = [];
  const intervalMs: number[] = [];
  return {
    setInterval: ((cb: () => void, ms: number) => {
      const id = nextId++;
      active.set(id, { cb, id });
      intervalMs.push(ms);
      unrefCounts.push(0);
      const handle = {
        id,
        unref: () => {
          unrefCounts[id] = (unrefCounts[id] ?? 0) + 1;
          if (options?.unrefThrows) throw new Error("unref exploded");
        },
      };
      return handle;
    }) as unknown as FakeTimers["setInterval"],
    clearInterval: ((handle: unknown) => {
      if (options?.clearThrows) throw new Error("clearInterval exploded");
      const id = (handle as { id?: number } | undefined)?.id;
      if (typeof id === "number") active.delete(id);
    }) as unknown as FakeTimers["clearInterval"],
    activeCount: () => active.size,
    unrefCounts,
    tick: () => {
      for (const entry of [...active.values()]) entry.cb();
    },
    intervalMs,
  };
}

/** 注入时钟 + 注入定时器的进度实例（测试用；生产用默认实现）。 */
function makeProgress(
  ui: FakeUi["ui"] | undefined,
  options?: { now?: () => number; timers?: FakeTimers }
): { progress: ReturnType<typeof createSyncProgress>; timers: FakeTimers } {
  const timers = options?.timers ?? fakeTimers();
  const progress = createSyncProgress(ui as never, {
    now: options?.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  return { progress, timers };
}

const textOf = (fake: FakeUi, index = -1): string | undefined =>
  fake.calls.at(index)?.text as string | undefined;

// ── 验收 1：文案矩阵 ───────────────────────────────────────

describe("阶段 1 文案矩阵（§3.3 / §7.B）", () => {
  const stages: { stage: SyncStage; word: string }[] = [
    { stage: "prepare", word: "准备中…" },
    { stage: "connect", word: "连接云端…" },
    { stage: "fetch", word: "获取云端更新…" },
    { stage: "compare", word: "比对差异…" },
    { stage: "apply", word: "应用并推送…" },
    { stage: "checking", word: "正在检查云端状态…" },
  ];

  it("每个阶段的文本与关键词前置（关键词在截断时先保留）", () => {
    for (const { stage, word } of stages) {
      const text = formatSyncStageText(stage, 0);
      expect(text).toBe(`☁️ 云同步：${word}（0s）`);
      expect(text.startsWith("☁️ 云同步：")).toBe(true); // 关键词前置
    }
  });

  it("秒数格式化：0/1/59/120 秒（时间戳差值向下取整）", () => {
    const cases: [number, string][] = [
      [0, "（0s）"],
      [999, "（0s）"],
      [1_000, "（1s）"],
      [59_400, "（59s）"],
      [120_000, "（120s）"],
      [120_999, "（120s）"],
    ];
    for (const [elapsedMs, expected] of cases) {
      expect(formatSyncStageText("fetch", elapsedMs)).toContain(expected);
    }
  });

  it("秒数极端入参：NaN / Infinity / 负数一律兜底 0s（不显示 NaNs）", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -59_000]) {
      const text = formatSyncStageText("fetch", bad);
      expect(text).toBe("☁️ 云同步：获取云端更新…（0s）");
    }
  });

  it("决策态计数越界/非法一律退化为无计数形态（不显示自相矛盾进度）", () => {
    const base = "☁️ 云同步：⏸ 等待你的决策";
    expect(formatSyncWaitText("decision", 1, 3)).toBe(`${base}（1/3）`);
    expect(formatSyncWaitText("decision", 3, 3)).toBe(`${base}（3/3）`);
    for (const [index, total] of [
      [0, 3],
      [5, 3],
      [1, 0],
      [-1, 3],
      [1.5, 3],
      [1, 3.5],
      [Number.NaN, 3],
    ] as [number, number][]) {
      expect(formatSyncWaitText("decision", index, total)).toBe(base);
    }
  });

  it("等待态无秒数：确认 / 决策（含 i/n 计数）", () => {
    expect(formatSyncWaitText("confirm")).toBe("☁️ 云同步：⏸ 等待你的确认");
    expect(formatSyncWaitText("decision", 2, 3)).toBe("☁️ 云同步：⏸ 等待你的决策（2/3）");
    // 计数缺失时退化为无计数形态（不显示 `（undefined/undefined）`）
    expect(formatSyncWaitText("decision")).toBe("☁️ 云同步：⏸ 等待你的决策");
    for (const text of [
      formatSyncWaitText("confirm"),
      formatSyncWaitText("decision", 1, 2),
      formatSyncWaitText("decision"),
    ]) {
      expect(text).not.toMatch(/\d+s/); // 任何等待态都不得含秒数
    }
  });

  it("全部 6 个阶段与 2 种等待态都被登记（防漏词表项）", () => {
    expect(stages.map((s) => s.stage)).toEqual([
      "prepare",
      "connect",
      "fetch",
      "compare",
      "apply",
      "checking",
    ]);
    const kinds: SyncWaitKind[] = ["confirm", "decision"];
    for (const kind of kinds) {
      expect(formatSyncWaitText(kind)).toContain("☁️ 云同步");
    }
  });
});

// ── 验收 2：生命周期与幂等 ─────────────────────────────────

describe("阶段 1 生命周期（§3.6 出口闭合）", () => {
  it("stage()/wait() 各产生一次非空 setStatus，键名为 cloud-sync", () => {
    const fake = fakeUi();
    const { progress } = makeProgress(fake.ui);

    progress.stage("prepare");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].key).toBe(SYNC_PROGRESS_STATUS_KEY);
    expect(SYNC_PROGRESS_STATUS_KEY).toBe("cloud-sync");
    expect(fake.calls[0].text).toBe("☁️ 云同步：准备中…（0s）");

    progress.wait("confirm");
    expect(fake.calls).toHaveLength(2);
    expect(textOf(fake)).toBe("☁️ 云同步：⏸ 等待你的确认");

    progress.stage("apply");
    expect(textOf(fake)).toContain("应用并推送…");

    progress.wait("decision", 2, 3);
    expect(textOf(fake)).toBe("☁️ 云同步：⏸ 等待你的决策（2/3）");
  });

  it("end() 写入空值（清除）；重复调用幂等（无额外写入）", () => {
    const fake = fakeUi();
    const { progress, timers } = makeProgress(fake.ui);
    progress.stage("fetch");
    const before = fake.calls.length;

    progress.end();
    expect(fake.calls).toHaveLength(before + 1);
    expect(fake.calls.at(-1)).toEqual({ key: SYNC_PROGRESS_STATUS_KEY, text: undefined });

    const afterFirstEnd = fake.calls.length;
    progress.end();
    progress.end();
    expect(fake.calls).toHaveLength(afterFirstEnd); // 幂等：无额外写入
    expect(timers.activeCount()).toBe(0);
  });

  it("end() 之后的 stage()/wait() 为 no-op（不留残影、不重启计时器）", () => {
    const fake = fakeUi();
    const { progress, timers } = makeProgress(fake.ui);
    progress.stage("compare");
    progress.end();
    const callsAfterEnd = fake.calls.length;

    progress.stage("apply");
    progress.wait("decision", 1, 2);
    expect(fake.calls).toHaveLength(callsAfterEnd);
    expect(timers.activeCount()).toBe(0);
  });
});

// ── 验收 3：定时器纪律与秒数推进 ───────────────────────────

describe("阶段 1 定时器纪律（§3.5）", () => {
  it("活动阶段启动 1 秒定时器并 unref；等待态停表；end 后活动定时器为 0", () => {
    const fake = fakeUi();
    const { progress, timers } = makeProgress(fake.ui);

    progress.stage("fetch");
    expect(timers.intervalMs).toEqual([1000]);
    expect(timers.activeCount()).toBe(1);
    expect(timers.unrefCounts[1]).toBe(1); // 定时器 1 被 unref

    // 重复进入同一阶段不重复起表（避免定时器堆积）
    progress.stage("fetch");
    expect(timers.intervalMs).toHaveLength(1);

    progress.wait("confirm");
    expect(timers.activeCount()).toBe(0); // 等待态停表（不显示秒数）

    progress.stage("apply");
    expect(timers.activeCount()).toBe(1); // 新阶段重新起表
    expect(timers.unrefCounts[2]).toBe(1);

    progress.end();
    expect(timers.activeCount()).toBe(0);
  });

  it("秒数按时间戳差值计算（注入时钟推进后文本随之变化，非累加计数）", () => {
    const fake = fakeUi();
    let now = 1_000_000;
    const { progress, timers } = makeProgress(fake.ui, { now: () => now });

    progress.stage("connect");
    expect(textOf(fake)).toBe("☁️ 云同步：连接云端…（0s）");

    now += 1_500;
    timers.tick();
    expect(textOf(fake)).toBe("☁️ 云同步：连接云端…（1s）");

    now += 58_000;
    timers.tick();
    expect(textOf(fake)).toBe("☁️ 云同步：连接云端…（59s）");

    // 事件循环被阻塞 3 秒：一次 tick 直接跳到真实差值（不是 +1）
    now += 60_000;
    timers.tick();
    expect(textOf(fake)).toBe("☁️ 云同步：连接云端…（119s）");

    // 进入新阶段：从 0 重新计
    progress.stage("apply");
    expect(textOf(fake)).toBe("☁️ 云同步：应用并推送…（0s）");
    expect(timers.activeCount()).toBe(1);
  });

  it("setInterval 抛错：stage() 不抛错、状态仍写入、无句柄残留", () => {
    const fake = fakeUi();
    const timers = fakeTimers();
    const progress = createSyncProgress(fake.ui as never, {
      now: () => 0,
      setInterval: () => {
        throw new Error("setInterval exploded");
      },
      clearInterval: timers.clearInterval,
    });
    expect(() => progress.stage("fetch")).not.toThrow();
    expect(fake.calls).toHaveLength(1); // 进度可见（只是不刷新秒数）
    expect(fake.calls[0].text).toContain("获取云端更新…（0s）");
    expect(() => progress.end()).not.toThrow();
    // 后续阶段仍可尝试（无句柄 → 每次重新尝试起表）
    expect(() => progress.stage("apply")).not.toThrow();
  });

  it("unref 抛错：句柄已登记 → end() 仍能清理（活动定时器归 0，不留未 unref 的 interval）", () => {
    const fake = fakeUi();
    const timers = fakeTimers({ unrefThrows: true });
    const { progress } = makeProgress(fake.ui, { timers });

    expect(() => progress.stage("fetch")).not.toThrow();
    expect(timers.activeCount()).toBe(1); // 定时器确实创建了
    expect(timers.unrefCounts[1]).toBe(1); // unref 被调用过（虽然抛错）

    expect(() => progress.end()).not.toThrow();
    expect(timers.activeCount()).toBe(0); // 回归：句柄先登记，故仍可被清理
  });

  it("clearInterval 抛错：end() 不抛错，且此后 tick 不再写状态（不回填残影）", () => {
    const fake = fakeUi();
    const timers = fakeTimers({ clearThrows: true });
    const { progress } = makeProgress(fake.ui, { timers });
    progress.stage("fetch");
    const callsBeforeEnd = fake.calls.length;

    expect(() => progress.end()).not.toThrow();
    expect(fake.calls.at(-1)).toEqual({ key: SYNC_PROGRESS_STATUS_KEY, text: undefined });

    timers.tick(); // 假定时器仍在（clear 失败），但内部已 ended/无阶段 → 不得再写
    expect(fake.calls).toHaveLength(callsBeforeEnd + 1);
  });

  it("定时器回调内的 UI 抛错不会外泄（fail-open）", () => {
    let shouldThrow = false;
    const fake = fakeUi(() => {
      if (shouldThrow) throw new Error("ui exploded");
    });
    let now = 0;
    const { progress, timers } = makeProgress(fake.ui, { now: () => now });
    progress.stage("fetch");
    shouldThrow = true;
    now += 1000;
    expect(() => timers.tick()).not.toThrow();
  });
});

// ── 验收 4：fail-open ─────────────────────────────────────

describe("阶段 1 fail-open（§3.7 UI 不可用）", () => {
  it("setStatus 抛错时 stage/wait/end 均不抛错", () => {
    const ui = {
      setStatus: vi.fn(() => {
        throw new Error("ui exploded");
      }),
    };
    const timers = fakeTimers();
    const progress = createSyncProgress(ui as never, {
      now: () => 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    expect(() => progress.stage("prepare")).not.toThrow();
    expect(() => progress.wait("confirm")).not.toThrow();
    expect(() => progress.end()).not.toThrow();
    expect(ui.setStatus).toHaveBeenCalledTimes(3); // 三次调用都尝试过
    expect(timers.activeCount()).toBe(0);
  });

  it("ui 缺失 / setStatus 非函数时 stage() 短路：不写状态、不起表（无无用定时器）", () => {
    for (const ui of [undefined, {}, { setStatus: null }, { setStatus: "nope" }]) {
      const timers = fakeTimers();
      const progress = createSyncProgress(ui as never, {
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
      });
      expect(() => progress.stage("fetch")).not.toThrow();
      // 语义断言（在 wait/end 之前）：无可用状态栏出口 → 根本不创建定时器
      expect(timers.activeCount()).toBe(0);
      expect(timers.intervalMs).toHaveLength(0);
      expect(() => progress.wait("decision", 1, 1)).not.toThrow();
      expect(() => progress.end()).not.toThrow();
      expect(timers.activeCount()).toBe(0);
    }
  });

  it("有可用 setStatus 时 stage() 才起表（与无 UI 短路形成对照）", () => {
    const fake = fakeUi();
    const { progress, timers } = makeProgress(fake.ui);
    progress.stage("fetch");
    expect(timers.intervalMs).toEqual([1000]);
    expect(fake.calls).toHaveLength(1);
  });
});

// ── 验收 5：模块零 notify（静态断言）+ 纪律 ───────────────

describe("阶段 1 实现纪律（静态断言）", () => {
  const source = readFileSync(new URL("./progress.ts", import.meta.url), "utf-8");

  it("模块不含任何 notify 调用（进度只允许走状态栏）", () => {
    expect(source).not.toMatch(/notify/);
  });

  it("模块不产生聊天区输出原语（无 console 输出、无 sendMessage）", () => {
    expect(source).not.toMatch(/console\.(log|info|warn|error)/);
    expect(source).not.toMatch(/sendMessage/);
  });

  it("状态栏键名唯一且在模块内单点定义", () => {
    expect(source.match(/"cloud-sync"/g)?.length).toBe(1);
  });
});
