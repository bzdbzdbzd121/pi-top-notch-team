import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createResponseWaiter, extractCorrelationId } from "./response-waiter";

describe("createResponseWaiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── waitForResponse ─────────────────────────────────────

  it("resolves with response when correlation ID matches", async () => {
    const waiter = createResponseWaiter();
    const waitPromise = waiter.waitForResponse("req-abc", 60_000);

    const resolved = waiter.resolveIfWaiting("req-abc", "analyzer", "完成", undefined);
    expect(resolved).toBe(true);

    const result = await waitPromise;
    expect(result).toEqual({
      status: "response",
      from: "analyzer",
      content: "完成",
      subject: undefined,
    });
  });

  it("returns null on timeout", async () => {
    const waiter = createResponseWaiter();
    const waitPromise = waiter.waitForResponse("req-abc", 60_000);

    // Advance past timeout
    vi.advanceTimersByTime(60_001);

    const result = await waitPromise;
    expect(result).toEqual({
      status: "timeout",
      from: undefined,
      content: undefined,
      subject: undefined,
    });
  });

  it("supports multiple concurrent waits with different correlation IDs", async () => {
    const waiter = createResponseWaiter();
    const wait1 = waiter.waitForResponse("req-001", 60_000);
    const wait2 = waiter.waitForResponse("req-002", 60_000);

    waiter.resolveIfWaiting("req-001", "a", "done1", undefined);
    waiter.resolveIfWaiting("req-002", "b", "done2", undefined);

    expect(await wait1).toMatchObject({ status: "response", content: "done1" });
    expect(await wait2).toMatchObject({ status: "response", content: "done2" });
  });

  it("does not resolve unrelated correlation IDs", async () => {
    const waiter = createResponseWaiter();
    const waitPromise = waiter.waitForResponse("req-abc", 60_000);

    const resolved = waiter.resolveIfWaiting("req-xyz", "someone", "nope", undefined);
    expect(resolved).toBe(false);

    // Should still be waiting — advance timeout
    vi.advanceTimersByTime(60_001);
    const result = await waitPromise;
    expect(result.status).toBe("timeout");
  });

  it("uses default timeout of 120 seconds", async () => {
    const waiter = createResponseWaiter();
    const waitPromise = waiter.waitForResponse("req-abc");

    vi.advanceTimersByTime(120_001);
    const result = await waitPromise;
    expect(result.status).toBe("timeout");
  });

  it("max timeout is capped at 300 seconds", async () => {
    const waiter = createResponseWaiter();
    // pass a very large timeout; should be capped to 300s
    const waitPromise = waiter.waitForResponse("req-abc", 600_000);

    // Should timeout at ~300s, not 600s
    vi.advanceTimersByTime(300_001);
    const result = await waitPromise;
    expect(result.status).toBe("timeout");
  });

  it("can re-wait after timeout with same correlation ID", async () => {
    const waiter = createResponseWaiter();

    // First wait times out
    const wait1 = waiter.waitForResponse("req-abc", 10_000);
    vi.advanceTimersByTime(10_001);
    expect((await wait1).status).toBe("timeout");

    // Re-wait with same correlation ID
    const wait2 = waiter.waitForResponse("req-abc", 60_000);
    waiter.resolveIfWaiting("req-abc", "analyzer", "finally done", undefined);
    expect(await wait2).toMatchObject({ status: "response", content: "finally done" });
  });

  // ── resolveIfWaiting ─────────────────────────────────────

  it("resolveIfWaiting returns false when no waiters match", () => {
    const waiter = createResponseWaiter();
    expect(waiter.resolveIfWaiting("nonexistent", "anyone", "content", undefined)).toBe(false);
  });

  it("resolveIfWaiting only resolves the first matching waiter (one-shot)", async () => {
    const waiter = createResponseWaiter();
    const wait1 = waiter.waitForResponse("req-abc", 60_000);

    // First resolve
    waiter.resolveIfWaiting("req-abc", "a", "first", undefined);
    expect((await wait1).content).toBe("first");

    // Second resolve for same corrId should do nothing (no waiter active)
    expect(waiter.resolveIfWaiting("req-abc", "b", "second", undefined)).toBe(false);
  });

  // ── cancelAll ───────────────────────────────────────────

  it("cancelAll resolves all pending waits with cancelled status", async () => {
    const waiter = createResponseWaiter();
    const wait1 = waiter.waitForResponse("req-001", 60_000);
    const wait2 = waiter.waitForResponse("req-002", 60_000);

    waiter.cancelAll();

    expect(await wait1).toEqual({ status: "cancelled", from: undefined, content: undefined, subject: undefined });
    expect(await wait2).toEqual({ status: "cancelled", from: undefined, content: undefined, subject: undefined });
  });

  it("cancelAll is idempotent", () => {
    const waiter = createResponseWaiter();
    waiter.waitForResponse("req-abc", 60_000);
    waiter.cancelAll();
    // Calling again should not throw
    waiter.cancelAll();
  });
});

describe("extractCorrelationId", () => {
  it("extracts corr tag from content", () => {
    expect(extractCorrelationId("hello\n\n<corr:req-abc>")).toBe("req-abc");
  });

  it("extracts from middle of content", () => {
    expect(extractCorrelationId("prefix <corr:req-abc> suffix")).toBe("req-abc");
  });

  it("supports underscores and hyphens", () => {
    expect(extractCorrelationId("<corr:req_abc-xyz_123>")).toBe("req_abc-xyz_123");
  });

  it("returns null when no tag found", () => {
    expect(extractCorrelationId("hello world")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(extractCorrelationId("")).toBeNull();
  });

  it("only matches the first tag", () => {
    expect(extractCorrelationId("<corr:first> and <corr:second>")).toBe("first");
  });
});
