import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemberInspectorComponent } from "./member-inspector";
import { MemberInspectorState } from "./member-inspector-state";

// P4: get_entries {since} 游标增量拉取（spike: docs/spike-get-entries-incremental.md）
//
// 验收：② 稳态 refetch 只传新增消息（载荷下降）；③ 压缩/分支重写自动回退
// 全量、显示不丢不串；④ 跨成员进程重启游标仍有效；⑤ R5 后同内容不重复显示。

// ── Mocks (mirror member-inspector.test.ts + entries fixtures) ──

let entrySeq = 1000;

/** 把消息数组包成磁盘 entry 链（模拟 get_entries 响应）。 */
function entriesFrom(msgs: any[], opts?: { parentId?: string | null; leafId?: string; append?: boolean }): {
  entries: any[];
  leafId: string;
} {
  const parent = opts?.parentId === undefined ? "session-id" : opts.parentId;
  let last = parent;
  const entries = msgs.map((m, i) => {
    const id = opts?.append ? `${parent}-${i}` : `e${entrySeq++}`;
    const e = { type: "message", id, parentId: last, timestamp: "t", message: m };
    last = id;
    return e;
  });
  return { entries, leafId: opts?.leafId ?? (entries.length ? last : parent) };
}

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
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: null },
    })),
  };
}
function makeDeps(opts: { handles?: Record<string, any>; opStates?: Record<string, any> }) {
  const handles = new Map(Object.entries(opts.handles ?? {}));
  const opStates = new Map(Object.entries(opts.opStates ?? {}));
  return {
    getMembers: () => [{ name: "a", label: "分析员" }],
    getHandle: (name: string) => handles.get(name),
    memberOpsStates: opStates,
  } as any;
}
function makeComponent(deps: any) {
  const tui = makeTui();
  const done = vi.fn();
  const state = new MemberInspectorState([{ name: "a", label: "分析员" }]);
  const comp = new MemberInspectorComponent(tui, makeTheme(), done, deps, state);
  return { comp, tui, done, state };
}

const userMsg = (i: number) => ({ role: "user", content: `问题 ${i}: 内容${i}`, timestamp: i });

