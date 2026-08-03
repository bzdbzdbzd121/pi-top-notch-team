import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// NOTE: we do NOT mock @earendil-works/pi-tui here — we want the real
// matchesKey so we can drive the component with realistic key sequences.

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  MemberInspectorComponent,
  USER_DIRECT_PREFIX,
} from "./member-inspector";
import { MemberInspectorState } from "./member-inspector-state";

// ── Key sequences (real terminal encodings) ────────────────

const K = {
  esc: "\x1b",
  enter: "\r",
  ctrlEnter: "\x1b[13;5u",
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  end: "\x1b[F",
  backspace: "\x7f",
  ctrlA: "\x01",
  ctrlB: "\x02",
  ctrlShiftA: "\x1b[65;6u", // kitty CSI-u: 'A' + ctrl+shift
  ctrlO: "\x0f",
};

// ── Mocks ──────────────────────────────────────────────────

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

function makeDeps(opts: {
  handles?: Record<string, any>;
  opStates?: Record<string, "idle" | "working" | "crashed" | "stopped">;
}) {
  const handles = new Map(Object.entries(opts.handles ?? {}));
  const opStates = new Map(Object.entries(opts.opStates ?? {}));
  return {
    getMembers: () => [
      { name: "a", label: "分析员" },
      { name: "b", label: "编码员" },
    ],
    getHandle: (name: string) => handles.get(name),
    memberOpsStates: opStates,
  } as any;
}

function makeComponent(deps: any) {
  const tui = makeTui();
  const done = vi.fn();
  const state = new MemberInspectorState([
    { name: "a", label: "分析员" },
    { name: "b", label: "编码员" },
  ]);
  const comp = new MemberInspectorComponent(tui, makeTheme(), done, deps, state);
  return { comp, tui, done, state };
}

/** Type text into the (open) input box char by char. */
function typeText(comp: MemberInspectorComponent, text: string) {
  for (const ch of text) comp.handleInput(ch);
}

// ── Tests ──────────────────────────────────────────────────

describe("MemberInspectorComponent — input & send", () => {
  let deps: any;
  let handleA: any;

  beforeEach(() => {
    handleA = makeHandle();
    deps = makeDeps({
      handles: { a: handleA },
      opStates: { a: "idle", b: "idle" },
    });
  });

  it("opens input with 'i', sends prompt with prefix for idle member", () => {
    const { comp, state } = makeComponent(deps);
    comp.handleInput("i");
    expect(state.inputOpen).toBe(true);
    typeText(comp, "请停下手中的活");
    comp.handleInput(K.enter);

    expect(handleA.sendCommand).toHaveBeenCalledTimes(1);
    const cmd = handleA.sendCommand.mock.calls[0][0];
    expect(cmd.type).toBe("prompt");
    expect(cmd.message).toBe(`${USER_DIRECT_PREFIX}\n请停下手中的活`);
    expect(state.inputOpen).toBe(false);
    expect(state.notice).toContain("已发送");
  });

  it("sends follow_up when member is working (Enter)", () => {
    deps.memberOpsStates.set("a", "working");
    const { comp } = makeComponent(deps);
    comp.handleInput("i");
    typeText(comp, "追加一个任务");
    comp.handleInput(K.enter);
    expect(handleA.sendCommand.mock.calls[0][0].type).toBe("follow_up");
  });

  it("sends steer when member is working (Ctrl+Enter)", () => {
    deps.memberOpsStates.set("a", "working");
    const { comp } = makeComponent(deps);
    comp.handleInput("i");
    typeText(comp, "立即转向");
    comp.handleInput(K.ctrlEnter);
    expect(handleA.sendCommand.mock.calls[0][0].type).toBe("steer");
  });

  it("blocks sending to crashed member and shows notice", () => {
    deps.memberOpsStates.set("a", "crashed");
    const { comp, state } = makeComponent(deps);
    comp.handleInput("i");
    typeText(comp, "hello");
    comp.handleInput(K.enter);
    expect(handleA.sendCommand).not.toHaveBeenCalled();
    expect(state.notice).toContain("未运行");
  });

  it("sends slash commands raw without the direct-user prefix", () => {
    const { comp } = makeComponent(deps);
    comp.handleInput("i");
    typeText(comp, "/fix-tests");
    comp.handleInput(K.enter);
    const cmd = handleA.sendCommand.mock.calls[0][0];
    expect(cmd.message).toBe("/fix-tests");
  });

  it("backspace edits the buffer (unicode-safe)", () => {
    const { comp, state } = makeComponent(deps);
    comp.handleInput("i");
    typeText(comp, "你好a");
    comp.handleInput(K.backspace);
    expect(state.inputBuffer).toBe("你好");
  });

  it("Esc in input mode closes input only; second Esc closes overlay", () => {
    const { comp, state, done } = makeComponent(deps);
    comp.handleInput("i");
    typeText(comp, "draft");
    comp.handleInput(K.esc);
    expect(state.inputOpen).toBe(false);
    expect(done).not.toHaveBeenCalled();
    comp.handleInput(K.esc);
    expect(done).toHaveBeenCalledWith(null);
  });
});

