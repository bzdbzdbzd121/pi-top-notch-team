import { describe, it, expect, vi, afterEach } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  buildBodyLines,
  buildBodyLinesIncremental,
  createBodyBuildCache,
  messageFingerprint,
  IDENTITY_THEME,
  type BodyBuildCache,
  type BuildBodyOptions,
} from "./member-inspector-state";

// ── P1-③ incremental body building ─────────────────────────
//
// Contract: buildBodyLinesIncremental(cache, messages, opts) must return
// byte-identical lines to buildBodyLines(messages, opts) in EVERY scenario,
// with mode distinguishing "full" (first build / boundary mismatch / opts
// change) from "incremental" (append-only prefix match → only the new tail
// is built). Streaming-tail rule: the LAST message is always rebuilt (it
// grows in-place while streaming), so changing it must NOT trigger a full
// rebuild but MUST reflect the new content.
//
// These tests use the REAL pi-tui (no visibleWidth mock) so the width
// semantics are identical to production.

const W = 80;

const mkOpts = (over: Partial<BuildBodyOptions> = {}): BuildBodyOptions => ({
  width: W,
  expanded: false,
  theme: IDENTITY_THEME,
  ...over,
});

// ── Fixtures ───────────────────────────────────────────────

function userMsg(text: string) {
  return { role: "user", content: text };
}

function textBlock(text: string) {
  return { type: "text", text };
}

function thinkingBlock(text: string) {
  return { type: "thinking", thinking: text };
}

function toolCallBlock(name: string, args: Record<string, unknown> = {}) {
  return { type: "toolCall", id: "tc-1", name, arguments: args };
}

function assistantMsg(blocks: any[]) {
  return { role: "assistant", content: blocks };
}

function toolResultMsg(toolName: string, content: string, isError = false) {
  return { role: "toolResult", toolName, content, isError };
}

/** A small mixed corpus of realistic member-session messages. */
const CORPUS: any[] = [
  userMsg("你好，请分析这个项目的结构"),
  assistantMsg([textBlock("我来分析一下。这是一个多成员协作系统，核心模块包括消息通道与进程管理。")]),
  toolCallBlock("read", { path: "src/index.ts" }) ? assistantMsg([toolCallBlock("read", { path: "src/index.ts" })]) : null,
  toolResultMsg("read", "export default function (pi: ExtensionAPI) { ... }", false),
  assistantMsg([
    thinkingBlock("让我先梳理一下依赖关系"),
    textBlock("结论：架构分层清晰，主要瓶颈在消息队列。" + "详细说明".repeat(30)),
  ]),
  userMsg("emoji 混合文本 👍👨👩👧👦 和中文，还有超长文本" + "x".repeat(300) + "结尾"),
  toolResultMsg("bash", "line1\nline2\nline3\n错误发生", true),
].filter(Boolean);

// ── Helpers ────────────────────────────────────────────────

/** Assert incremental result is byte-identical to the full build. */
function expectSameAsFull(
  cache: BodyBuildCache,
  messages: any[],
  opts: BuildBodyOptions,
  mode: "full" | "incremental"
) {
  const r = buildBodyLinesIncremental(cache, messages, opts);
  expect(r.mode).toBe(mode);
  expect(r.lines).toEqual(buildBodyLines(messages, opts));
  return r;
}

// ── Tests ──────────────────────────────────────────────────

