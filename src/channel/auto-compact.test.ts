import { describe, it, expect, vi } from "vitest";
import type { MemberOperationalState } from "../session/context";
import type { MemberProcessHandle } from "../process/member-process";
import type { ResolvedAutoCompact } from "../settings/resolve-auto-compact";
import { createAutoCompactRuntime } from "./auto-compact";

// ── Test helpers ────────────────────────────────────────────

const enabledCfg: ResolvedAutoCompact = {
  enabled: true,
  thresholdPercent: 80,
  thresholdTokens: undefined,
  timeoutMinutes: 10,
  percentIsDefaultFallback: false,
};

function makeHandle(
  statsResponse?: any,
  compactResponse?: any
): MemberProcessHandle {
  return {
    name: "worker",
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(),
    onEvent: vi.fn(),
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn().mockImplementation((cmd: any) => {
      if (cmd.type === "get_session_stats") return Promise.resolve(statsResponse);
      if (cmd.type === "compact") return Promise.resolve(compactResponse);
      return Promise.reject(new Error("unexpected command"));
    }),
  } as unknown as MemberProcessHandle;
}

function usageResponse(percent: number, tokens?: number): any {
  return {
    type: "response",
    command: "get_session_stats",
    success: true,
    data: { contextUsage: { percent, tokens, contextWindow: 200000 } },
  };
}

function makeMsg(id = "msg-1") {
  return { id, from: "tl", to: "worker", content: "Do work", timestamp: Date.now() };
}

function makeRuntime(states?: Map<string, MemberOperationalState>) {
  return createAutoCompactRuntime(states ?? new Map<string, MemberOperationalState>());
}

// ── queryStats ─────────────────────────────────────────────

describe("auto-compact runtime queryStats", () => {
  it("resolves usage snapshot on success", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(usageResponse(92, 184000));

    await expect(rt.queryStats("worker", handle)).resolves.toEqual({
      ok: true,
      stats: { percent: 92, tokens: 184000 },
    });
  });

  it("queries get_session_stats with 3s timeout", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(usageResponse(50, 100000));
    handle.sendCommandAndWait = vi.fn().mockResolvedValue(usageResponse(50, 100000));

    await rt.queryStats("worker", handle);

    expect(handle.sendCommandAndWait).toHaveBeenCalledWith(
      { type: "get_session_stats" },
      expect.any(Function),
      3000
    );
  });

  it("resolves { ok: false, error } with the REAL reason when the stats query rejects (timeout) — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("Command to \"worker\" timed out after 3000ms"));

    const result = await rt.queryStats("worker", handle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Command to \"worker\" timed out after 3000ms");
    }
  });

  it("resolves { ok: false } when response has no contextUsage — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle({ type: "response", command: "get_session_stats", success: true, data: {} });

    const result = await rt.queryStats("worker", handle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("成员未返回上下文用量数据");
    }
  });

  it("resolves { ok: false } when usage.percent is not a number — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle({
      type: "response",
      command: "get_session_stats",
      success: true,
      data: { contextUsage: { percent: "92", tokens: 1000 } },
    });

    await expect(rt.queryStats("worker", handle)).resolves.toEqual({
      ok: false,
      error: "成员未返回上下文用量数据",
    });
  });

  it("treats percent:null as a LEGAL post-compaction 'unknown' — ok:true with percent 0 (silent skip)", async () => {
    // pi 上游 getContextUsage() 在「最新压缩条目之后无有效 assistant 回复」时
    // 刻意返回 { tokens: null, contextWindow, percent: null }（合法确定性状态，
    // 非 RPC 失败）——语义化为「已知低」静默跳过，不得进失败分支触发误导性通知。
    const rt = makeRuntime();
    const handle = makeHandle({
      type: "response",
      command: "get_session_stats",
      success: true,
      data: { contextUsage: { tokens: null, contextWindow: 200000, percent: null } },
    });

    await expect(rt.queryStats("worker", handle)).resolves.toEqual({
      ok: true,
      stats: { percent: 0, tokens: 0 },
    });
    // percent 0 < 任何阈值 → 压缩决策与现状一致（跳过），仅去通知噪音。
    expect(rt.shouldCompact({ percent: 0, tokens: 0 }, enabledCfg)).toBe(false);
  });

  it("resolves { ok: false } when contextUsage is undefined (no model / no contextWindow) — genuine anomaly, notify path unchanged", async () => {
    const rt = makeRuntime();
    const handle = makeHandle({
      type: "response",
      command: "get_session_stats",
      success: true,
      data: { contextUsage: undefined },
    });

    await expect(rt.queryStats("worker", handle)).resolves.toEqual({
      ok: false,
      error: "成员未返回上下文用量数据",
    });
  });

  it("resolves { ok: false } when percent is undefined — only null is the legal unknown (lock: no widening)", async () => {
    // 1.1 仅放宽 `=== null`：undefined / 其他非 number 形态仍是真异常（锁定回归）。
    const rt = makeRuntime();
    const handle = makeHandle({
      type: "response",
      command: "get_session_stats",
      success: true,
      data: { contextUsage: { percent: undefined, tokens: 1000 } },
    });

    await expect(rt.queryStats("worker", handle)).resolves.toEqual({
      ok: false,
      error: "成员未返回上下文用量数据",
    });
  });

  it("treats missing tokens as 0", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(usageResponse(92));

    await expect(rt.queryStats("worker", handle)).resolves.toEqual({
      ok: true,
      stats: { percent: 92, tokens: 0 },
    });
  });
});

