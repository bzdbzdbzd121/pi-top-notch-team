/**
 * 阶段 4：冲突差异视图（TUI，方案 §4.8 / §5 阶段 4）。
 *
 * 一屏一个冲突：上方是两侧信息与差异文本（可滚动），下方是选项（三选项或两选项）
 * 与键位提示。差异文本由 decide.ts 生成（系统临时目录 + `git diff --no-index`），
 * 本模块只负责展示与键盘交互。
 *
 * 纯状态（`SyncDiffViewState` + 状态函数）与 TUI 组件分离：状态与文案可在不启动
 * 真实 TUI 的情况下单测（验收 7）。
 */
import { Container, Key, Spacer, Text, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConflictOption } from "../sync/classify";
import type { ConflictChoice } from "../sync/decide";

// ── 纯函数：差异行处理 ──────────────────────────────────────

/** 去掉 git 头噪声、标注两侧文件；保留 @@ 段与 +/-/上下文行。 */
export function normalizeDiffLines(diffText: string): string[] {
  const out: string[] = [];
  for (const raw of diffText.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode")
    ) {
      continue;
    }
    if (raw.startsWith("--- ")) {
      out.push("── 本机版本（-）");
      continue;
    }
    if (raw.startsWith("+++ ")) {
      out.push("── 云端版本（+）");
      continue;
    }
    if (raw.length === 0) continue; // 仅尾行；git 的空上下文行带一个空格前缀
    out.push(raw);
  }
  return out;
}

