import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemberInspectorComponent } from "./member-inspector";
import {
  MemberInspectorState,
  buildBodyLines,
  fitLinesToWidth,
} from "./member-inspector-state";

// P1-④ 交互感知刷新抑制 + 分片兜底 (final summary Phase 4)
//
// 挂起：交互窗口内（最近 ~800ms 有按键）挂起 flushDirty 与后台
//       requestRender；停止后自动补刷一次（dirty 保留不丢）。
// 分片：全量重建路径每片 N 条消息、setTimeout(0) 让出事件循环，
//       保证按键事件不被长同步构建饿死。增量路径保持同步（便宜）。

// ── Mocks (mirror member-inspector.test.ts) ────────────────

const buildMsgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: "user",
    content: `问题 ${i}: 这是一段较长的用户输入文本，包含中英文与代码片段，`.repeat(3),
    timestamp: i,
  }));

function makeTui() {
  return { requestRender: vi.fn() };
}

function makeTheme() {
  return { fg: (_c: string, t: string) => t, bold: (t: string) => t };
}

function makeHandle() {
  return {
    sendCommand: vi.fn(),
    sendCommandAndWait: vi.fn(async (_cmd: any, _pred: any, _t?: number) => ({
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [{ role: "user", content: "任务内容", timestamp: 1 }] },
    })),
  };
}

function makeDeps(opts: { handles?: Record<string, any> }) {
  const handles = new Map(Object.entries(opts.handles ?? {}));
  return {
    getMembers: () => [{ name: "a", label: "分析员" }],
    getHandle: (name: string) => handles.get(name),
    memberOpsStates: new Map([["a", "working"]]),
  } as any;
}

function makeComponent(deps: any) {
  const tui = makeTui();
  const done = vi.fn();
  const state = new MemberInspectorState([{ name: "a", label: "分析员" }]);
  const comp = new MemberInspectorComponent(tui, makeTheme(), done, deps, state);
  return { comp, tui, done, state };
}

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Tests ──────────────────────────────────────────────────

