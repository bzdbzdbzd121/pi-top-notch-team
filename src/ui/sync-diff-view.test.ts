import { describe, it, expect, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMockContext } from "../test/fixtures/mock-extension-api";
import {
  SyncDiffViewComponent,
  buildDisplayLines,
  countDiffChanges,
  createSyncDiffViewState,
  formatSyncDiffActions,
  formatSyncDiffHeader,
  formatSyncDiffHints,
  moveSyncDiffAction,
  normalizeDiffLines,
  reflowSyncDiffView,
  scrollSyncDiffView,
  showSyncDiffView,
  syncDiffVisibleLines,
  type SyncDiffViewInput,
} from "./sync-diff-view";
import { conflictChoices } from "../sync/decide";

const DIFF = [
  "diff --git a/local.txt b/remote.txt",
  "index 1111111..2222222 100644",
  "--- a/local.txt",
  "+++ b/remote.txt",
  "@@ -1,3 +1,4 @@",
  " name: refactoring",
  "-description: 本机描述",
  "+description: 云端描述",
  "+新增一行",
  " members: []",
  "",
].join("\n");

const input = (overrides?: Partial<SyncDiffViewInput>): SyncDiffViewInput => ({
  path: "refactoring.yaml",
  index: 2,
  total: 3,
  summaryLines: ["  本机版本：120 字节（修改于 2026-10-17 12:30）", "  云端版本：140 字节"],
  diffLines: normalizeDiffLines(DIFF),
  actions: conflictChoices("both-modified"),
  width: 80,
  height: 3,
  ...overrides,
});

describe("阶段 4 差异视图：纯状态（不依赖真实 TUI，验收 7）", () => {
  it("差异行规范化：去掉 git 头噪声、标注两侧、统计增删行数", () => {
    const lines = normalizeDiffLines(DIFF);
    expect(lines.some((l) => l.startsWith("diff --git"))).toBe(false);
    expect(lines.some((l) => l.startsWith("index "))).toBe(false);
    expect(lines).toContain("── 本机版本（-）");
    expect(lines).toContain("── 云端版本（+）");
    expect(lines).toContain("-description: 本机描述");
    expect(lines).toContain("+description: 云端描述");

    const counts = countDiffChanges(lines);
    expect(counts.added).toBe(2);
    expect(counts.removed).toBe(1);
  });

  it("长行按宽度硬包装（保证可见窗口 = 屏幕行数）", () => {
    const wrapped = buildDisplayLines(["abcdefghij", "短行"], 4);
    expect(wrapped).toEqual(["abcd", "efgh", "ij", "短行"]);
  });

  it("滚动：向下/向上按行，越界钳制；PgUp/PgDn 按页", () => {
    let state = createSyncDiffViewState(input());
    expect(state.offset).toBe(0);
    state = scrollSyncDiffView(state, 1);
    expect(state.offset).toBe(1);
    state = scrollSyncDiffView(state, 1000);
    const max = Math.max(0, state.displayLines.length - state.height);
    expect(state.offset).toBe(max);
    state = scrollSyncDiffView(state, -1000);
    expect(state.offset).toBe(0);
    state = scrollSyncDiffView(state, 2);
    state = scrollSyncDiffView(state, -2);
    expect(state.offset).toBe(0);
    expect(scrollSyncDiffView(scrollSyncDiffView(state, 1), -5).offset).toBe(0);
  });

  it("可见窗口含滚动指示与首尾边界", () => {
    const state = createSyncDiffViewState(input({ height: 2 }));
    const first = syncDiffVisibleLines(state);
    expect(first[0]).toBe(state.displayLines[0]);
    const bottom = scrollSyncDiffView(state, 1000);
    const last = syncDiffVisibleLines(bottom);
    expect(last[last.length - 1]).toBe(state.displayLines[state.displayLines.length - 1]);
  });

  it("按终端宽度重排：行数变化、offset 钳制、高亮动作保留（复审建议 #3）", () => {
    const state = createSyncDiffViewState(input({ width: 80, height: 3 }));
    const scrolled = scrollSyncDiffView(state, 2);
    const moved = moveSyncDiffAction(scrolled, 2);

    const narrow = reflowSyncDiffView(moved, 12);
    expect(narrow.displayLines.length).toBeGreaterThan(moved.displayLines.length); // 窄终端行数变多
    expect(narrow.actionIndex).toBe(2); // 高亮动作保留（resize 后回车不会提交错动作）
    expect(narrow.offset).toBe(2);

    const wide = reflowSyncDiffView(moved, 200);
    expect(wide.displayLines.length).toBeLessThanOrEqual(moved.displayLines.length);
    expect(wide.actionIndex).toBe(2);

    // 大幅收窄导致可达行数变少时，offset 被钳制而非越界
    const tiny = reflowSyncDiffView(moveSyncDiffAction(scrollSyncDiffView(state, 999), 0), 12);
    expect(tiny.offset).toBeLessThanOrEqual(Math.max(0, tiny.displayLines.length - tiny.height));
  });

  it("选项集：三选项形态给 3 个、两选项形态给 2 个；移动可环绕", () => {
    const three = createSyncDiffViewState(input());
    expect(three.actions).toHaveLength(3);
    expect(moveSyncDiffAction(three, 1).actionIndex).toBe(1);
    expect(moveSyncDiffAction(moveSyncDiffAction(three, 1), -1).actionIndex).toBe(0);
    expect(moveSyncDiffAction(three, -1).actionIndex).toBe(2); // 环绕

    const two = createSyncDiffViewState(input({ actions: conflictChoices("delete-modify") }));
    expect(two.actions.map((a) => a.value)).toEqual(["take-remote", "keep-local"]);
  });

  it("头部/选项/提示文案：进度、两侧信息、差异行数、键位提示", () => {
    const state = createSyncDiffViewState(input());
    const header = formatSyncDiffHeader(state).join("\n");
    expect(header).toContain("冲突 2/3");
    expect(header).toContain("refactoring.yaml");
    expect(header).toContain("本机版本：120 字节");
    expect(header).toContain("云端版本：140 字节");
    expect(header).toContain("差异 +2/-1");

    const actions = formatSyncDiffActions(state);
    expect(actions).toContain("1) 保留本地");
    expect(actions).toContain("2) 采用远端");
    expect(actions).toContain("3) 两边都留");
    expect(actions.split("\n").filter((l) => l.startsWith("▶"))).toHaveLength(1);
    expect(actions.split("\n")[0]).toContain("▶ 1) 保留本地");
    expect(moveSyncDiffAction(state, 1).actions.length).toBe(3);

    const hints = formatSyncDiffHints();
    expect(hints).toContain("↑↓");
    expect(hints).toContain("Enter 确认");
    expect(hints).toContain("Esc 取消");
  });
});

