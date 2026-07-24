import {
  Container,
  Input,
  Spacer,
  Text,
  fuzzyFilter,
  getKeybindings,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Scrollable + filterable select dialog built on `ctx.ui.custom`.
 *
 * pi's built-in `ctx.ui.select` renders ALL options without scrolling,
 * which floods the terminal for long lists (e.g. 100+ available models).
 * This component mirrors pi's own /model selector UX:
 *   search input + fuzzy filter + maxVisible window + (n/total) scroll indicator.
 */

export interface ScrollSelectItem {
  /** Value returned when the item is selected. */
  value: string;
  /** Primary display text. */
  label: string;
  /** Secondary info shown in muted color after the label. */
  description?: string;
  /** Extra text used for fuzzy matching (defaults to label + value + description). */
  searchText?: string;
}

export interface ScrollSelectOptions {
  title: string;
  items: ScrollSelectItem[];
  /** Max visible items before scrolling (default 10, same as pi's /model selector). */
  maxVisible?: number;
  /** Initially selected item value (e.g. the current setting). */
  initialValue?: string;
}

// ── Pure helpers (unit-testable without a TUI) ─────────────

/** Compute the visible window [start, end) around the selected index. */
export function computeVisibleRange(
  selectedIndex: number,
  total: number,
  maxVisible: number
): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const visible = Math.max(1, maxVisible);
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visible / 2), total - visible)
  );
  const end = Math.min(start + visible, total);
  return { start, end };
}

/** Fuzzy-filter items by query; empty query returns all items. */
export function filterScrollItems(
  items: ScrollSelectItem[],
  query: string
): ScrollSelectItem[] {
  const q = query.trim();
  if (!q) return items;
  return fuzzyFilter(
    items,
    q,
    (item) =>
      item.searchText ??
      `${item.label} ${item.value}${item.description ? " " + item.description : ""}`
  );
}

// ── Entry point ────────────────────────────────────────────

/**
 * Show a scrollable, filterable select dialog.
 * Resolves with the selected item's value, or undefined on Esc/Ctrl+C.
 */
export async function scrollSelect(
  ctx: ExtensionCommandContext,
  options: ScrollSelectOptions
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    return new ScrollSelectComponent(tui, theme, done, options);
  });
}

// ── Component ──────────────────────────────────────────────

const DEFAULT_MAX_VISIBLE = 10;

export class ScrollSelectComponent extends Container {
  // Focusable implementation — propagate to the search input (IME cursor).
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  private searchInput: Input;
  private listContainer: Container;
  private readonly allItems: ScrollSelectItem[];
  private filtered: ScrollSelectItem[];
  private selectedIndex = 0;
  private readonly maxVisible: number;

  constructor(
    private tui: any,
    private theme: any,
    private done: (result: string | undefined) => void,
    options: ScrollSelectOptions
  ) {
    super();
    this.allItems = options.items;
    this.filtered = options.items;
    this.maxVisible = options.maxVisible ?? DEFAULT_MAX_VISIBLE;

    // Title
    this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
    this.addChild(new Spacer(1));

    // Search input (Enter/Esc fallbacks — primary handling is in handleInput below)
    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.confirmSelection();
    this.searchInput.onEscape = () => this.done(undefined);
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    // List
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    // Key hints
    this.addChild(
      new Text(
        theme.fg("muted", "↑↓ 移动 · PgUp/PgDn 翻页 · Enter 选择 · Esc 取消 · 输入文字筛选"),
        1,
        0
      )
    );

    // Initial selection (e.g. current setting)
    if (options.initialValue !== undefined) {
      const idx = options.items.findIndex((i) => i.value === options.initialValue);
      if (idx >= 0) this.selectedIndex = idx;
    }

    this.updateList();
  }

  // ── Rendering ──────────────────────────────────────────

  private renderItemLine(item: ScrollSelectItem, isSelected: boolean): string {
    const prefix = isSelected ? "→ " : "  ";
    const label = item.label.replace(/[\r\n]+/g, " ").trim();
    const desc = item.description?.replace(/[\r\n]+/g, " ").trim();
    if (isSelected) {
      const base = this.theme.fg("accent", prefix + label);
      return desc ? base + this.theme.fg("muted", ` — ${desc}`) : base;
    }
    const base = this.theme.fg("text", prefix + label);
    return desc ? base + this.theme.fg("muted", ` — ${desc}`) : base;
  }

  private updateList(): void {
    this.listContainer.clear();

    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("muted", "  无匹配项"), 0, 0));
      return;
    }

    const { start, end } = computeVisibleRange(
      this.selectedIndex,
      this.filtered.length,
      this.maxVisible
    );

    for (let i = start; i < end; i++) {
      const item = this.filtered[i];
      if (!item) continue;
      this.listContainer.addChild(
        new Text(this.renderItemLine(item, i === this.selectedIndex), 0, 0)
      );
    }

    // Scroll indicator
    if (start > 0 || end < this.filtered.length) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`),
          0,
          0
        )
      );
    }
  }

  // ── State changes ──────────────────────────────────────

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) return;
    const n = this.filtered.length;
    this.selectedIndex = (((this.selectedIndex + delta) % n) + n) % n;
    this.updateList();
  }

  private applyFilter(): void {
    this.filtered = filterScrollItems(this.allItems, this.searchInput.getValue());
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1)
    );
    this.updateList();
  }

  private confirmSelection(): void {
    const selected = this.filtered[this.selectedIndex];
    if (selected) {
      this.done(selected.value);
    }
  }

  // ── Input handling ─────────────────────────────────────

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (kb.matches(keyData, "tui.select.down")) {
      this.moveSelection(1);
    } else if (kb.matches(keyData, "tui.select.pageUp")) {
      this.moveSelection(-this.maxVisible);
    } else if (kb.matches(keyData, "tui.select.pageDown")) {
      this.moveSelection(this.maxVisible);
    } else if (kb.matches(keyData, "tui.select.confirm")) {
      this.confirmSelection();
    } else if (kb.matches(keyData, "tui.select.cancel")) {
      this.done(undefined);
    } else {
      // Everything else goes to the search input, then re-filter
      this.searchInput.handleInput(keyData);
      this.applyFilter();
    }
  }
}