describe("P4: get_entries 增量拉取", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("① 首次全量：发 get_entries（无 since），祖先链消息入缓存", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({
      data: entriesFrom([userMsg(1), userMsg(2)]),
    } as any);
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    const cmd = handleA.sendCommandAndWait.mock.calls[0][0];
    expect(cmd.type).toBe("get_entries");
    expect(cmd.since).toBeUndefined(); // 首次无游标
    expect(state.tabs[0].lines.join("\n")).toContain("问题 1");
    expect(state.tabs[0].lines.join("\n")).toContain("问题 2");
  });

  it("② 增量：第二次 refetch 带 since 游标，只追加新消息（载荷下降，不重复）", async () => {
    const handleA = makeHandle();
    const first = entriesFrom([userMsg(1), userMsg(2)]);
    const firstLeaf = first.leafId; // = 最后一条 entry id（游标）
    // 第二次：新消息挂在第一条链的叶子之后（parentId = firstLeaf）
    const second = entriesFrom([userMsg(3)], { parentId: firstLeaf });
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: first } as any)
      .mockResolvedValueOnce({ data: second } as any);
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(state.tabs[0].lines.join("\n")).toContain("问题 2");

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    const cmd2 = handleA.sendCommandAndWait.mock.calls[1][0];
    expect(cmd2.type).toBe("get_entries");
    expect(cmd2.since).toBe(firstLeaf); // 游标 = 最后一条 entry id
    // 增量后：旧消息 + 新消息，无重复
    const lines = state.tabs[0].lines.join("\n");
    expect(lines).toContain("问题 3");
    expect(lines.split("问题 1").length - 1).toBe(1);
    expect(state.tabs[0].dirty).toBe(false);
  });

  it("③ 分支重写：since 不在新祖先链 → 自动回退全量（重发无 since），显示不丢", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: entriesFrom([userMsg(1), userMsg(2)]) } as any)
      .mockResolvedValueOnce({
        data: { entries: [{ type: "message", id: "x1", parentId: "unknown-root", timestamp: "t", message: userMsg(99) }], leafId: "x1" },
      } as any) // 分支重写：parentId 从未见过
      .mockResolvedValueOnce({ data: entriesFrom([userMsg(1), userMsg(2), userMsg(99)]) } as any); // 全量重拉
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // call1 全量
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // call2 分支重写 → 回退调度
    await vi.advanceTimersByTimeAsync(600); // call3 全量重拉

    const cmds = handleA.sendCommandAndWait.mock.calls.map((c: any) => c[0]);
    expect(cmds).toHaveLength(3);
    expect(cmds[2].type).toBe("get_entries");
    expect(cmds[2].since).toBeUndefined(); // 回退后全量无游标
    const lines = state.tabs[0].lines.join("\n");
    expect(lines).toContain("问题 99");
    expect(lines).toContain("问题 1"); // 显示不丢
  });

  it("③ since 不匹配（success:false）→ 删游标重拉全量", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: entriesFrom([userMsg(1)]) } as any)
      .mockResolvedValueOnce({ type: "response", command: "get_entries", success: false, error: "Entry not found" } as any)
      .mockResolvedValueOnce({ data: entriesFrom([userMsg(1), userMsg(2)]) } as any);
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // since 失效
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // 全量重拉

    const cmds = handleA.sendCommandAndWait.mock.calls.map((c: any) => c[0]);
    expect(cmds[1].since).toBeDefined();
    expect(cmds[2].since).toBeUndefined();
    expect(state.tabs[0].lines.join("\n")).toContain("问题 2");
  });

  it("④ 压缩场景：compaction entry 混入被过滤，增量继续（游标不受压缩影响）", async () => {
    const handleA = makeHandle();
    const first = entriesFrom([userMsg(1), userMsg(2)]);
    const firstLeaf = first.leafId; // 最后一条 message entry id（游标）
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: first } as any)
      .mockResolvedValueOnce({
        data: {
          entries: [
            { type: "compaction", id: "c1", parentId: firstLeaf, timestamp: "t", summary: "..." },
            { type: "message", id: "c2", parentId: "c1", timestamp: "t", message: userMsg(3) },
          ],
          leafId: "c2",
        },
      } as any);
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    const cmd2 = handleA.sendCommandAndWait.mock.calls[1][0];
    expect(cmd2.since).toBe(firstLeaf); // 压缩不失效游标（磁盘 append-only）
    const lines = state.tabs[0].lines.join("\n");
    expect(lines).toContain("问题 3"); // 压缩后的新消息追加
    expect(lines).not.toContain("summary"); // compaction entry 不渲染
    expect(lines).toContain("问题 1"); // 旧消息保留
  });

  it("⑤ R5: pending 完成确认后不重复显示（增量后 reconcilePending 正常）", async () => {
    const handleA = makeHandle();
    const done = { role: "assistant", content: [{ type: "text", text: "已完成任务" }] };
    handleA.sendCommandAndWait.mockResolvedValue({ data: entriesFrom([userMsg(1), done]) } as any);
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    // 流式完成 → pending 入列
    state.completeLiveMessage("a", done);
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600); // refetch 确认 pending → 丢弃

    expect(state.tabs[0].pendingCompletions).toHaveLength(0);
    const lines = state.tabs[0].lines.join("\n");
    expect(lines.split("已完成任务").length - 1).toBe(1); // 恰好一次
  });

  it("fail-open：响应无 entries（老版本 get_messages 兜底）→ 全量路径仍渲染", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({
      data: { messages: [userMsg(1), userMsg(2)] },
    } as any);
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    const cmd = handleA.sendCommandAndWait.mock.calls[0][0];
    expect(cmd.type).toBe("get_entries"); // 仍发 get_entries
    expect(state.tabs[0].lines.join("\n")).toContain("问题 1");
  });

  it("④ 跨成员进程重启：游标是磁盘 id，TL 内存游标重建后 since 仍匹配", async () => {
    const handleA = makeHandle();
    const first = entriesFrom([userMsg(1), userMsg(2)]);
    const firstLeaf = first.leafId;
    const second = entriesFrom([userMsg(3)], { parentId: firstLeaf });
    handleA.sendCommandAndWait
      .mockResolvedValueOnce({ data: first } as any)
      .mockResolvedValueOnce({ data: second } as any);
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.render(80);

    // 成员进程重启 → 新 handle（同磁盘会话），TL 组件持续存活
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    const handleB = makeHandle();
    handleB.sendCommandAndWait.mockResolvedValue({ data: second } as any);
    deps.getHandle = (name: string) => (name === "a" ? handleB : undefined);

    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);

    const cmd = handleB.sendCommandAndWait.mock.calls[0][0];
    expect(cmd.type).toBe("get_entries");
    expect(cmd.since).toBe(firstLeaf); // 磁盘 id 游标跨进程仍有效
    expect(state.tabs[0].lines.join("\n")).toContain("问题 3");
  });
});