describe("P1-④ 交互感知刷新抑制（挂起 + 补刷 + 分片）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("交互窗口内（按键后 <800ms）flush 挂起，窗口关闭后自动补刷", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({ data: { messages: buildMsgs(10) } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp } = makeComponent(deps);

    comp.handleInput("\x1b[B"); // scroll key opens the interaction window
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // throttle fires INSIDE the window
    expect(handleA.sendCommandAndWait).not.toHaveBeenCalled(); // suspended

    await vi.advanceTimersByTimeAsync(1000); // window closed → deferred retry fires
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(1); // catch-up flush
  });

  it("挂起期间多次 markDirty 合并为窗口后一次补刷（dirty 保留不丢）", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({ data: { messages: buildMsgs(10) } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state } = makeComponent(deps);

    comp.handleInput("\x1b[B"); // scroll down opens the interaction window
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // suspended
    comp.markDirty("a"); // more activity while suspended — dirty stays set
    comp.handleInput("\x1b[A"); // more scrolling reopens the window
    // The suspended flush re-deferred 800ms past its (re-)trigger; advance
    // well past the interaction window so the catch-up flush fires.
    await vi.advanceTimersByTimeAsync(3000); // window closed
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(1); // single catch-up
    await vi.advanceTimersByTimeAsync(600);
    expect(state.tabs[0].dirty).toBe(false); // consumed by the catch-up flush
    expect(state.tabs[0].lines.length).toBeGreaterThan(0);
  });

  it("后台 requestRender 在交互窗口内挂起；按键反馈渲染不受影响", async () => {
    const handleA = makeHandle();
    const deferred = makeDeferred<any>();
    handleA.sendCommandAndWait.mockReturnValueOnce(deferred.promise);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, tui } = makeComponent(deps);

    // Flush starts OUTSIDE the window (no interaction yet) → fetch pending.
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(1);

    const renders = tui.requestRender.mock.calls.length;
    comp.handleInput("\x1b[B"); // scroll key enters the window; feedback renders immediately
    expect(tui.requestRender).toHaveBeenCalledTimes(renders + 1);

    // Fetch resolves while interacting → the background render is suspended.
    deferred.resolve({ data: { messages: buildMsgs(5) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(tui.requestRender).toHaveBeenCalledTimes(renders + 1);

    // P1-④/S2: the suspended render is NOT dropped — once the window
    // closes it gets a compensation render with the fresh data.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tui.requestRender).toHaveBeenCalledTimes(renders + 2); // compensation

    // A later flush renders again.
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(tui.requestRender).toHaveBeenCalledTimes(renders + 3);
  });

  it("挂起期间消息增长，补刷后 newBelow 提示不丢", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: { messages: buildMsgs(30) } } as any)
      .mockResolvedValueOnce({ data: { messages: buildMsgs(35) } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // initial full flush (no interaction)
    expect(state.tabs[0].lines.length).toBeGreaterThan(0);
    expect(state.tabs[0].followTail).toBe(true);

    comp.handleInput("\x1b[A"); // scroll up → stop following the tail; opens the window
    expect(state.tabs[0].followTail).toBe(false);

    comp.markDirty("a"); // member activity arrives while the user scrolls
    await vi.advanceTimersByTimeAsync(3000); // window closed → catch-up flush

    // New messages arrived while away from the tail → the hint is preserved.
    expect(state.tabs[0].newBelow).toBe(true);
    expect(state.tabs[0].lines.join("\n")).toContain("问题 34");
  });

  it("全量重建分片执行：构建间隙按键事件可被处理（真实事件循环）", async () => {
    // Fake timers cannot observe the slices (all 0ms yields are drained by
    // one advance call), so this test uses the REAL event loop and holds
    // the first yield: with the build suspended mid-way, a key event must
    // still be processable — that is the starvation guarantee.
    vi.useRealTimers();
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValueOnce({ data: { messages: buildMsgs(250) } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state, tui } = makeComponent(deps);
    comp.render(80);

    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    let held: (() => void) | null = null;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: any,
      ms?: any,
      ...args: any[]
    ) => {
      // Hold the FIRST 0ms yield of the chunked build.
      if (ms === 0 && held === null) {
        held = cb;
        return 0 as any;
      }
      return realSetTimeout(cb, ms, ...args);
    }) as any);

    comp.markDirty("a");
    await new Promise((r) => realSetTimeout(r, 600)); // throttle → fetch → slice 1 → yield HELD
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(1);
    // Build is suspended at the first yield — nothing committed to the UI.
    expect(state.tabs[0].lines.length).toBe(0);

    // A key event DURING the build is processed normally (not starved).
    const before = tui.requestRender.mock.calls.length;
    comp.handleInput("j");
    expect(tui.requestRender).toHaveBeenCalledTimes(before + 1);

    // Release the build — it completes through the remaining slices.
    held!();
    await new Promise((r) => realSetTimeout(r, 50));
    // ≥2 zero-delay yields for 250 msgs / 100-per-slice (held + released).
    expect(spy.mock.calls.filter(([, d]) => d === 0).length).toBeGreaterThanOrEqual(2);

    const full = buildBodyLines(buildMsgs(250), {
      width: 76,
      expanded: false,
      showThinking: false,
    });
    expect(state.tabs[0].lines).toEqual(fitLinesToWidth(full, 78)); // byte-identical
    spy.mockRestore();
  });

  it("增量路径保持同步（不引入分片让出延迟）", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: { messages: buildMsgs(200) } } as any)
      .mockResolvedValueOnce({ data: { messages: buildMsgs(205) } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // full build (cold cache) — chunked

    const yieldSpy = vi.spyOn(globalThis, "setTimeout");
    const yieldsBefore = yieldSpy.mock.calls.filter(([, d]) => d === 0).length;

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // append 5 → incremental (synchronous)
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(2);
    expect(state.tabs[0].lines.join("\n")).toContain("问题 204");
    const yieldsAfter = yieldSpy.mock.calls.filter(([, d]) => d === 0).length;
    expect(yieldsAfter).toBe(yieldsBefore); // no chunking on the fast path
    yieldSpy.mockRestore();
  });

  // ── B1 (review): dirty marks arriving DURING a chunked build must not be
  // consumed by setTabLines — the e/t intent / new activity re-flushes.

  it("B1: 分片构建期间按 e → 补刷重建 expanded 行（意图不丢）", async () => {
    vi.useRealTimers();
    const toolMsg = {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }],
      timestamp: 0,
    };
    const msgs = [toolMsg, ...buildMsgs(249)];
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({ data: { messages: msgs } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state, tui } = makeComponent(deps);
    comp.render(80);

    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    let held: (() => void) | null = null;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: any,
      ms?: any,
      ...args: any[]
    ) => {
      if (ms === 0 && held === null) {
        held = cb;
        return 0 as any;
      }
      return realSetTimeout(cb, ms, ...args);
    }) as any);

    comp.markDirty("a");
    await new Promise((r) => realSetTimeout(r, 600)); // fetch#1 → slice 1 → yield HELD
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(1);

    comp.handleInput("e"); // explicit expand intent DURING the build
    expect(state.expanded).toBe(true);

    held!(); // release the build
    await new Promise((r) => realSetTimeout(r, 1200)); // finish #1 → re-flush → fetch#2

    // The e-intent was NOT silently consumed: a second fetch happened and
    // the final lines are rendered in expanded form.
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(2);
    expect(state.tabs[0].dirty).toBe(false); // consumed by the catch-up flush
    expect(state.tabs[0].lines.join("\n")).toContain('"path"');
    // Both key feedback and the background renders fired (sanity).
    expect(tui.requestRender).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("B1: 分片构建期间新活动 markDirty → 补刷显示新消息", async () => {
    vi.useRealTimers();
    const handleA = makeHandle();
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: { messages: buildMsgs(250) } } as any)
      .mockResolvedValueOnce({ data: { messages: buildMsgs(260) } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    let held: (() => void) | null = null;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: any,
      ms?: any,
      ...args: any[]
    ) => {
      if (ms === 0 && held === null) {
        held = cb;
        return 0 as any;
      }
      return realSetTimeout(cb, ms, ...args);
    }) as any);

    comp.markDirty("a");
    await new Promise((r) => realSetTimeout(r, 600)); // fetch#1 → slice 1 → yield HELD
    comp.markDirty("a"); // member activity arrives mid-build
    held!();
    await new Promise((r) => realSetTimeout(r, 1200)); // finish #1 → re-flush → fetch#2

    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(2);
    expect(state.tabs[0].dirty).toBe(false);
    // Messages that arrived during the build are displayed, not lost.
    expect(state.tabs[0].lines.join("\n")).toContain("问题 259");
    spy.mockRestore();
  });

  // ── S1 (review): e/t while the window is open must still refresh
  // immediately — the explicit intent clears the window.

  it("S1: 窗口已开时按 e → 清窗，刷新不被挂起", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({ data: { messages: buildMsgs(10) } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state } = makeComponent(deps);

    comp.handleInput("\x1b[B"); // scroll opens the window
    comp.handleInput("e"); // explicit expand intent — must not be deferred
    expect(state.expanded).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(handleA.sendCommandAndWait).toHaveBeenCalledTimes(1); // immediate flush
  });

  // ── S2 (review): a background render suspended inside the window gets a
  // compensation render once the window closes.

  it("S2: 窗口内完成的 flush 渲染挂起 → 窗口关闭后补偿渲染一次", async () => {
    const handleA = makeHandle();
    const deferred = makeDeferred<any>();
    handleA.sendCommandAndWait.mockReturnValueOnce(deferred.promise);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, tui } = makeComponent(deps);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // flush starts OUTSIDE the window
    comp.handleInput("\x1b[B"); // window opens mid-flight (feedback render +1)
    const before = tui.requestRender.mock.calls.length;

    deferred.resolve({ data: { messages: buildMsgs(5) } });
    await vi.advanceTimersByTimeAsync(0); // .then completes → render suspended
    expect(tui.requestRender).toHaveBeenCalledTimes(before); // suspended, not dropped

    await vi.advanceTimersByTimeAsync(900); // window closed → compensation render
    expect(tui.requestRender).toHaveBeenCalledTimes(before + 1);
  });

  // ── S3 (review): a fetch resolving after close() must not render/update.

  it("S3: close 后完成的 fetch 不再渲染", async () => {
    const handleA = makeHandle();
    const deferred = makeDeferred<any>();
    handleA.sendCommandAndWait.mockReturnValueOnce(deferred.promise);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, tui, state } = makeComponent(deps);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // fetch in flight
    comp.close();
    const before = tui.requestRender.mock.calls.length;

    deferred.resolve({ data: { messages: buildMsgs(5) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(tui.requestRender).toHaveBeenCalledTimes(before); // no late render
    expect(state.tabs[0].lines.length).toBe(0); // no late commit
  });
});
