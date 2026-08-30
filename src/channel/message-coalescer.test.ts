import { describe, it, expect, vi } from "vitest";
import {
  createMessageCoalescer,
  takePrefixForFlush,
  DEFAULT_COALESCE_LIMITS,
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_BATCH_CHARS,
} from "./message-coalescer";
import { MAX_COMMAND_SIZE } from "../process/member-process";

/** 输入消息（不含 seq——coalescer 内部分配）。 */
function entry(sender: string, content: string, at = 1000) {
  return { sender, content, at };
}

describe("takePrefixForFlush (pure prefix selection)", () => {
  it("returns empty array for an empty bucket", () => {
    expect(takePrefixForFlush([], DEFAULT_COALESCE_LIMITS)).toEqual([]);
  });

  it("keeps FIFO order of the bucket", () => {
    const bucket = [
      { seq: 1, ...entry("a", "m1") },
      { seq: 2, ...entry("b", "m2") },
      { seq: 3, ...entry("c", "m3") },
    ];
    const taken = takePrefixForFlush(bucket, DEFAULT_COALESCE_LIMITS);
    expect(taken.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("takes at most maxBatchSize entries, leaving the rest for the next flush", () => {
    const bucket = Array.from({ length: 7 }, (_, i) => ({ seq: i + 1, ...entry("a", `m${i + 1}`) }));
    const taken = takePrefixForFlush(bucket, DEFAULT_COALESCE_LIMITS);
    expect(taken).toHaveLength(DEFAULT_COALESCE_LIMITS.maxBatchSize);
    expect(taken[0].seq).toBe(1);
    // 剩余留桶：下一轮从第 6 条继续
    const rest = takePrefixForFlush(bucket.slice(taken.length), DEFAULT_COALESCE_LIMITS);
    expect(rest.map((e) => e.seq)).toEqual([6, 7]);
  });

  it("respects the total-character budget", () => {
    const limits = { maxBatchSize: 10, maxBatchChars: 120 };
    // 每条 content 50 字符 + 标注开销 128 ≈ 178；第二条超预算
    const bucket = [
      { seq: 1, ...entry("a", "x".repeat(50)) },
      { seq: 2, ...entry("b", "y".repeat(50)) },
    ];
    const taken = takePrefixForFlush(bucket, limits);
    expect(taken.map((e) => e.seq)).toEqual([1]);
  });

  it("takes a single oversized message alone (not merged)", () => {
    const limits = { maxBatchSize: 5, maxBatchChars: 100 };
    const bucket = [
      { seq: 1, ...entry("a", "z".repeat(200)) },
      { seq: 2, ...entry("b", "ok") },
    ];
    const taken = takePrefixForFlush(bucket, limits);
    expect(taken).toHaveLength(1);
    expect(taken[0].seq).toBe(1);
    // 下一轮：正常消息按前缀规则处理
    const next = takePrefixForFlush(bucket.slice(1), limits);
    expect(next.map((e) => e.seq)).toEqual([2]);
  });

  it("caps the character budget at the hard MAX_COMMAND_SIZE guard", () => {
    const limits = { maxBatchSize: 5, maxBatchChars: Number.MAX_SAFE_INTEGER };
    const bucket = [
      { seq: 1, ...entry("a", "m1") },
      { seq: 2, ...entry("b", "m2") },
      { seq: 3, ...entry("c", "m3") },
    ];
    const taken = takePrefixForFlush(bucket, limits);
    // 封顶后仍不超过上限（不崩溃、条数受 size 限制）
    expect(taken).toHaveLength(3);
  });

  it("【复审 2】budgets UTF-8 BYTES (same unit as the MAX_COMMAND_SIZE guard), not UTF-16 chars", () => {
    const limits = { maxBatchSize: 10, maxBatchChars: 900 };
    // 300 个中文字符：UTF-16 长度 300 < 900，但 UTF-8 字节 900 + 开销 → 超预算
    const bucket = [
      { seq: 1, ...entry("甲", "字".repeat(300)) },
      { seq: 2, ...entry("乙", "ok") },
    ];
    const taken = takePrefixForFlush(bucket, limits);
    expect(taken).toHaveLength(1); // 中文内容按字节计超限 → 第二条不进前缀
    // 字节口径：前缀总字节（含开销）≤ 预算
    const takenBytes = taken.reduce(
      (sum, e) => sum + Buffer.byteLength(e.content, "utf8"),
      0
    );
    expect(takenBytes).toBeLessThanOrEqual(900);
  });

  it("【复审 2】a configured huge char budget never produces a package above MAX_COMMAND_SIZE bytes", () => {
    const limits = { maxBatchSize: 100, maxBatchChars: 10_000_000 };
    // 每条 100K 中文字符 ≈ 300KB UTF-8；4 条合并 = 1.2MB > 硬守卫
    const bucket = Array.from({ length: 5 }, (_, i) => ({
      seq: i + 1,
      ...entry("甲", "中".repeat(100_000)),
    }));
    const taken = takePrefixForFlush(bucket, limits);
    // 多条合并时前缀字节（含开销）必须低于 1MB 硬守卫（与 member-process guard 同单位）
    const totalBytes = taken.reduce((sum, e) => sum + Buffer.byteLength(e.content, "utf8"), 0);
    expect(taken.length).toBeGreaterThan(1); // 确实在合并
    expect(taken.length).toBeLessThan(5); // 被字节预算截断，不是全取
    expect(totalBytes + 128 * taken.length).toBeLessThan(MAX_COMMAND_SIZE);
  });
});

describe("createMessageCoalescer", () => {
  it("enqueue/has/count track per-receiver buckets across senders", () => {
    const c = createMessageCoalescer();
    expect(c.has("worker")).toBe(false);
    c.enqueue("worker", entry("a", "m1"));
    c.enqueue("worker", entry("b", "m2"));
    c.enqueue("other", entry("a", "m3"));
    expect(c.has("worker")).toBe(true);
    expect(c.count("worker")).toBe(2);
    expect(c.count("other")).toBe(1);
    expect(c.count("none")).toBe(0);
  });

  it("【复审 5】enqueue ignores any caller-supplied seq and assigns strictly increasing ids", () => {
    const c = createMessageCoalescer();
    c.enqueue("w1", { seq: 999, ...entry("a", "m1") } as any);
    c.enqueue("w2", entry("a", "m2"));
    c.enqueue("w1", entry("b", "m3"));
    const taken = c.takeForFlush("w1", DEFAULT_COALESCE_LIMITS);
    expect(taken.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("takeForFlush removes the prefix atomically (no re-dispatch duplicates)", () => {
    const c = createMessageCoalescer();
    for (let i = 1; i <= 3; i++) c.enqueue("worker", entry("a", `m${i}`));
    const first = c.takeForFlush("worker", DEFAULT_COALESCE_LIMITS);
    const second = c.takeForFlush("worker", DEFAULT_COALESCE_LIMITS);
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
    expect(c.has("worker")).toBe(false);
  });

  it("flush invokes the registered flusher with the taken prefix and clears the bucket", () => {
    const c = createMessageCoalescer();
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.enqueue("worker", entry("a", "m1"));
    c.enqueue("worker", entry("b", "m2"));
    c.flush("worker");
    expect(flusher).toHaveBeenCalledTimes(1);
    const [receiver, entries] = flusher.mock.calls[0];
    expect(receiver).toBe("worker");
    expect(entries.map((e: any) => e.seq)).toEqual([1, 2]);
    expect(c.has("worker")).toBe(false);
  });

  it("【复审 6】flush is this-independent — destructured calls must not crash", () => {
    const c = createMessageCoalescer();
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.enqueue("worker", entry("a", "m1"));
    const { flush } = c;
    flush("worker"); // 解构调用：this 为 undefined 也不崩
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it("flush with no flusher registered is a no-op that keeps the bucket (retry on next flush point)", () => {
    const c = createMessageCoalescer();
    c.enqueue("worker", entry("a", "m1"));
    c.flush("worker");
    expect(c.count("worker")).toBe(1);
    // 注册后即可派发
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.flush("worker");
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it("flush leaves the leftover (over-limit tail) in the bucket for the next flush point", () => {
    // 【复审 1】limits 经构造注入（getLimits）生效
    const c = createMessageCoalescer(() => ({ maxBatchSize: 1, maxBatchChars: 4000 }));
    c.enqueue("worker", entry("a", "m1"));
    c.enqueue("worker", entry("b", "m2"));
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.flush("worker");
    expect(flusher.mock.calls[0][1].map((e: any) => e.seq)).toEqual([1]);
    expect(c.count("worker")).toBe(1);
    c.flush("worker");
    expect(flusher.mock.calls[1][1].map((e: any) => e.seq)).toEqual([2]);
  });

  it("【复审 1】flush uses the constructor-injected getLimits (non-default limits take effect)", () => {
    const c = createMessageCoalescer(() => ({ maxBatchSize: 2, maxBatchChars: 4000 }));
    const flusher = vi.fn();
    c.setFlusher(flusher);
    for (let i = 1; i <= 3; i++) c.enqueue("worker", entry("a", `m${i}`));
    c.flush("worker");
    expect(flusher.mock.calls[0][1].map((e: any) => e.seq)).toEqual([1, 2]); // 配置 2 条生效
    expect(c.count("worker")).toBe(1);
    c.flush("worker");
    expect(flusher.mock.calls[1][1].map((e: any) => e.seq)).toEqual([3]);
  });

  it("flush falls back to DEFAULT_COALESCE_LIMITS without an injected getLimits", () => {
    const c = createMessageCoalescer();
    const flusher = vi.fn();
    c.setFlusher(flusher);
    for (let i = 1; i <= DEFAULT_MAX_BATCH_SIZE + 1; i++) {
      c.enqueue("worker", entry("a", `m${i}`));
    }
    c.flush("worker");
    expect(flusher.mock.calls[0][1]).toHaveLength(DEFAULT_MAX_BATCH_SIZE);
    expect(c.count("worker")).toBe(1);
  });

  it("drain removes all entries without invoking the flusher", () => {
    const c = createMessageCoalescer();
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.enqueue("worker", entry("a", "m1"));
    c.enqueue("worker", entry("b", "m2"));
    const drained = c.drain("worker");
    expect(drained.map((e) => e.seq)).toEqual([1, 2]);
    expect(flusher).not.toHaveBeenCalled();
    expect(c.has("worker")).toBe(false);
  });

  it("setFlusher replaces the previous flusher (idempotent re-registration)", () => {
    const c = createMessageCoalescer();
    const f1 = vi.fn();
    const f2 = vi.fn();
    c.setFlusher(f1);
    c.setFlusher(f2);
    c.enqueue("worker", entry("a", "m1"));
    c.flush("worker");
    expect(f1).not.toHaveBeenCalled();
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it("defaults export matches the standard limits", () => {
    expect(DEFAULT_COALESCE_LIMITS).toEqual({
      maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
      maxBatchChars: DEFAULT_MAX_BATCH_CHARS,
    });
  });
});