// ── shouldCompact ──────────────────────────────────────────

describe("auto-compact runtime shouldCompact", () => {
  it("returns true when percent meets the threshold (OR semantics)", async () => {
    const rt = makeRuntime();
    expect(rt.shouldCompact({ percent: 80, tokens: 0 }, enabledCfg)).toBe(true);
  });

  it("returns true when tokens meet the token threshold", async () => {
    const rt = makeRuntime();
    const cfg: ResolvedAutoCompact = { ...enabledCfg, thresholdTokens: 150000 };
    expect(rt.shouldCompact({ percent: 10, tokens: 150000 }, cfg)).toBe(true);
  });

  it("returns false when neither threshold is met", async () => {
    const rt = makeRuntime();
    expect(rt.shouldCompact({ percent: 50, tokens: 100000 }, enabledCfg)).toBe(false);
  });

  it("returns false when auto-compaction is disabled", async () => {
    const rt = makeRuntime();
    expect(rt.shouldCompact({ percent: 95, tokens: 999999 }, { ...enabledCfg, enabled: false })).toBe(false);
  });
});

// ── beginCompaction / endCompaction (state transitions) ────

describe("auto-compact runtime begin/endCompaction", () => {
  it("beginCompaction sets idle → compacting synchronously (before any await)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "idle"]]);
    const rt = makeRuntime(states);

    rt.beginCompaction("worker");

    expect(states.get("worker")).toBe("compacting");
  });

  it("beginCompaction does not disturb non-idle states (working)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "working"]]);
    const rt = makeRuntime(states);

    rt.beginCompaction("worker");

    expect(states.get("worker")).toBe("working");
  });

  it("beginCompaction does not disturb non-idle states (crashed)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "crashed"]]);
    const rt = makeRuntime(states);

    rt.beginCompaction("worker");

    expect(states.get("worker")).toBe("crashed");
  });

  it("endCompaction resets compacting → idle (finally reset)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);

    rt.endCompaction("worker");

    expect(states.get("worker")).toBe("idle");
  });

  it("endCompaction preserves crashed when the member died mid-compaction", async () => {
    // E7 scenario: the member process crashed while compacting (process_exit
    // already moved the state to crashed); the compact RPC only rejects at
    // timeout, and the finally must NOT wipe crashed back to idle — a crashed
    // member must stay crashed until explicitly restarted.
    const states = new Map<string, MemberOperationalState>([["worker", "crashed"]]);
    const rt = makeRuntime(states);

    rt.endCompaction("worker");

    expect(states.get("worker")).toBe("crashed");
  });

  it("endCompaction preserves stopped", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "stopped"]]);
    const rt = makeRuntime(states);

    rt.endCompaction("worker");

    expect(states.get("worker")).toBe("stopped");
  });

  it("endCompaction is a no-op on non-compacting states (idle)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "idle"]]);
    const rt = makeRuntime(states);

    rt.endCompaction("worker");

    expect(states.get("worker")).toBe("idle");
  });

  it("treats a member with no recorded state as idle for begin/end", async () => {
    const states = new Map<string, MemberOperationalState>();
    const rt = makeRuntime(states);

    rt.beginCompaction("worker");
    expect(states.get("worker")).toBe("compacting");

    rt.endCompaction("worker");
    expect(states.get("worker")).toBe("idle");
  });
});

// ── compactNow ─────────────────────────────────────────────