/** 增删行统计（差异行数计算，用于头部信息）。 */
export function countDiffChanges(lines: string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("──")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** 按可见宽度硬包装（保证「可见行数 = 屏幕行数」，滚动语义稳定）。 */
export function buildDisplayLines(lines: string[], width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const line of lines) {
    if (visibleWidth(line) <= limit) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const ch of line) {
      if (visibleWidth(current + ch) > limit) {
        out.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}

// ── 纯状态 ─────────────────────────────────────────────────

export interface SyncDiffViewInput {
  path: string;
  /** 当前冲突序号（1 起）与总数，用于「冲突 2/3」进度显示。 */
  index: number;
  total: number;
  /** 两侧信息（大小/修改时间等），展示在差异上方。 */
  summaryLines: string[];
  /** 逻辑差异行（未包装）。 */
  diffLines: string[];
  actions: ConflictChoice[];
  /** 包装宽度（默认 100）。 */
  width?: number;
  /** 可见差异行数（默认 16）。 */
  height?: number;
}

export interface SyncDiffViewState {
  path: string;
  index: number;
  total: number;
  summaryLines: string[];
  /** 逻辑差异行（未包装）——按终端宽度重排时以它为准。 */
  logicalLines: string[];
  displayLines: string[];
  actions: ConflictChoice[];
  actionIndex: number;
  offset: number;
  height: number;
  added: number;
  removed: number;
}

export function createSyncDiffViewState(input: SyncDiffViewInput): SyncDiffViewState {
  const width = input.width ?? 100;
  const height = input.height ?? 16;
  const counts = countDiffChanges(input.diffLines);
  return {
    path: input.path,
    index: input.index,
    total: input.total,
    summaryLines: input.summaryLines,
    logicalLines: input.diffLines,
    displayLines: buildDisplayLines(input.diffLines, width),
    actions: input.actions,
    actionIndex: 0,
    offset: 0,
    height: Math.max(1, height),
    added: counts.added,
    removed: counts.removed,
  };
}

function clampOffset(state: SyncDiffViewState, offset: number): number {
  const max = Math.max(0, state.displayLines.length - state.height);
  return Math.min(Math.max(0, offset), max);
}

/**
 * 按新的展示宽度重排（复审建议 #3）：保留用户当前的高亮动作与滚动位置
 * （位置按新行数钳制）。用于组件在真实终端宽度变化时重新包装。
 */
export function reflowSyncDiffView(state: SyncDiffViewState, width: number): SyncDiffViewState {
  const reflowed: SyncDiffViewState = {
    ...state,
    displayLines: buildDisplayLines(state.logicalLines, Math.max(10, width)),
  };
  return { ...reflowed, offset: clampOffset(reflowed, state.offset) };
}

export function scrollSyncDiffView(state: SyncDiffViewState, delta: number): SyncDiffViewState {
  return { ...state, offset: clampOffset(state, state.offset + delta) };
}

export function moveSyncDiffAction(state: SyncDiffViewState, delta: number): SyncDiffViewState {
  const n = state.actions.length;
  if (n === 0) return state;
  return { ...state, actionIndex: (((state.actionIndex + delta) % n) + n) % n };
}

/** 当前可见的差异行（不足一屏时原样返回）。 */
export function syncDiffVisibleLines(state: SyncDiffViewState): string[] {
  return state.displayLines.slice(state.offset, state.offset + state.height);
}

// ── 纯函数：文案 ───────────────────────────────────────────

export function formatSyncDiffHeader(state: SyncDiffViewState): string[] {
  const lines: string[] = [
    `☁️ 冲突 ${state.index}/${state.total}：${state.path}`,
    ...state.summaryLines,
  ];
  if (state.displayLines.length === 0) {
    lines.push("  （两侧内容一致或差异不可用）");
  } else {
    const max = Math.max(0, state.displayLines.length - state.height);
    lines.push(
      `  差异 +${state.added}/-${state.removed}${max > 0 ? `　滚动 ${state.offset}/${max}` : ""}`
    );
  }
  return lines;
}

export function formatSyncDiffActions(state: SyncDiffViewState): string {
  return state.actions
    .map((action, i) => `${i === state.actionIndex ? "▶" : " "} ${i + 1}) ${action.label}`)
    .join("\n");
}

export function formatSyncDiffHints(): string {
  return "↑↓ 滚动 · PgUp/PgDn 翻页 · ←→ 或 1/2/3 选动作 · Enter 确认 · Esc 取消（整个同步）";
}

// ── TUI 组件 ───────────────────────────────────────────────

export class SyncDiffViewComponent extends Container {
  private state: SyncDiffViewState;
  private readonly input: SyncDiffViewInput;
  private renderWidth: number;

  constructor(
    private tui: { requestRender?: () => void },
    private theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
    private done: (result: ConflictOption | undefined) => void,
    input: SyncDiffViewInput
  ) {
    super();
    this.input = input;
    this.state = createSyncDiffViewState(input);
    this.renderWidth = input.width ?? 100;
    this.renderAll();
  }

  /**
   * pi-tui 组件契约：按真实终端宽度渲染（复审建议 #3）。
   * 宽度变化时按新宽度重排差异行（此前是固定 100 列预包装 + 死代码 setWidth，
   * 窄终端下 Text 会二次换行 → 「可见行数 = 屏幕行数」的滚动语义不成立）。
   * 重排保留滚动位置（钳制）与用户已高亮的动作，避免 resize 后回车提交错动作。
   */
  render(width: number): string[] {
    const inner = Math.max(10, width - 2); // Text 左侧 padding 1
    if (this.renderWidth !== inner) {
      this.renderWidth = inner;
      this.state = reflowSyncDiffView(this.state, inner);
      this.renderAll();
    }
    return super.render(width);
  }

  getState(): SyncDiffViewState {
    return this.state;
  }

  private renderAll(): void {
    this.clear();
    for (const line of formatSyncDiffHeader(this.state)) {
      this.addChild(new Text(this.theme.fg("accent", line), 1, 0));
    }
    this.addChild(new Spacer(1));
    const visible = syncDiffVisibleLines(this.state);
    if (visible.length === 0) {
      this.addChild(new Text(this.theme.fg("muted", "  （无差异内容）"), 1, 0));
    }
    for (const line of visible) {
      const color = line.startsWith("+") && !line.startsWith("+++") ? "success" : line.startsWith("-") && !line.startsWith("---") ? "error" : line.startsWith("@@") ? "accent" : "text";
      const plain = line.startsWith("──") ? line : line;
      this.addChild(new Text(this.theme.fg(color, plain), 1, 0));
    }
    this.addChild(new Spacer(1));
    const actions = formatSyncDiffActions(this.state).split("\n");
    for (const line of actions) {
      const selected = line.startsWith("▶");
      this.addChild(new Text(selected ? this.theme.fg("accent", this.theme.bold(line)) : this.theme.fg("text", line), 1, 0));
    }
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("muted", formatSyncDiffHints()), 1, 0));
  }

  handleInput(keyData: string): void {
    const digits = /^([1-9])$/.exec(keyData);
    if (matchesKey(keyData, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(keyData, Key.enter) || keyData === "\n") {
      const action = this.state.actions[this.state.actionIndex];
      this.done(action?.value);
      return;
    }
    if (matchesKey(keyData, Key.up)) this.state = scrollSyncDiffView(this.state, -1);
    else if (matchesKey(keyData, Key.down)) this.state = scrollSyncDiffView(this.state, 1);
    else if (matchesKey(keyData, Key.pageUp)) this.state = scrollSyncDiffView(this.state, -this.state.height);
    else if (matchesKey(keyData, Key.pageDown)) this.state = scrollSyncDiffView(this.state, this.state.height);
    else if (matchesKey(keyData, Key.home)) this.state = { ...this.state, offset: 0 };
    else if (matchesKey(keyData, Key.end)) this.state = scrollSyncDiffView(this.state, this.state.displayLines.length);
    else if (matchesKey(keyData, Key.left)) this.state = moveSyncDiffAction(this.state, -1);
    else if (matchesKey(keyData, Key.right) || keyData === "\t") this.state = moveSyncDiffAction(this.state, 1);
    else if (digits) {
      const index = Number.parseInt(digits[1], 10) - 1;
      if (index < this.state.actions.length) this.state = { ...this.state, actionIndex: index };
    } else {
      return; // 其它按键忽略
    }
    this.renderAll();
    this.tui.requestRender?.();
  }
}

// ── 入口 ───────────────────────────────────────────────────

/**
 * 打开冲突差异视图（TUI）。返回用户选择的动作；Esc/无 UI → undefined（调用方按
 * 「取消整个同步」处理，零改动）。
 */
export async function showSyncDiffView(
  ctx: ExtensionCommandContext,
  input: SyncDiffViewInput
): Promise<ConflictOption | undefined> {
  const custom = (ctx.ui as { custom?: unknown }).custom;
  if (typeof custom !== "function") return undefined;
  const result = await ctx.ui.custom<ConflictOption | undefined>(
    (tui: unknown, theme: unknown, _kb: unknown, done: (value: ConflictOption | undefined) => void) =>
      new SyncDiffViewComponent(
        tui as { requestRender?: () => void },
        theme as SyncDiffViewComponent["theme"],
        done,
        input
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        maxHeight: "85%",
        anchor: "center",
      },
    }
  );
  return result ?? undefined;
}