describe("MemberInspectorComponent — control commands", () => {
  it("ctrl+a sends abort to active member", () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.handleInput(K.ctrlA);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(state.notice).toContain("abort");
  });

  it("ctrl+o sends compact", () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "idle" } });
    const { comp } = makeComponent(deps);
    comp.handleInput(K.ctrlO);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "compact" });
  });

  it("ctrl+a on stopped member is blocked", () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "stopped" } });
    const { comp, state } = makeComponent(deps);
    comp.handleInput(K.ctrlA);
    expect(handleA.sendCommand).not.toHaveBeenCalled();
    expect(state.notice).toContain("未运行");
  });

  it("ctrl+a works even when input box is open", () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    // Open input box first
    comp.handleInput("i");
    expect(state.inputOpen).toBe(true);
    // Type some text
    comp.handleInput("h");
    // Now press ctrl+a — should abort even though input is open
    comp.handleInput(K.ctrlA);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(state.notice).toContain("abort");
    // Input box should NOT be open (sendControl returns immediately, no input-mode return)
    expect(state.inputOpen).toBe(false);
  });

  it("ctrl+o works even when input box is open", () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    // Open input box
    comp.handleInput("i");
    expect(state.inputOpen).toBe(true);
    // Press ctrl+o — should compact even though input is open
    comp.handleInput(K.ctrlO);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "compact" });
    expect(state.notice).toContain("compact");
    // Input box should NOT be open
    expect(state.inputOpen).toBe(false);
  });

  it("ctrl+b aborts ALL executing members", () => {
    const handleA = makeHandle();
    const handleB = makeHandle();
    const deps = makeDeps({
      handles: { a: handleA, b: handleB },
      opStates: { a: "working", b: "compacting" },
    });
    const { comp, state } = makeComponent(deps);
    comp.handleInput(K.ctrlB);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(handleB.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(state.notice).toContain("2 个成员");
    expect(state.notice).toContain("分析员");
    expect(state.notice).toContain("编码员");
  });

  it("ctrl+b skips idle/stopped/crashed members", () => {
    const handleA = makeHandle();
    const handleB = makeHandle();
    const handleC = makeHandle();
    const deps = makeDeps({
      handles: { a: handleA, b: handleB, c: handleC },
      opStates: { a: "working", b: "idle", c: "crashed" },
    });
    const { comp, state } = makeComponent(deps);
    comp.handleInput(K.ctrlB);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(handleB.sendCommand).not.toHaveBeenCalled();
    expect(handleC.sendCommand).not.toHaveBeenCalled();
    expect(state.notice).toContain("1 个成员");
  });

  it("ctrl+shift+a (kitty CSI-u) also aborts ALL executing members", () => {
    const handleA = makeHandle();
    const handleB = makeHandle();
    const deps = makeDeps({
      handles: { a: handleA, b: handleB },
      opStates: { a: "working", b: "working" },
    });
    const { comp, state } = makeComponent(deps);
    comp.handleInput(K.ctrlShiftA);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(handleB.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(state.notice).toContain("2 个成员");
  });

  it("ctrl+shift+a in legacy terminals degrades to ctrl+a (single abort) — guarded by ctrl+b", () => {
    // Legacy terminals send the SAME byte for ctrl+shift+a and ctrl+a (\x01).
    // The inspector must NOT match it as abort-all; it falls through to the
    // single-member abort branch. ctrl+b remains the reliable all-terminal key.
    const handleA = makeHandle();
    const handleB = makeHandle();
    const deps = makeDeps({
      handles: { a: handleA, b: handleB },
      opStates: { a: "working", b: "working" },
    });
    const { comp } = makeComponent(deps);
    comp.handleInput(K.ctrlA); // legacy ctrl+shift+a arrives as ctrl+a
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(handleB.sendCommand).not.toHaveBeenCalled();
  });

  it("ctrl+b with no executing members shows notice, sends nothing", () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "idle" } });
    const { comp, state } = makeComponent(deps);
    comp.handleInput(K.ctrlB);
    expect(handleA.sendCommand).not.toHaveBeenCalled();
    expect(state.notice).toContain("没有正在执行");
  });

  it("ctrl+b works even when input box is open", () => {
    const handleA = makeHandle();
    const handleB = makeHandle();
    const deps = makeDeps({
      handles: { a: handleA, b: handleB },
      opStates: { a: "working", b: "working" },
    });
    const { comp, state } = makeComponent(deps);
    // Open input box first
    comp.handleInput("i");
    expect(state.inputOpen).toBe(true);
    // Press ctrl+b — should abort all even though input is open
    comp.handleInput(K.ctrlB);
    expect(handleA.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(handleB.sendCommand).toHaveBeenCalledWith({ type: "abort" });
    expect(state.inputOpen).toBe(false);
  });
});