describe("auto-compact runtime compactNow", () => {
  it("resolves { ok: true } when compaction succeeds", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, { type: "response", command: "compact", success: true, data: {} });

    await expect(rt.compactNow("worker", handle, enabledCfg)).resolves.toEqual({ ok: true });
  });

  it("resolves { ok: false, error, timedOut: false } with the RPC's own error when the member reports failure — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, { type: "response", command: "compact", success: false, error: "boom" });

    const result = await rt.compactNow("worker", handle, enabledCfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("boom");
      // Member-side compaction already settled — safe to dispatch.
      expect(result.timedOut).toBe(false);
    }
  });

  it("resolves { ok: false, error, timedOut: true } when the compact RPC rejects (lease timeout) — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("Command to \"worker\" timed out after 600000ms"));

    const result = await rt.compactNow("worker", handle, enabledCfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Command to \"worker\" timed out after 600000ms");
      // Phase 2: the timeout is a lease expiry — the member-side compaction
      // may STILL be running (the caller must NOT dispatch into it).
      expect(result.timedOut).toBe(true);
    }
  });

  it("resolves { ok: false, timedOut: false } with a generic reason when no response arrives — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, undefined);

    await expect(rt.compactNow("worker", handle, enabledCfg)).resolves.toEqual({
      ok: false,
      error: "压缩命令未成功",
      timedOut: false,
    });
  });

  it("waits cfg.timeoutMinutes for the compact RPC", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, { type: "response", command: "compact", success: true });
    handle.sendCommandAndWait = vi.fn().mockResolvedValue({ type: "response", command: "compact", success: true });

    await rt.compactNow("worker", handle, enabledCfg);

    expect(handle.sendCommandAndWait).toHaveBeenCalledWith(
      { type: "compact" },
      expect.any(Function),
      enabledCfg.timeoutMinutes * 60_000
    );
  });
});

// ── queueDuringCompaction / flushPending ───────────────────

