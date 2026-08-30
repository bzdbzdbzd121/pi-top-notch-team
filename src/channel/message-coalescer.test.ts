import { describe, it, expect, vi } from "vitest";
import {
  createMessageCoalescer,
  takePrefixForFlush,
  DEFAULT_COALESCE_LIMITS,
} from "./message-coalescer";

function entry(seq: number, sender: string, content: string, at = seq * 1000) {
  return { seq, sender, content, at };
}

describe("takePrefixForFlush (pure prefix selection)", () => {
  it("returns empty array for an empty bucket", () => {
    expect(takePrefixForFlush([], DEFAULT_COALESCE_LIMITS)).toEqual([]);
  });

  it("keeps FIFO order of the bucket", () => {
    const bucket = [entry(1, "a", "m1"), entry(2, "b", "m2"), entry(3, "c", "m3")];
    const taken = takePrefixForFlush(bucket, DEFAULT_COALESCE_LIMITS);
    expect(taken.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("takes at most maxBatchSize entries, leaving the rest for the next flush", () => {
    const bucket = Array.from({ length: 7 }, (_, i) => entry(i + 1, "a", `m${i + 1}`));
    const taken = takePrefixForFlush(bucket, DEFAULT_COALESCE_LIMITS);
    expect(taken).toHaveLength(DEFAULT_COALESCE_LIMITS.maxBatchSize);
    expect(taken[0].seq).toBe(1);
    // 剩余留桶：下一轮从第 6 条继续
    const rest = takePrefixForFlush(bucket.slice(taken.length), DEFAULT_COALESCE_LIMITS);
    expect(rest.map((e) => e.seq)).toEqual([6, 7]);
  });

  it("respects the total-character budget", () => {
    const limits = { maxBatchSize: 10, maxBatchChars: 120 };
    // 每条 content 50 字符 + 标注开销 40 ≈ 90；第二条超预算
    const bucket = [entry(1, "a", "x".repeat(50)), entry(2, "b", "y".repeat(50))];
    const taken = takePrefixForFlush(bucket, limits);
    expect(taken.map((e) => e.seq)).toEqual([1]);
  });

  it("takes a single oversized message alone (not merged)", () => {
    const limits = { maxBatchSize: 5, maxBatchChars: 100 };
    const bucket = [entry(1, "a", "z".repeat(200)), entry(2, "b", "ok")];
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
      entry(1, "a", "m1"),
      entry(2, "b", "m2"),
      entry(3, "c", "m3"),
    ];
    const taken = takePrefixForFlush(bucket, limits);
    // 封顶后仍不超过上限（不崩溃、条数受 size 限制）
    expect(taken).toHaveLength(3);
  });
});

describe("createMessageCoalescer", () => {
  it("enqueue/has/count track per-receiver buckets across senders", () => {
    const c = createMessageCoalescer();
    expect(c.has("worker")).toBe(false);
    c.enqueue("worker", entry(1, "a", "m1"));
    c.enqueue("worker", entry(2, "b", "m2"));
    c.enqueue("other", entry(3, "a", "m3"));
    expect(c.has("worker")).toBe(true);
    expect(c.count("worker")).toBe(2);
    expect(c.count("other")).toBe(1);
    expect(c.count("none")).toBe(0);
  });

  it("assigns strictly increasing seq numbers across receivers", () => {
    const c = createMessageCoalescer();
    c.enqueue("w1", entry(1, "a", "m1"));
    c.enqueue("w2", entry(2, "a", "m2"));
    c.enqueue("w1", entry(3, "b", "m3"));
    const taken = c.takeForFlush("w1", DEFAULT_COALESCE_LIMITS);
    expect(taken.map((e) => e.seq)).toEqual([1, 3]);
  });

  it("takeForFlush removes the prefix atomically (no re-dispatch duplicates)", () => {
    const c = createMessageCoalescer();
    for (let i = 1; i <= 3; i++) c.enqueue("worker", entry(i, "a", `m${i}`));
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
    c.enqueue("worker", entry(1, "a", "m1"));
    c.enqueue("worker", entry(2, "b", "m2"));
    c.flush("worker");
    expect(flusher).toHaveBeenCalledTimes(1);
    const [receiver, entries] = flusher.mock.calls[0];
    expect(receiver).toBe("worker");
    expect(entries.map((e: any) => e.seq)).toEqual([1, 2]);
    expect(c.has("worker")).toBe(false);
  });

  it("flush with no flusher registered is a no-op that keeps the bucket (retry on next flush point)", () => {
    const c = createMessageCoalescer();
    c.enqueue("worker", entry(1, "a", "m1"));
    c.flush("worker");
    expect(c.count("worker")).toBe(1);
    // 注册后即可派发
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.flush("worker");
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it("flush leaves the leftover (over-limit tail) in the bucket for the next flush point", () => {
    const c = createMessageCoalescer();
    c.enqueue("worker", entry(1, "a", "m1"));
    c.enqueue("worker", entry(2, "b", "m2"));
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.flush("worker", { maxBatchSize: 1, maxBatchChars: 4000 });
    expect(flusher.mock.calls[0][1].map((e: any) => e.seq)).toEqual([1]);
    expect(c.count("worker")).toBe(1);
    c.flush("worker", { maxBatchSize: 1, maxBatchChars: 4000 });
    expect(flusher.mock.calls[1][1].map((e: any) => e.seq)).toEqual([2]);
  });

  it("drain removes all entries without invoking the flusher", () => {
    const c = createMessageCoalescer();
    const flusher = vi.fn();
    c.setFlusher(flusher);
    c.enqueue("worker", entry(1, "a", "m1"));
    c.enqueue("worker", entry(2, "b", "m2"));
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
    c.enqueue("worker", entry(1, "a", "m1"));
    c.flush("worker");
    expect(f1).not.toHaveBeenCalled();
    expect(f2).toHaveBeenCalledTimes(1);
  });
});