describe("MemberInspectorComponent — navigation & refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arrow keys switch tabs and scroll", () => {
    const deps = makeDeps({ handles: {}, opStates: {} });
    const { comp, state } = makeComponent(deps);
    comp.handleInput(K.right);
    expect(state.activeIndex).toBe(1);
    comp.handleInput(K.left);
    expect(state.activeIndex).toBe(0);
  });

  it("markDirty triggers a throttled get_messages refetch", async () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    state.tabs[0].dirty = false;

    comp.markDirty("a");
    expect(state.tabs[0].dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    expect(handleA.sendCommandAndWait).toHaveBeenCalled();
    const cmd = handleA.sendCommandAndWait.mock.calls[0][0];
    expect(cmd.type).toBe("get_messages");
    // Lines built from fetched messages
    expect(state.tabs[0].lines.join("\n")).toContain("任务内容");
    expect(state.tabs[0].dirty).toBe(false);
  });

  it("does not refetch stopped members", async () => {
    const handleA = makeHandle();
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "stopped" } });
    const { comp } = makeComponent(deps);
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(handleA.sendCommandAndWait).not.toHaveBeenCalled();
  });

  it("'e' toggles expansion and refetches with expanded rendering", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }],
            timestamp: 1,
          },
        ],
      },
    });
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);
    comp.handleInput("e");
    expect(state.tabs[0].expanded).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(state.tabs[0].lines.join("\n")).toContain('"path"');
  });

  it("'t' toggles thinking visibility and refetches with thinking rendered", async () => {
    const handleA = makeHandle();
    handleA.sendCommandAndWait.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "让我先分析一下需求" },
              { type: "text", text: "好的" },
            ],
            timestamp: 1,
          },
        ],
      },
    });
    const deps = makeDeps({ handles: { a: handleA }, opStates: { a: "working" } });
    const { comp, state } = makeComponent(deps);

    // Default: thinking hidden — fetch and verify
    state.tabs[0].dirty = false;
    comp.markDirty("a");
    await vi.advanceTimersByTimeAsync(600);
    expect(state.tabs[0].lines.join("\n")).not.toContain("让我先分析一下需求");

    // Toggle on → refetch renders the thinking block
    comp.handleInput("t");
    expect(state.tabs[0].showThinking).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(state.tabs[0].lines.join("\n")).toContain("💭 思考");
    expect(state.tabs[0].lines.join("\n")).toContain("让我先分析一下需求");

    // Toggle off again → thinking hidden
    comp.handleInput("t");
    expect(state.tabs[0].showThinking).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(state.tabs[0].lines.join("\n")).not.toContain("让我先分析一下需求");
  });
});

