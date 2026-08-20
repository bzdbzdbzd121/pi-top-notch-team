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

// ── P2 验收：结构共享断言（⑤）+ 滚动实时性护栏（④）────────

function buildThinkingMsgs(n: number, thinkingPerMsg: number): any[] {
  const msgs: any[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) {
      msgs.push({ role: "user", content: `问题 ${i}: 请分析模块 ${i} 的实现`, timestamp: i });
    } else if (i % 3 === 1) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "让我们仔细分析这个函数的实现逻辑，考虑边界条件与异常处理路径。".repeat(thinkingPerMsg) },
          { type: "text", text: `分析完成：模块 ${i}` },
        ],
        timestamp: i,
      });
    } else {
      msgs.push({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: `输出 ${i}` }], timestamp: i });
    }
  }
  return msgs;
}

describe("P2 结构共享 + 滚动实时性护栏", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("⑤ 流式 flush 期间 lines 前缀数组引用不变（整体替换次数 ≈ 0，仅尾部区段更新）", async () => {
    const handleA = makeHandle();
    // 3000 条历史 + 30KB thinking（1000 条 thinking 消息 × 10 句 ≈ 30KB CJK）
    const history = buildThinkingMsgs(3000, 10);
    handleA.sendCommandAndWait.mockResolvedValue({ data: { messages: history } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    const tab = state.tabs[0];
    expect(tab.lines.length).toBeGreaterThan(0);
    const refBefore = tab.lines; // 结构共享：同一数组对象
    const lenBefore = tab.lines.length;

    // 流式 flush：live 消息增长，仅尾部区段更新
    state.setLiveMessage("a", { role: "assistant", content: [{ type: "text", text: "" }] });
    for (const d of ["增量一，内容逐渐增长。", "增量二，继续追加更多内容。", "增量三，收尾完成。"]) {
      state.applyLiveDelta("a", { type: "text_delta", contentIndex: 0, delta: d });
      comp.markDirty("a");
      await vi.advanceTimersByTimeAsync(600);
    }
    // 数组引用恒常（P2-③ 局部追加，未整体替换）—— 同一对象、内容增长
    expect(state.tabs[0].lines).toBe(refBefore);
    expect(state.tabs[0].lines.length).toBeGreaterThan(lenBefore);
  });

  it("④ 3000 条历史 + 思考流：增量 flush 同步块 < 5ms、render < 16ms（真实时钟）", async () => {
    // 用真实时钟测量（fake timers 下 performance.now 被 mock，无法测时长）。
    // 历史 + live 已就绪，仅测「增量 flush + 局部追加 + render」同步块。
    vi.useRealTimers();
    const history = buildThinkingMsgs(3000, 10);
    const state = new MemberInspectorState([{ name: "a", label: "分析员" }]);
    // 预热：等价于一次已完成的冷构建（3000 条历史 + 30KB thinking）
    const { buildBodyLinesIncremental, fitLinesIncremental, createBodyBuildCache } = await import("./member-inspector-state");
    const cache = createBodyBuildCache();
    const opts = { width: 76, expanded: false, showThinking: true, theme: { fg: (_c: string, t: string) => t } as any };
    const live = { role: "assistant", content: [{ type: "thinking", thinking: "我们需要仔细分析这个函数的实现逻辑，考虑边界条件与异常处理路径。".repeat(600) }] };
    const msgs = [...history, live];
    let raw = buildBodyLinesIncremental(cache, msgs, opts);
    let fitted = fitLinesIncremental(cache, raw, 78);
    state.setTabLines("a", fitted.lines, 30);

    // 真实 render 路径（P2-④ 加强：非 lines.slice 代理——含主题/边框/头部/可见切片）
    const comp = new MemberInspectorComponent(
      makeTui(),
      makeTheme(),
      vi.fn(),
      makeDeps({}),
      state
    );
    comp.render(80); // 预热：锁定 lastWidth（render 样本不含 width-change 分支）

    // 预热一次（首个增量 flush 会包含全量构建后的 GC/代码编译尾音，非稳态）
    live.content[0].thinking += "预热增量：让 V8 完成该热路径的编译与内存整理。";
    raw = buildBodyLinesIncremental(cache, msgs, opts);
    fitted = fitLinesIncremental(cache, raw, 78);
    state.setTabLines("a", fitted.lines, 30, fitted.changed);
    comp.render(80);

    // 流式增量 flush（思考流继续增长）：稳态同步块必须远小于 5ms 上界。
    // 用 min 断言稳态成本（个别 GC 尖峰不算算法退化）+ mean 断言整体有界。
    const flushSamples: number[] = [];
    const renderSamples: number[] = [];
    for (let i = 0; i < 30; i++) {
      live.content[0].thinking += `追加增量 ${i}：继续深入分析边界条件与异常处理路径，保证实现正确。`;
      const t0 = performance.now();
      raw = buildBodyLinesIncremental(cache, msgs, opts);
      fitted = fitLinesIncremental(cache, raw, 78);
      state.setTabLines("a", fitted.lines, 30, fitted.changed);
      flushSamples.push(performance.now() - t0);
      const t1 = performance.now();
      comp.render(80); // 真实 render（主题 fg + 边框 + 头部 + 可见切片）
      renderSamples.push(performance.now() - t1);
    }
    const minFlush = Math.min(...flushSamples);
    const meanFlush = flushSamples.reduce((a, b) => a + b, 0) / flushSamples.length;
    expect(minFlush).toBeLessThan(2); // 验收 ④：稳态 flush 同步块 < 2ms（设计目标 <1ms）
    expect(meanFlush).toBeLessThan(5); // 整体均值有界（GC 尖峰可容忍）
    const minRender = Math.min(...renderSamples);
    expect(minRender).toBeLessThan(16); // 验收 ④：单帧交互 render < 16ms（真实路径）
    // 结构共享断言（⑤）同步覆盖
    expect(fitted.lines).toBe(cache.fitLines);
  });

  it("P2-③ buildMessages 缓存：流式 flush 不重新展开 O(history) 数组", async () => {
    const handleA = makeHandle();
    const history = buildThinkingMsgs(500, 5);
    handleA.sendCommandAndWait.mockResolvedValue({ data: { messages: history } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    // 流式 flush：live 引用稳定 → getBuildMessages 命中缓存（无 spread）
    state.setLiveMessage("a", { role: "assistant", content: [{ type: "thinking", thinking: "" }] });
    const cached = (comp as any).getBuildMessages("a", history, [], state.tabs[0].live);
    const same = (comp as any).getBuildMessages("a", history, [], state.tabs[0].live);
    expect(cached).toBe(same); // 同一数组引用 —— 不重新展开

    // pending/live 变化 → 重建一次
    state.completeLiveMessage("a", { role: "assistant", content: [{ type: "text", text: "完成" }] });
    const rebuilt = (comp as any).getBuildMessages("a", history, state.tabs[0].pendingCompletions, state.tabs[0].live);
    expect(rebuilt).not.toBe(cached);
    expect(rebuilt.length).toBe(history.length + 1);
  });

  it("P2-② 主题切换（invalidate）：存活的流式 thinking block 全部行使用新主题，无旧主题残留", async () => {
    // 审查必改：themeKey 只含 (color, indent) 不含主题身份；主题切换（同宽度）
    // 后 invalidate 只清 bodyCaches，若 appendWrapCache 不清，全量重建时流式
    // block 命中 warm entry → 已完成行残留旧主题色（混合主题）。
    const themeA = { fg: (_c: string, t: string) => `«A»${t}«/A»`, bold: (t: string) => t };
    const themeB = { fg: (_c: string, t: string) => `«B»${t}«/B»`, bold: (t: string) => t };
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({ data: { messages: [] } } as any);
    const deps = makeDeps({ handles: { a: handleA } });
    const tui = makeTui();
    const done = vi.fn();
    const state = new MemberInspectorState([{ name: "a", label: "分析员" }]);
    state.showThinking = true;
    const comp = new MemberInspectorComponent(tui, themeA, done, deps, state);
    comp.render(80);
    // 流式 thinking block：文本足够长以产生已完成的 wrapped 行（主题 A）
    state.setLiveMessage("a", { role: "assistant", content: [{ type: "thinking", thinking: "" }] });
    state.applyLiveDelta("a", {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "第一段思考内容，足够长以换行。第二段更详细的内容也够长。".repeat(4),
    });
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(state.tabs[0].lines.join("")).toContain("«A»");
    // 主题切换（同宽度）→ invalidate 路径
    (comp as any).theme = themeB;
    comp.invalidate();
    await vi.advanceTimersByTimeAsync(600);
    const all = state.tabs[0].lines.join("");
    expect(all).toContain("«B»");
    expect(all).not.toContain("«A»"); // 无旧主题残留（混合主题 bug 锁定）
  });
});
