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

function usageResponse(percent: number, tokens: number): any {
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
      percent: 92,
      tokens: 184000,
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

  it("resolves null when the stats query rejects (timeout) — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("timed out"));

    await expect(rt.queryStats("worker", handle)).resolves.toBeNull();
  });

  it("resolves null when response has no contextUsage — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle({ type: "response", command: "get_session_stats", success: true, data: {} });

    await expect(rt.queryStats("worker", handle)).resolves.toBeNull();
  });

  it("resolves null when usage.percent is not a number — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle({
      type: "response",
      command: "get_session_stats",
      success: true,
      data: { contextUsage: { percent: "92", tokens: 1000 } },
    });

    await expect(rt.queryStats("worker", handle)).resolves.toBeNull();
  });

  it("treats missing tokens as 0", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(usageResponse(92, undefined));

    await expect(rt.queryStats("worker", handle)).resolves.toEqual({ percent: 92, tokens: 0 });
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

  it("beginCompaction does not disturb non-idle states", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "working"]]);
    const rt = makeRuntime(states);

    rt.beginCompaction("worker");

    expect(states.get("worker")).toBe("working");
  });

  it("endCompaction resets compacting → idle (finally reset)", async () => {
    const states = new Map<string, MemberOperationalState>([["worker", "compacting"]]);
    const rt = makeRuntime(states);

    rt.endCompaction("worker");

    expect(states.get("worker")).toBe("idle");
  });

  it("endCompaction is a no-op on non-compacting states", async () => {
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
  it("resolves true when compaction succeeds", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, { type: "response", command: "compact", success: true, data: {} });

    await expect(rt.compactNow("worker", handle, enabledCfg)).resolves.toBe(true);
  });

  it("resolves false when the member reports compaction failure — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, { type: "response", command: "compact", success: false, error: "boom" });

    await expect(rt.compactNow("worker", handle, enabledCfg)).resolves.toBe(false);
  });

  it("resolves false when the compact RPC rejects (timeout) — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle() as unknown as MemberProcessHandle;
    handle.sendCommandAndWait = vi.fn().mockRejectedValue(new Error("timed out"));

    await expect(rt.compactNow("worker", handle, enabledCfg)).resolves.toBe(false);
  });

  it("resolves false when no response arrives — fail-open", async () => {
    const rt = makeRuntime();
    const handle = makeHandle(undefined, undefined);

    await expect(rt.compactNow("worker", handle, enabledCfg)).resolves.toBe(false);
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
  it("queues messages and flushes them in FIFO order (backlog before new arrivals)", async () => {
    const rt = makeRuntime();
    const msg1 = makeMsg("msg-1");
    const msg2 = makeMsg("msg-2");
    const msg3 = makeMsg("msg-3");

    expect(rt.queueDuringCompaction("worker", msg1)).toBe(true);
    expect(rt.queueDuringCompaction("worker", msg2)).toBe(true);
    expect(rt.queueDuringCompaction("worker", msg3)).toBe(true);

    const flushed = rt.flushPending("worker");
    expect(flushed).toEqual([msg1, msg2, msg3]);
  });

  it("flushPending clears the queue — a second flush returns nothing", async () => {
    const rt = makeRuntime();
    rt.queueDuringCompaction("worker", makeMsg("msg-1"));

    expect(rt.flushPending("worker")).toHaveLength(1);
    expect(rt.flushPending("worker")).toEqual([]);
  });

  it("flushPending returns [] when nothing was queued", async () => {
    const rt = makeRuntime();
    expect(rt.flushPending("worker")).toEqual([]);
  });

  it("keeps per-member queues independent", async () => {
    const rt = makeRuntime();
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
