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
  batchMaxWaitMinutes: 15,
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

  it("resolves { ok: false, error } with the RPC's own error when the member reports failure — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, { type: "response", command: "compact", success: false, error: "boom" });

    const result = await rt.compactNow("worker", handle, enabledCfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("boom");
    }
  });

  it("resolves { ok: false, error } with the real reason when the compact RPC rejects (timeout) — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("Command to \"worker\" timed out after 600000ms"));

    const result = await rt.compactNow("worker", handle, enabledCfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Command to \"worker\" timed out after 600000ms");
    }
  });

  it("resolves { ok: false } with a generic reason when no response arrives — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, undefined);

    await expect(rt.compactNow("worker", handle, enabledCfg)).resolves.toEqual({
      ok: false,
      error: "压缩命令未成功",
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