describe("P1-③ 增量刷新：边界指纹 + 流式尾部规则", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("empty cache first build → full, matches buildBodyLines", () => {
    const cache = createBodyBuildCache();
    expectSameAsFull(cache, [], mkOpts(), "full");
    expect(buildBodyLinesIncremental(cache, [], mkOpts()).lines).toEqual([]);
  });

  it("appending messages one at a time → incremental, byte-identical", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs: any[] = [];
    for (let i = 0; i < CORPUS.length; i++) {
      msgs.push(CORPUS[i]);
      // Streaming-tail rule: with TAIL=1 the cache needs ≥1 stable prefix
      // message, so the first two builds (1 msg / 2 msgs) are full; after
      // that every append is incremental.
      expectSameAsFull(cache, msgs, opts, i < 2 ? "full" : "incremental");
    }
  });

  it("append a large batch → incremental once, byte-identical", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectSameAsFull(cache, CORPUS.slice(0, 3), opts, "full");
    expectSameAsFull(cache, CORPUS, opts, "incremental");
  });

  it("streaming: last message grows in-place → incremental (tail rebuilt), content reflected", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs = CORPUS.slice(0, 3);
    expectSameAsFull(cache, msgs, opts, "full");

    // Simulate streaming output: last message's text keeps growing in place.
    const last = msgs[msgs.length - 1];
    const text = last.content[0].text;
    for (const chunk of [" 补充", " 更多内容", " 以及结尾的收束语，一直增长到很长很长。".repeat(5)]) {
      last.content[0].text = text + chunk;
      expectSameAsFull(cache, msgs, opts, "incremental");
    }
  });

  it("streaming: new messages appended after the growing tail → incremental", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs = CORPUS.slice(0, 2);
    expectSameAsFull(cache, msgs, opts, "full");
    // The tail grows…
    const last = msgs[msgs.length - 1];
    last.content[0].text += " 增长中…";
    expectSameAsFull(cache, msgs, opts, "incremental");
    // …then a brand-new message arrives.
    msgs.push(CORPUS[2]);
    expectSameAsFull(cache, msgs, opts, "incremental");
  });

  it("message count decreases (history rewritten) → full fallback", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectSameAsFull(cache, CORPUS.slice(0, 5), opts, "full");
    expectSameAsFull(cache, CORPUS.slice(0, 3), opts, "full");
  });

  it("mid-list rewrite (fingerprint discontinuity) → full fallback", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs = CORPUS.slice(0, 5);
    expectSameAsFull(cache, msgs, opts, "full");
    // Rewrite the BOUNDARY message (index seenCount-1 = 3): compression
    // style edits land here → fingerprint mismatch → full fallback.
    const rewritten = msgs.map((m, i) =>
      i === 3 ? { ...m, content: [{ ...m.content[0], text: "被压缩改写的内容" }] } : m
    );
    expectSameAsFull(cache, rewritten, opts, "full");
  });

  it("boundary message rewrite is detected even when length is unchanged", () => {
    // Same-length rewrite (compress keeps text length) must still change
    // the fingerprint — that is the point of a content fingerprint.
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs = CORPUS.slice(0, 4);
    expectSameAsFull(cache, msgs, opts, "full");
    const boundary = msgs[2];
    const orig = boundary.content[0].text;
    const rewritten = msgs.map((m, i) =>
      i === 2 ? { ...m, content: [{ ...m.content[0], text: orig.split("").reverse().join("") }] } : m
    );
    expect(rewritten[2].content[0].text.length).toBe(orig.length);
    expectSameAsFull(cache, rewritten, opts, "full");
  });

  it("same content repeated (no change) → incremental with identical lines", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs = CORPUS.slice(0, 4);
    expectSameAsFull(cache, msgs, opts, "full");
    expectSameAsFull(cache, msgs, opts, "incremental");
    // Deep-equal lines (incremental result must equal full result)
  });

  it("fingerprint is stable for identical content, sensitive to any render-affecting change", () => {
    const m = { role: "user", content: "你好", timestamp: 123 };
    expect(messageFingerprint(m)).toBe(messageFingerprint({ ...m }));
    expect(messageFingerprint(m)).not.toBe(messageFingerprint({ ...m, content: "你好呀" }));
    expect(messageFingerprint(m)).not.toBe(messageFingerprint({ ...m, role: "assistant" }));
    // Non-render fields (timestamp/id) must NOT affect the fingerprint
    expect(messageFingerprint(m)).toBe(messageFingerprint({ ...m, timestamp: 999 }));
    const tc = { role: "assistant", content: [{ type: "toolCall", id: "x1", name: "read", arguments: { path: "a" } }] };
    expect(messageFingerprint(tc)).toBe(messageFingerprint({ ...tc, content: [{ ...tc.content[0], id: "y2" }] }));
    expect(messageFingerprint(tc)).not.toBe(messageFingerprint({ ...tc, content: [{ ...tc.content[0], arguments: { path: "b" } }] }));
  });

  it("messageFingerprint(undefined) does not throw (malformed payload defense)", () => {
    // S2: JSON.stringify(undefined) is undefined → fnv1a64 would read
    // s.length and throw. buildBodyRaw skips null messages but the
    // fingerprint path has no such guard; a throw here would be swallowed
    // by flushDirty's .catch and the tab update would be silently lost.
    expect(messageFingerprint(undefined)).toBe(messageFingerprint(undefined));
    expect(messageFingerprint(undefined)).not.toBe(messageFingerprint(null));
    expect(messageFingerprint(undefined)).not.toBe(messageFingerprint(""));
  });

  it("expanded toggle → full rebuild (opts signature change)", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectSameAsFull(cache, CORPUS, opts, "full");
    expectSameAsFull(cache, CORPUS, mkOpts({ expanded: true }), "full");
    // …and incremental continues afterwards
    expectSameAsFull(cache, [...CORPUS, userMsg("继续")], mkOpts({ expanded: true }), "incremental");
  });

  it("showThinking toggle → full rebuild", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectSameAsFull(cache, CORPUS, opts, "full");
    expectSameAsFull(cache, CORPUS, mkOpts({ showThinking: true }), "full");
    expectSameAsFull(cache, [...CORPUS, toolResultMsg("bash", "ok")], mkOpts({ showThinking: true }), "incremental");
  });

  it("width change (resize) → full rebuild", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectSameAsFull(cache, CORPUS, opts, "full");
    expectSameAsFull(cache, CORPUS, mkOpts({ width: 120 }), "full");
    expectSameAsFull(cache, [...CORPUS, userMsg("wider")], mkOpts({ width: 120 }), "incremental");
  });

  it("theme wrapper identity does not gate incremental (component-level constant)", () => {
    // inspectorTheme is a getter that returns a NEW wrapper object per
    // access, so reference comparison would block incremental forever.
    // Theme is constant for the component lifetime; only width/expanded/
    // showThinking participate in the opts signature (per final summary
    // P1-③: 展开/折叠/思考切换、resize 强制全量).
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    expectSameAsFull(cache, CORPUS.slice(0, 4), opts, "full");
    const otherTheme = { ...IDENTITY_THEME };
    expectSameAsFull(cache, [...CORPUS.slice(0, 4), userMsg("theme 包装器新对象")], mkOpts({ theme: otherTheme }), "incremental");
  });

  it("caches are independent per tab", () => {
    const opts = mkOpts();
    const a = createBodyBuildCache();
    const b = createBodyBuildCache();
    expectSameAsFull(a, CORPUS.slice(0, 3), opts, "full");
    expectSameAsFull(b, CORPUS.slice(0, 5), opts, "full");
    // Different progress in each cache; both stay correct.
    expectSameAsFull(a, [...CORPUS.slice(0, 3), userMsg("a 的新消息")], opts, "incremental");
    expectSameAsFull(b, [...CORPUS.slice(0, 5), userMsg("b 的新消息")], opts, "incremental");
  });

  it("messages with empty content / unknown roles stay consistent", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const weird = [userMsg(""), { role: "customRole", payload: { x: 1 } }, assistantMsg([])];
    expectSameAsFull(cache, weird.slice(0, 2), opts, "full");
    expectSameAsFull(cache, weird, opts, "incremental");
    expectSameAsFull(cache, [...weird, toolResultMsg("bash", "后到消息")], opts, "incremental");
  });

  it("incremental does NOT rebuild the whole history (perf: tail-only work)", () => {
    // Acceptance: incremental scenarios must only build the new tail.
    // 400 messages, then append 5 → incremental build must be far cheaper
    // than a full rebuild of the same 400+5 messages.
    const cache = createBodyBuildCache();
    const opts = mkOpts({ width: 100 });
    const many: any[] = [];
    for (let i = 0; i < 200; i++) {
      many.push(userMsg(`问题 ${i}: ` + "这是一段较长的用户输入文本，包含中英文与代码片段，".repeat(4)));
      many.push(assistantMsg([textBlock("分析结果 ".repeat(30) + `第 ${i} 轮`)]));
    }
    const fullBefore = many.slice(0, 400);
    expectSameAsFull(cache, fullBefore, opts, "full");

    const grew = [...many, ...CORPUS.slice(0, 5)];
    const t0 = performance.now();
    const r = buildBodyLinesIncremental(cache, grew, opts);
    const incTime = performance.now() - t0;
    expect(r.mode).toBe("incremental");
    expect(r.lines).toEqual(buildBodyLines(grew, opts));

    // 对照：全量重建同样的 405 条消息。用「全新消息对象」构建——否则 wrap
    // 缓存（P3-① user/toolResult 也缓存）会让全量路径同样 O(1)/消息，比例
    // 断言变成测量噪声。冷对象强制全量路径真正重做全部 wrap 工作。
    const freshGrew = grew.map((m: any) => ({
      ...m,
      content: Array.isArray(m.content)
        ? m.content.map((c: any) => ({ ...c }))
        : m.content,
    }));
    const t1 = performance.now();
    buildBodyLines(freshGrew, opts);
    const fullTime = performance.now() - t1;
    // Incremental work is proportional to the tail (5 msgs), not the history.
    expect(incTime).toBeLessThan(fullTime / 3);
  });

  it("very long single-line history stays byte-identical under incremental appends", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts({ width: 40 });
    const long = userMsg("中文".repeat(2000));
    const long2 = userMsg("中文".repeat(2000) + "追加");
    expectSameAsFull(cache, [long, long2], opts, "full");
    expectSameAsFull(cache, [long, long2, userMsg("第三条")], opts, "incremental");
  });

  it("emoji / ZWJ sequences stay byte-identical in incremental tail", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts();
    const msgs = [userMsg("👍👨👩👧👦❤️ flag 🇨🇳"), assistantMsg([textBlock("🚀 火箭 + ZWJ 👩\u200d💻")])];
    expectSameAsFull(cache, msgs, opts, "full");
    expectSameAsFull(cache, [...msgs, toolResultMsg("bash", "尾部 emoji 🎉")], opts, "incremental");
  });

  it("every emitted line stays within the width budget", () => {
    const cache = createBodyBuildCache();
    const opts = mkOpts({ width: 60 });
    const r = buildBodyLinesIncremental(cache, [...CORPUS, userMsg("x".repeat(500))], opts);
    for (const l of r.lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(60);
    }
  });
});