describe("auto-compact runtime queueDuringCompaction + flushPending", () => {
  function compactingRuntime(name = "worker") {
    const states = new Map<string, MemberOperationalState>([[name, "idle"]]);
    const rt = makeRuntime(states);
    rt.beginCompaction(name);
    return rt;
  }

  it("queues messages while compacting and flushes them in FIFO order (backlog before new arrivals)", async () => {
    const rt = compactingRuntime();
    const msg1 = makeMsg("msg-1");
    const msg2 = makeMsg("msg-2");
    const msg3 = makeMsg("msg-3");

    expect(rt.queueDuringCompaction("worker", msg1)).toBe(true);
    expect(rt.queueDuringCompaction("worker", msg2)).toBe(true);
    expect(rt.queueDuringCompaction("worker", msg3)).toBe(true);

    const flushed = rt.flushPending("worker");
    expect(flushed).toEqual([msg1, msg2, msg3]);
  });

  it("front option places the message at the HEAD (审查建议 2: stuck-compaction order — trigger A before B/C)", async () => {
    // B/C arrive while the compaction is running (queued FIFO). The trigger
    // message A then times out — its natural position is the HEAD: the
    // success path dispatches A first, then the pending FIFO. Without the
    // front option the flush would be B, C, A (order inversion).
    const rt = compactingRuntime();
    rt.queueDuringCompaction("worker", makeMsg("b"));
    rt.queueDuringCompaction("worker", makeMsg("c"));

    expect(rt.queueDuringCompaction("worker", makeMsg("a"), true)).toBe(true);

    expect(rt.flushPending("worker").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("front option keeps the normal FIFO when false (default: back of the queue)", async () => {
    const rt = compactingRuntime();
    rt.queueDuringCompaction("worker", makeMsg("a"), true); // A already at the head

    // New arrivals during the stuck compaction stay FIFO at the back.
    expect(rt.queueDuringCompaction("worker", makeMsg("b"))).toBe(true);
    expect(rt.queueDuringCompaction("worker", makeMsg("c"), false)).toBe(true);

    expect(rt.flushPending("worker").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("returns false and does NOT queue when the member is not compacting", async () => {
    // Defensive invariant: queuing on a non-compacting member would orphan
    // the message — nothing would ever flush it.
    const rt = makeRuntime(new Map<string, MemberOperationalState>([["worker", "idle"]]));

    expect(rt.queueDuringCompaction("worker", makeMsg("msg-1"))).toBe(false);
    expect(rt.flushPending("worker")).toEqual([]);
  });

  it("flushPending clears the queue — a second flush returns nothing", async () => {
    const rt = compactingRuntime();
    rt.queueDuringCompaction("worker", makeMsg("msg-1"));

    expect(rt.flushPending("worker")).toHaveLength(1);
    expect(rt.flushPending("worker")).toEqual([]);
  });

  it("flushPending returns [] when nothing was queued", async () => {
    const rt = makeRuntime();
    expect(rt.flushPending("worker")).toEqual([]);
  });

  it("keeps per-member queues independent", async () => {
    const states = new Map<string, MemberOperationalState>([
      ["a", "idle"],
      ["b", "idle"],
    ]);
    const rt = makeRuntime(states);
    rt.beginCompaction("a");
    rt.beginCompaction("b");

    rt.queueDuringCompaction("a", makeMsg("a-1"));
    rt.queueDuringCompaction("b", makeMsg("b-1"));
    rt.queueDuringCompaction("a", makeMsg("a-2"));

    expect(rt.flushPending("a").map((m) => m.id)).toEqual(["a-1", "a-2"]);
    expect(rt.flushPending("b").map((m) => m.id)).toEqual(["b-1"]);
  });

  it("endCompaction resets state but does NOT flush — flush stays a separate step", async () => {
    // Contract locked by the inline dispatch order [current msg → pending]:
    // the caller resets state, dispatches the current message, then flushes.
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);
    const msg = makeMsg("pending-1");
    rt.queueDuringCompaction("worker", msg);

    rt.endCompaction("worker");

    expect(states.get("worker")).toBe("idle");
    expect(rt.flushPending("worker")).toEqual([msg]);
  });
});

// ── queryCompactionState (Phase 1) ────────────────────────
// The prompt-rejection branch asks the member (get_state.isCompacting)
// instead of guessing — this query powers that correction.

describe("auto-compact runtime queryCompactionState", () => {
  function getStateResponse(isCompacting: boolean): any {
    return {
      type: "response",
      command: "get_state",
      success: true,
      data: { isCompacting },
    };
  }

  it("resolves true when get_state reports isCompacting=true", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockResolvedValue(getStateResponse(true));

    await expect(rt.queryCompactionState("worker", handle)).resolves.toBe(true);

    // Same 3s timeout pattern as the stats query (fail-open).
    expect(handle.sendCommandAndWait).toHaveBeenCalledWith(
      { type: "get_state" },
      expect.any(Function),
      3000
    );
  });

  it("resolves false when get_state reports isCompacting=false", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockResolvedValue(getStateResponse(false));

    await expect(rt.queryCompactionState("worker", handle)).resolves.toBe(false);
  });

  it("resolves null on RPC failure (fail-open — caller picks the conservative branch)", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("Command to \"worker\" timed out after 3000ms"));

    await expect(rt.queryCompactionState("worker", handle)).resolves.toBeNull();
  });

  it("resolves null when the member reports a failed get_state", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockResolvedValue({
      type: "response",
      command: "get_state",
      success: false,
      error: "boom",
    });

    await expect(rt.queryCompactionState("worker", handle)).resolves.toBeNull();
  });

  it("resolves null when isCompacting is not a boolean", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockResolvedValue({
      type: "response",
      command: "get_state",
      success: true,
      data: { isCompacting: "yes" },
    });

    await expect(rt.queryCompactionState("worker", handle)).resolves.toBeNull();
  });
});

// ── compaction timeout marks (Phase 1) ────────────────────
// "租约 vs 心跳": a compactNow timeout (local lease) says NOTHING about the
// member-side compaction — it may still be running. The mark bridges the
// gap: compaction_end (the heartbeat) checks it to notify the TL that the
// member-side compaction actually finished.

describe("auto-compact runtime compaction timeout marks", () => {
  it("compactNow timeout records a mark (lease expired — member-side compaction may still run)", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(
      new Error('Command to "worker" timed out after 600000ms')
    );

    const result = await rt.compactNow("worker", handle, enabledCfg);
    expect(result.ok).toBe(false);

    // The mark was recorded with a timestamp …
    expect(rt.takeCompactionTimeout("worker")).toEqual(expect.any(Number));
    // … and consumed exactly once (no re-notification on a later event).
    expect(rt.takeCompactionTimeout("worker")).toBeUndefined();
  });

  it("compactNow non-timeout RPC failure records NO mark", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("RPC connection lost"));

    await rt.compactNow("worker", handle, enabledCfg);

    expect(rt.takeCompactionTimeout("worker")).toBeUndefined();
  });

  it("compactNow RPC failure response (member-side compaction already ended) records NO mark", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, {
      type: "response",
      command: "compact",
      success: false,
      error: "compaction failed",
    });

    await rt.compactNow("worker", handle, enabledCfg);

    expect(rt.takeCompactionTimeout("worker")).toBeUndefined();
  });

  it("takeCompactionTimeout returns undefined when nothing was recorded", async () => {
    const rt = makeRuntime();
    expect(rt.takeCompactionTimeout("worker")).toBeUndefined();
  });
});