describe("阶段 4 差异视图：组件与入口", () => {
  const fakeTui = { requestRender: vi.fn() } as never;
  const fakeTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

  it("组件按 render(width) 重排（pi-tui 契约；无死代码 setWidth）", () => {
    const done = vi.fn();
    const component = new SyncDiffViewComponent(fakeTui, fakeTheme, done, input({ width: 80, height: 3 }));
    const before = component.getState().displayLines.length;
    component.render(12); // 窄终端（内容宽度 10 → 长行被拆成多行）
    expect(component.getState().displayLines.length).toBeGreaterThan(before);
    component.render(200);
    expect(component.getState().displayLines.length).toBeLessThanOrEqual(before);
    expect(typeof (component as unknown as { setWidth?: unknown }).setWidth).toBe("undefined"); // 死代码已删
  });

  it("键盘：↑↓/PgUp/PgDn 滚动、数字与 ←→ 选动作、Enter 返回所选、Esc 取消", () => {
    const done = vi.fn();
    const component = new SyncDiffViewComponent(fakeTui, fakeTheme, done, input());
    component.handleInput("\u001b[B"); // ↓
    component.handleInput("\u001b[6~"); // PgDn
    component.handleInput("3"); // 选第三个动作
    component.handleInput("\r"); // Enter
    expect(done).toHaveBeenCalledWith("keep-both");

    const done2 = vi.fn();
    const c2 = new SyncDiffViewComponent(fakeTui, fakeTheme, done2, input({ actions: conflictChoices("delete-modify") }));
    c2.handleInput("\u001b[D"); // ←
    c2.handleInput("\r");
    expect(done2).toHaveBeenCalledWith("keep-local"); // ← 从 take-remote 环回 keep-local

    const done3 = vi.fn();
    const c3 = new SyncDiffViewComponent(fakeTui, fakeTheme, done3, input());
    c3.handleInput("\u001b"); // Esc
    expect(done3).toHaveBeenCalledWith(undefined);
  });

  it("showSyncDiffView 通过 ctx.ui.custom 打开（overlay），返回用户选项", async () => {
    const ctx = createMockContext();
    const customSpy = vi.fn((factory: any, _options?: unknown) => {
      const done = vi.fn();
      const component = factory({ requestRender: vi.fn() }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, undefined, done);
      component.handleInput("2");
      component.handleInput("\r");
      // 模拟 pi 将 done 的结果作为 custom 的返回值
      return Promise.resolve("take-remote");
    });
    (ctx.ui as any).custom = customSpy;
    const result = await showSyncDiffView(ctx as unknown as ExtensionCommandContext, input());
    expect(result).toBe("take-remote");
    expect(customSpy).toHaveBeenCalledTimes(1);
    const options = customSpy.mock.calls[0][1] as { overlay?: boolean; overlayOptions?: { width?: string } };
    expect(options.overlay).toBe(true);
    expect(options.overlayOptions?.width).toBe("90%");
  });

  it("无 UI（custom 不可用）→ 返回 undefined，不抛错（调用方按取消处理）", async () => {
    const ctx = createMockContext();
    (ctx.ui as any).custom = undefined;
    await expect(showSyncDiffView(ctx as unknown as ExtensionCommandContext, input())).resolves.toBeUndefined();
  });
});
