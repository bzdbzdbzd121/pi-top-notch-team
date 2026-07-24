import { describe, it, expect, vi } from "vitest";
import {
  ScrollSelectComponent,
  computeVisibleRange,
  filterScrollItems,
  type ScrollSelectItem,
} from "./scroll-select";

// ── Test helpers ───────────────────────────────────────────

const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
};

function mockTui() {
  return { requestRender: vi.fn() } as any;
}

function mockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
}

function makeItems(n: number, prefix = "item"): ScrollSelectItem[] {
  return Array.from({ length: n }, (_, i) => ({
    value: `${prefix}-${i}`,
    label: `${prefix}-${i}`,
  }));
}

function createComponent(
  items: ScrollSelectItem[],
  opts?: { maxVisible?: number; initialValue?: string }
) {
  const done = vi.fn();
  const component = new ScrollSelectComponent(mockTui(), mockTheme(), done, {
    title: "Test",
    items,
    maxVisible: opts?.maxVisible,
    initialValue: opts?.initialValue,
  });
  return { component, done };
}

// ── computeVisibleRange ────────────────────────────────────

describe("computeVisibleRange", () => {
  it("shows everything when total <= maxVisible", () => {
    expect(computeVisibleRange(0, 5, 10)).toEqual({ start: 0, end: 5 });
    expect(computeVisibleRange(4, 5, 10)).toEqual({ start: 0, end: 5 });
  });

  it("centers the window around the selection", () => {
    expect(computeVisibleRange(10, 100, 10)).toEqual({ start: 5, end: 15 });
  });

  it("clamps to the top", () => {
    expect(computeVisibleRange(0, 100, 10)).toEqual({ start: 0, end: 10 });
    expect(computeVisibleRange(2, 100, 10)).toEqual({ start: 0, end: 10 });
  });

  it("clamps to the bottom", () => {
    expect(computeVisibleRange(99, 100, 10)).toEqual({ start: 90, end: 100 });
    expect(computeVisibleRange(97, 100, 10)).toEqual({ start: 90, end: 100 });
  });

  it("handles empty lists", () => {
    expect(computeVisibleRange(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });
});

// ── filterScrollItems ──────────────────────────────────────

describe("filterScrollItems", () => {
  const items: ScrollSelectItem[] = [
    { value: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5", description: "Claude Sonnet" },
    { value: "openai/gpt-5", label: "openai/gpt-5", description: "GPT-5" },
  ];

  it("returns all items for an empty query", () => {
    expect(filterScrollItems(items, "")).toBe(items);
    expect(filterScrollItems(items, "   ")).toBe(items);
  });

  it("matches by value substring", () => {
    const result = filterScrollItems(items, "gpt");
    expect(result.map((i) => i.value)).toEqual(["openai/gpt-5"]);
  });

  it("matches by description text", () => {
    const result = filterScrollItems(items, "sonnet");
    expect(result.map((i) => i.value)).toEqual(["anthropic/claude-sonnet-4-5"]);
  });

  it("uses searchText when provided", () => {
    const withSearch: ScrollSelectItem[] = [
      { value: "a", label: "a", searchText: "zebra" },
      { value: "b", label: "b", searchText: "yak" },
    ];
    expect(filterScrollItems(withSearch, "zebra").map((i) => i.value)).toEqual(["a"]);
  });
});

// ── ScrollSelectComponent ──────────────────────────────────

describe("ScrollSelectComponent", () => {
  it("Enter selects the first item by default", () => {
    const { component, done } = createComponent(makeItems(3));
    component.handleInput(KEYS.enter);
    expect(done).toHaveBeenCalledWith("item-0");
  });

  it("arrow down then Enter selects the second item", () => {
    const { component, done } = createComponent(makeItems(3));
    component.handleInput(KEYS.down);
    component.handleInput(KEYS.enter);
    expect(done).toHaveBeenCalledWith("item-1");
  });

  it("arrow up wraps to the bottom", () => {
    const { component, done } = createComponent(makeItems(3));
    component.handleInput(KEYS.up);
    component.handleInput(KEYS.enter);
    expect(done).toHaveBeenCalledWith("item-2");
  });

  it("Esc cancels with undefined", () => {
    const { component, done } = createComponent(makeItems(3));
    component.handleInput(KEYS.escape);
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("limits visible items to maxVisible and shows a scroll indicator", () => {
    const { component } = createComponent(makeItems(30), { maxVisible: 10 });
    const lines = component.render(100);
    // 10 items + scroll indicator + title + input + hints + spacers
    const itemLines = lines.filter((l) => l.startsWith("→ ") || l.startsWith("  item-"));
    expect(itemLines.length).toBe(10);
    expect(lines.some((l) => l.includes("(1/30)"))).toBe(true);
  });

  it("page down scrolls by maxVisible", () => {
    const { component, done } = createComponent(makeItems(30), { maxVisible: 10 });
    component.handleInput(KEYS.pageDown);
    component.handleInput(KEYS.enter);
    expect(done).toHaveBeenCalledWith("item-10");
  });

  it("typing filters the list and Enter selects the match", () => {
    const items: ScrollSelectItem[] = [
      { value: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
      { value: "openai/gpt-5", label: "openai/gpt-5" },
      { value: "google/gemini-3-pro", label: "google/gemini-3-pro" },
    ];
    const { component, done } = createComponent(items);
    for (const ch of "gpt") component.handleInput(ch);
    component.handleInput(KEYS.enter);
    expect(done).toHaveBeenCalledWith("openai/gpt-5");
  });

  it("backspace restores filtered items", () => {
    const items: ScrollSelectItem[] = [
      { value: "openai/gpt-5", label: "openai/gpt-5" },
      { value: "google/gemini-3-pro", label: "google/gemini-3-pro" },
    ];
    const { component, done } = createComponent(items);
    for (const ch of "gpt") component.handleInput(ch);
    for (let i = 0; i < 3; i++) component.handleInput(KEYS.backspace);
    // Filter cleared → first item selected again
    component.handleInput(KEYS.enter);
    expect(done).toHaveBeenCalledWith("openai/gpt-5");
  });

  it("shows a no-match message when the filter matches nothing", () => {
    const { component, done } = createComponent(makeItems(3));
    for (const ch of "zzzz") component.handleInput(ch);
    const lines = component.render(100);
    expect(lines.some((l) => l.includes("无匹配项"))).toBe(true);
    // Enter on empty list does not call done
    component.handleInput(KEYS.enter);
    expect(done).not.toHaveBeenCalled();
  });

  it("preselects initialValue", () => {
    const { component, done } = createComponent(makeItems(20), {
      initialValue: "item-7",
    });
    component.handleInput(KEYS.enter);
    expect(done).toHaveBeenCalledWith("item-7");
  });

  it("renders descriptions after the label", () => {
    const items: ScrollSelectItem[] = [
      { value: "a", label: "alpha", description: "first" },
    ];
    const { component } = createComponent(items);
    const lines = component.render(100);
    expect(lines.some((l) => l.includes("alpha") && l.includes("first"))).toBe(true);
  });
});