// ── in-flight lease tracking (review fix) ──────────────────
// Upstream ordering fact: the member emits compaction_end BEFORE it writes
// the compact response (agent-session.js emits, rpc-mode.js writes the
// response afterwards). The compaction_end branch must therefore defer to
// the lease-owning flow while compactNow is in flight — this tracking
// powers that guard.

describe("auto-compact runtime in-flight lease tracking", () => {
  it("hasInFlightCompaction is true while compactNow runs and false after settle", async () => {
    const rt = makeRuntime();
    let resolveCompact!: (v: any) => void;
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockReturnValue(
      new Promise((r) => { resolveCompact = r; })
    );

    const p = rt.compactNow("worker", handle, enabledCfg);
    expect(rt.hasInFlightCompaction("worker")).toBe(true);

    resolveCompact!({ type: "response", command: "compact", success: true, data: {} });
    await p;
    expect(rt.hasInFlightCompaction("worker")).toBe(false);
  });

  it("hasInFlightCompaction clears on rejection settle too", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("RPC connection lost"));

    await rt.compactNow("worker", handle, enabledCfg);

    expect(rt.hasInFlightCompaction("worker")).toBe(false);
  });

  it("hasInFlightCompaction is false when no lease is running", async () => {
    const rt = makeRuntime();
    expect(rt.hasInFlightCompaction("worker")).toBe(false);
  });

  it("near-miss: a compaction_end observed during the lease suppresses the stale timeout mark", async () => {
    // The heartbeat (compaction_end) arrived while the lease was in flight —
    // the compaction actually FINISHED and the response is merely delayed
    // (large summary). The lease timeout must NOT record a mark: a lingering
    // mark would mis-fire on the NEXT compaction's compaction_end with a
    // stale timestamp (false 「压缩已于 N 分钟后结束」 notification).
    const rt = makeRuntime();
    let rejectCompact!: (e: Error) => void;
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockReturnValue(
      new Promise((_, rej) => { rejectCompact = rej; })
    );

    const p = rt.compactNow("worker", handle, enabledCfg);
    rt.markCompactionEnd("worker"); // heartbeat processed by the branch while the lease is in flight
    rejectCompact!(new Error('Command to "worker" timed out after 600000ms'));

    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      // 建议 3: the heartbeat proves the compaction SETTLED — the caller
      // closes the lifecycle and dispatches immediately (no queue/watcher).
      expect(result.settledByHeartbeat).toBe(true);
    }
    expect(rt.takeCompactionTimeout("worker")).toBeUndefined();
  });

  it("non-near-miss timeout: settledByHeartbeat stays undefined (lease expired, no heartbeat)", async () => {
    const rt = makeRuntime();
    let rejectCompact!: (e: Error) => void;
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockReturnValue(
      new Promise((_, rej) => { rejectCompact = rej; })
    );

    const p = rt.compactNow("worker", handle, enabledCfg);
    rejectCompact!(new Error('Command to "worker" timed out after 600000ms'));

    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.settledByHeartbeat).toBeUndefined();
    }
  });
});

// ── compaction_end heartbeat count (Phase 2: barrier attempted 语义) ──
// The barrier marks a member attempted only when its compaction SETTLED via
// a compact response OR a compaction_end event. The count distinguishes
// "event processed during the barrier" from "still running".

describe("auto-compact runtime compaction_end heartbeat count", () => {
  it("markCompactionEnd increments the per-member count", async () => {
    const rt = makeRuntime();
    expect(rt.getCompactionEndCount("worker")).toBe(0);
    rt.markCompactionEnd("worker");
    rt.markCompactionEnd("worker");
    expect(rt.getCompactionEndCount("worker")).toBe(2);
  });

  it("counts are per-member", async () => {
    const rt = makeRuntime();
    rt.markCompactionEnd("a");
    expect(rt.getCompactionEndCount("a")).toBe(1);
    expect(rt.getCompactionEndCount("b")).toBe(0);
  });
});