describe("MemberInspectorComponent — render", () => {
  it("renders frame with title, tabs, footer and key hints", () => {
    const deps = makeDeps({ handles: {}, opStates: { a: "idle", b: "working" } });
    const { comp, state } = makeComponent(deps);
    state.setTabLines("a", ["hello body"], 10);
    const lines = comp.render(80);
    const joined = lines.join("\n");
    expect(joined).toContain("Member Inspector");
    expect(joined).toContain("❰分析员❱");
    expect(joined).toContain("编码员");
    expect(joined).toContain("hello body");
    // Clear footer hints: every action names its target, full key names
    expect(joined).toContain("切换成员");
    expect(joined).toContain("三行滚动");
    expect(joined).toContain("跳至底部");
    expect(joined).toContain("e 展开详情");
    expect(joined).toContain("t 显示思考");
    expect(joined).toContain("ctrl+a 中断");
    expect(joined).toContain("ctrl+b/ctrl+shift+a 全中断");
    expect(joined).toContain("ctrl+o 压缩");
    expect(joined).toContain("Esc 关闭");
    // Frame shape: top + header + sep + body + sep + footer×3 + bottom
    expect(lines[0]).toMatch(/^╭/);
    expect(lines[0]).toMatch(/╮$/); // rounded top-right corner
    expect(lines[lines.length - 1]).toMatch(/^╰/);
    expect(lines[lines.length - 1]).toMatch(/╯$/); // bottom border present
    // All frame lines must fit the render width exactly — an over-wide line
    // wraps inside the overlay and breaks the frame (corner/border loss).
    for (const l of lines) {
      expect(visibleWidth(l)).toBeLessThanOrEqual(80);
    }
    expect(visibleWidth(lines[0])).toBe(visibleWidth(lines[lines.length - 1]));
  });

  it("total rendered lines never exceed the overlay maxHeight (bottom border not clipped)", () => {
    // pi-tui clips overlays with slice(0, maxHeight) — keeping TOP lines and
    // dropping BOTTOM ones. If our line count is even 1 over floor(rows*0.85),
    // the bottom border is silently sliced off. Lock the arithmetic down.
    const realRows = process.stdout.rows;
    try {
      for (const rows of [24, 40, 50, 60]) {
        process.stdout.rows = rows;
        const deps = makeDeps({ handles: {}, opStates: {} });
        const { comp } = makeComponent(deps);
        const lines = comp.render(80);
        const maxHeight = Math.floor(rows * 0.85);
        expect(lines.length).toBeLessThanOrEqual(maxHeight);
        // Frame fills the available height (no wasted space)…
        expect(lines.length).toBe(maxHeight);
        // …and the last line is the bottom border
        expect(lines[lines.length - 1]).toMatch(/^╰/);
        expect(lines[lines.length - 1]).toMatch(/╯$/);
      }
    } finally {
      if (realRows === undefined) delete (process.stdout as any).rows;
      else process.stdout.rows = realRows;
    }
  });

  it("expand hint flips to 折叠 while details are expanded", () => {
    const deps = makeDeps({ handles: {}, opStates: {} });
    const { comp, state } = makeComponent(deps);
    state.tabs[0].expanded = true;
    const joined = comp.render(80).join("\n");
    expect(joined).toContain("e 折叠详情");
    expect(joined).not.toContain("e 展开详情");
  });

  it("thinking hint flips to 隐藏 while thinking is shown", () => {
    const deps = makeDeps({ handles: {}, opStates: {} });
    const { comp, state } = makeComponent(deps);
    state.tabs[0].showThinking = true;
    const joined = comp.render(80).join("\n");
    expect(joined).toContain("t 隐藏思考");
    expect(joined).not.toContain("t 显示思考");
  });

  it("input box replaces key hints while input is open", () => {
    const deps = makeDeps({ handles: {}, opStates: {} });
    const { comp } = makeComponent(deps);
    comp.handleInput("i");
    typeText(comp, "abc");
    const joined = comp.render(80).join("\n");
    expect(joined).toContain("> abc");
    // Navigation hints replaced by the input box…
    expect(joined).not.toContain("切换成员");
    // …and action hints replaced by input-mode hints
    expect(joined).toContain("Enter 发送");
    expect(joined).toContain("ctrl+Enter 立即转向");
    expect(joined).toContain("Esc 取消");
    expect(joined).not.toContain("Esc 关闭");
  });
});
