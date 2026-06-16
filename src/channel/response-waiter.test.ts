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
    const waitPromise = waiter.waitForResponse("req-abc");

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

  it("supports multiple concurrent waits with different correlation IDs", async () => {
    const waiter = createResponseWaiter();
    const wait1 = waiter.waitForResponse("req-001");
    const wait2 = waiter.waitForResponse("req-002");

    waiter.resolveIfWaiting("req-001", "a", "done1", undefined);
    waiter.resolveIfWaiting("req-002", "b", "done2", undefined);

    expect(await wait1).toMatchObject({ status: "response", content: "done1" });
    expect(await wait2).toMatchObject({ status: "response", content: "done2" });
  });

  it("does not resolve unrelated correlation IDs", async () => {
    const waiter = createResponseWaiter();
    const waitPromise = waiter.waitForResponse("req-abc");

    const resolved = waiter.resolveIfWaiting("req-xyz", "someone", "nope", undefined);
    expect(resolved).toBe(false);

    // Not resolved — promise should still be pending (no timeout to advance)
    // We can still resolve it later
    waiter.resolveIfWaiting("req-abc", "analyzer", "finally", undefined);
    const result = await waitPromise;
    expect(result.status).toBe("response");
    expect(result.content).toBe("finally");
  });

  // ── resolveIfWaiting ─────────────────────────────────────

  it("resolveIfWaiting returns false when no waiters match", () => {
    const waiter = createResponseWaiter();
    expect(waiter.resolveIfWaiting("nonexistent", "anyone", "content", undefined)).toBe(false);
  });

  it("resolveIfWaiting only resolves the first matching waiter (one-shot)", async () => {
    const waiter = createResponseWaiter();
    const wait1 = waiter.waitForResponse("req-abc");

    // First resolve
    waiter.resolveIfWaiting("req-abc", "a", "first", undefined);
    expect((await wait1).content).toBe("first");

    // Second resolve for same corrId should do nothing (no waiter active)
    expect(waiter.resolveIfWaiting("req-abc", "b", "second", undefined)).toBe(false);
  });

  // ── cancelAll ───────────────────────────────────────────

  it("cancelAll resolves all pending waits with cancelled status", async () => {
    const waiter = createResponseWaiter();
    const wait1 = waiter.waitForResponse("req-001");
    const wait2 = waiter.waitForResponse("req-002");

    waiter.cancelAll();

    expect(await wait1).toEqual({ status: "cancelled", from: undefined, content: undefined, subject: undefined });
    expect(await wait2).toEqual({ status: "cancelled", from: undefined, content: undefined, subject: undefined });
  });

  it("cancelAll is idempotent", () => {
    const waiter = createResponseWaiter();
    waiter.waitForResponse("req-abc");
    waiter.cancelAll();
    // Calling again should not throw
    waiter.cancelAll();
  });

  it("cancelByCorrId cancels a single waiter", async () => {
    const waiter = createResponseWaiter();
    const wait1 = waiter.waitForResponse("req-001");
    const wait2 = waiter.waitForResponse("req-002");

    waiter.cancelByCorrId("req-001");

    // Only the cancelled waiter should have cancelled status
    expect(await wait1).toEqual({ status: "cancelled", from: undefined, content: undefined, subject: undefined });
    // The other waiter should still be alive — we can still resolve it
    waiter.resolveIfWaiting("req-002", "b", "done", undefined);
    expect((await wait2).status).toBe("response");
  });

  it("cancelByCorrId does nothing for non-existent correlationId", () => {
    const waiter = createResponseWaiter();
    // Should not throw
    waiter.cancelByCorrId("nonexistent");
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