// ── waitCompactionIdle (Phase 2: 三出口之② 轮询兜底) ──────
// The compaction_end event is the PRIMARY exit for a lease-expired
// compaction; waitCompactionIdle is the fallback for event loss (pipe /
// network) and auto-restart (events not replayed): every 30s poll
// get_state.isCompacting (fail-open → treat as ended), bounded by the
// secondary budget. On release the caller closes the lifecycle and flushes;
// on budget exhaustion the caller abandons + resolves + notifies.

describe("auto-compact runtime waitCompactionIdle", () => {
  const POLL = 30_000;

  function getStateResponse(isCompacting: boolean): any {
    return { type: "response", command: "get_state", success: true, data: { isCompacting } };
  }

  it("releases when the member's operational state leaves compacting (process exit) — zero RPC", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn();

    vi.useFakeTimers();
    try {
      const p = rt.waitCompactionIdle("worker", handle, 60_000);
      states.set("worker", "crashed"); // process_exit already handled pending (2.3)
      await vi.advanceTimersByTimeAsync(POLL);
      await expect(p).resolves.toEqual({ ok: true });
      expect(handle.sendCommandAndWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases when get_state reports isCompacting=false (event lost → poll fallback)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockResolvedValue(getStateResponse(false));

    vi.useFakeTimers();
    try {
      const p = rt.waitCompactionIdle("worker", handle, 60_000);
      await vi.advanceTimersByTimeAsync(POLL);
      await expect(p).resolves.toEqual({ ok: true });
      expect(handle.sendCommandAndWait).toHaveBeenCalledWith(
        { type: "get_state" },
        expect.any(Function),
        3000
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling every 30s while the compaction is still running", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);
    const handle = makeHandle() as unknown as MemberProcessHandle;
    let calls = 0;
    handle.sendCommandAndWait = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(getStateResponse(true));
    });

    vi.useFakeTimers();
    try {
      const p = rt.waitCompactionIdle("worker", handle, 90_000);
      await vi.advanceTimersByTimeAsync(POLL * 2);
      // 30s and 60s polls: two get_state queries, still running
      expect(calls).toBe(2);
      // release at 90s (third poll sees false)
      handle.sendCommandAndWait = vi.fn().mockResolvedValue(getStateResponse(false));
      await vi.advanceTimersByTimeAsync(POLL);
      await expect(p).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases on query failure (fail-open: treat as ended)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("timeout"));

    vi.useFakeTimers();
    try {
      const p = rt.waitCompactionIdle("worker", handle, 60_000);
      await vi.advanceTimersByTimeAsync(POLL);
      await expect(p).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves { ok: false } when the budget expires with the compaction still running (secondary timeout)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockResolvedValue(getStateResponse(true));

    vi.useFakeTimers();
    try {
      const p = rt.waitCompactionIdle("worker", handle, 90_000);
      // 30s + 60s polls say still running; the 90s poll checks the deadline
      await vi.advanceTimersByTimeAsync(POLL * 3 + 1);
      await expect(p).resolves.toEqual({ ok: false, error: expect.stringContaining("上限") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rearms the poll timer unref'd at every reschedule (审查建议 1: Esc 中断后不持有事件循环)", async () => {
    // The INITIAL timer was already unref'd; the rearm inside pollOnce must
    // be unref'd too — otherwise a stuck compaction abandoned by Esc holds
    // the extension process open until the budget expires.
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockResolvedValue(getStateResponse(true));

    vi.useFakeTimers();
    try {
      // Wrap the fake-clock setTimeout: record every timer's unref call.
      const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
      const unrefSpy = vi.fn();
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: any,
        ms?: any,
        ...args: any[]
      ) => {
        const t: any = originalSetTimeout(fn, ms, ...args);
        if (t && typeof t.unref === "function") t.unref = unrefSpy;
        return t;
      }) as any);

      const p = rt.waitCompactionIdle("worker", handle, 90_000);
      // Polls at 30s and 60s rearm (still running); the 90s poll checks the
      // deadline and settles WITHOUT rearming. Every scheduled timer — the
      // initial one plus both rearms — must be unref'd.
      await vi.advanceTimersByTimeAsync(POLL * 3 + 1);
      expect(unrefSpy).toHaveBeenCalledTimes(3);
      await expect(p).resolves.toEqual({ ok: false, error: expect.stringContaining("上限") });
    } finally {
      vi.useRealTimers();
    }
  });
});
