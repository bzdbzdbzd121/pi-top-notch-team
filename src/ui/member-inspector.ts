import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, visibleWidth } from "@earendil-works/pi-tui";
import type { MemberProcessHandle } from "../process/member-process";
import type { MemberOperationalState } from "../session/context";
import {
  MemberInspectorState,
  buildBodyLines,
  buildHeaderLine,
  buildFooterStatusLine,
  truncateLine,
  KEY_HINTS_ACTION,
  INPUT_HINTS,
  buildNavHints,
  IDENTITY_THEME,
  type InspectorTheme,
} from "./member-inspector-state";

// ── Member Inspector (TUI glue) ────────────────────────────
//
// Overlay component for the Member Inspector (成员检视浮窗).
// Pure display state lives in member-inspector-state.ts; this file wires
// it to the TUI (overlay, key input, timers) and to member RPC processes
// (get_messages / get_session_stats / prompt / steer / follow_up / abort /
// compact).

// ── Deps ───────────────────────────────────────────────────

export interface MemberInspectorDeps {
  pi: ExtensionAPI;
  /** Current team members (name + label), re-polled while open. */
  getMembers: () => { name: string; label?: string }[];
  getHandle: (name: string) => MemberProcessHandle | undefined;
  memberOpsStates: Map<string, MemberOperationalState>;
  /** Whether the TL agent is currently processing a turn (agent_start..agent_settled). */
  isTlBusy: () => boolean;
}

/** Handle exposed to index.ts for event-hook + lifecycle integration. */
export interface MemberInspectorHandle {
  /** Mark a member's tab dirty (called from the RPC event hook). */
  markDirty(memberName: string): void;
  /**
   * Called when the TL's turn settled (agent_settled): if notifications
   * queued while the TL was busy, start one unified turn for all of them.
   */
  onTlSettled(): void;
  /** Close the overlay programmatically (e.g. /team stop). */
  close(): void;
  isOpen(): boolean;
}

// ── Constants ──────────────────────────────────────────────

/** Throttle window between a dirty mark and a get_messages refetch. */
const REFRESH_THROTTLE_MS = 500;
/** Interval for polling context usage (get_session_stats). */
const STATS_POLL_MS = 5000;
/** Timeout for a single RPC query from the inspector. */
const RPC_TIMEOUT_MS = 3000;
/**
 * Chrome lines around the body: top border(1) + header(1) + separator(1)
 * + separator(1) + footer×3(3) + bottom border(1) = 8.
 * CRITICAL: pi-tui clips overlays with slice(0, maxHeight) — it keeps the
 * TOP lines and drops the BOTTOM ones. If total lines = maxHeight + 1,
 * the bottom border is silently sliced off every render. This count must
 * exactly match the number of non-body lines emitted by render().
 */
const CHROME_LINES = 8;
/** Overlay height fraction of the terminal. */
const OVERLAY_HEIGHT_RATIO = 0.85;

/** Prefix applied to direct user messages so members can tell them apart from TL tasks. */
export const USER_DIRECT_PREFIX = "[用户直接指令（非 TL）]:";

// ── Helpers ────────────────────────────────────────────────

function repeat(ch: string, n: number): string {
  return n > 0 ? ch.repeat(n) : "";
}

function bodyHeight(): number {
  const rows = process.stdout.rows ?? 24;
  const overlayH = Math.min(rows, Math.floor(rows * OVERLAY_HEIGHT_RATIO));
  return Math.max(3, overlayH - CHROME_LINES);
}

// ── openMemberInspector ────────────────────────────────────

/**
 * Open the Member Inspector overlay. Returns a handle IMMEDIATELY (the
 * overlay itself opens asynchronously) so callers can wire event hooks
 * before the first render. The handle stays valid after close —
 * isOpen() reports the current state.
 */
export function openMemberInspector(
  ctx: any,
  deps: MemberInspectorDeps
): MemberInspectorHandle {
  const state = new MemberInspectorState(
    deps.getMembers().map((m) => ({ name: m.name, label: m.label ?? m.name }))
  );

  let component: MemberInspectorComponent | null = null;
  let closed = false;

  const handle: MemberInspectorHandle = {
    markDirty(name: string) {
      component?.markDirty(name);
    },
    onTlSettled() {
      component?.onTlSettled();
    },
    close() {
      closed = true;
      component?.close();
    },
    isOpen() {
      return !closed && component != null && !component.disposed;
    },
  };

  const openPromise = ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (result: null) => void) => {
      component = new MemberInspectorComponent(tui, theme, done, deps, state);
      if (closed) {
        // close() was called before the factory ran — open and immediately close
        component.close();
        return component;
      }
      component.start();
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        width: "90%",
        maxHeight: "85%",
        anchor: "center",
      },
    }
  );

  Promise.resolve(openPromise)
    .catch(() => {})
    .finally(() => {
      closed = true;
      component = null;
    });

  return handle;
}

// ── Component ──────────────────────────────────────────────

export class MemberInspectorComponent {
  disposed = false;

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight refetch guard per member. */
  private fetching = new Set<string>();
  /** Queued nextTurn notifications awaiting the TL's unified turn. */
  private pendingNotifications: string[] = [];
  /** True while a trigger turn has been sent but not yet settled. */
  private triggerPending = false;

  constructor(
    private tui: any,
    private theme: any,
    private done: (result: null) => void,
    private deps: MemberInspectorDeps,
    private state: MemberInspectorState
  ) {}

  // ── Lifecycle ──────────────────────────────────────────

  start(): void {
    // Initial fetch for all tabs (all start dirty)
    this.flushDirty();
    this.scheduleStatsPoll();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.refreshTimer = null;
    this.statsTimer = null;
    // Deliver any queued notifications before the overlay closes,
    // otherwise the TL never learns about the last interventions.
    // Force past triggerPending: a trigger turn may already be in flight
    // (TL idle at first intervention) while later interventions were only
    // queued — they must still reach the TL (pi queues the followUp trigger
    // behind the in-flight turn).
    this.triggerPending = false;
    this.triggerTlTurn();
    this.done(null);
  }

  invalidate(): void {
    // Theme changes: lines are rebuilt on next refresh; nothing cached with colors.
  }

  // ── Dirty marking (member activity events) ─────────────

  markDirty(memberName: string): void {
    const tab = this.state.tabs.find((t) => t.name === memberName);
    if (!tab) return;
    tab.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.flushDirty();
    }, REFRESH_THROTTLE_MS);
  }

  /** Refetch messages for all dirty tabs with running processes. */
  private flushDirty(): void {
    if (this.disposed) return;

    // Reconcile member list (dynamic members may appear mid-session)
    const members = this.deps.getMembers().map((m) => ({
      name: m.name,
      label: m.label ?? m.name,
    }));
    const prevCount = this.state.tabs.length;
    this.state.syncMembers(members);
    if (this.state.tabs.length !== prevCount) {
      // New tabs start dirty — they will be fetched below
    }

    const bh = bodyHeight();
    for (const tab of this.state.tabs) {
      if (!tab.dirty || this.fetching.has(tab.name)) continue;
      const handle = this.deps.getHandle(tab.name);
      const opState = this.deps.memberOpsStates.get(tab.name);
      if (!handle || opState === "stopped" || opState === "crashed") {
        tab.dirty = false;
        continue;
      }
      this.fetching.add(tab.name);
      handle
        .sendCommandAndWait(
          { type: "get_messages" },
          (event: any) =>
            event.type === "response" && event.command === "get_messages",
          RPC_TIMEOUT_MS
        )
        .then((response: any) => {
          const messages = response?.data?.messages ?? [];
          const width = this.lastWidth - 4;
          const lines = buildBodyLines(messages, {
            width: Math.max(20, width),
            expanded: tab.expanded,
            showThinking: tab.showThinking,
            theme: this.inspectorTheme,
          });
          this.state.setTabLines(tab.name, lines, bh);
          this.requestRenderSafe();
        })
        .catch(() => {
          // Timeout/error — clear dirty to avoid a hot retry loop;
          // next activity event will re-mark it.
          tab.dirty = false;
        })
        .finally(() => {
          this.fetching.delete(tab.name);
        });
    }
  }

  private scheduleStatsPoll(): void {
    if (this.disposed) return;
    this.statsTimer = setTimeout(async () => {
      await this.pollStats();
      this.scheduleStatsPoll();
    }, STATS_POLL_MS);
  }

  private async pollStats(): Promise<void> {
    if (this.disposed) return;
    for (const tab of this.state.tabs) {
      if (this.disposed) return;
      const handle = this.deps.getHandle(tab.name);
      const opState = this.deps.memberOpsStates.get(tab.name);
      if (!handle || opState === "stopped" || opState === "crashed") continue;
      try {
        const response: any = await handle.sendCommandAndWait(
          { type: "get_session_stats" },
          (event: any) =>
            event.type === "response" && event.command === "get_session_stats",
          RPC_TIMEOUT_MS
        );
        if (response?.data?.contextUsage) {
          tab.contextInfo = {
            percent: response.data.contextUsage.percent,
            tokens: response.data.contextUsage.tokens,
            contextWindow: response.data.contextUsage.contextWindow,
          };
        }
      } catch {
        // keep previous value
      }
    }
    this.requestRenderSafe();
  }

  private requestRenderSafe(): void {
    if (this.disposed) return;
    try {
      this.tui.requestRender();
    } catch {
      // TUI gone
    }
  }

  /**
   * Queue a TL notification via deliverAs:"nextTurn" — pi holds it for the
   * NEXT turn without starting a turn per notification (the cause of the
   * TL answering one reminder at a time).
   *
   * NO time window: batching is driven purely by the TL's processing state.
   * - TL idle: start one unified turn right away — it consumes everything
   *   queued so far.
   * - TL busy: keep queuing; when the current turn settles (onTlSettled)
   *   one unified turn delivers ALL still-unprocessed notifications.
   * Local footer notices stay immediate.
   */
  private queueTlNotification(content: string): void {
    this.pendingNotifications.push(content);
    try {
      this.deps.pi.sendMessage(
        {
          customType: "team-message",
          content,
          display: true,
        },
        { deliverAs: "nextTurn" }
      );
    } catch {
      // TL channel gone — drop
    }
    if (this.disposed) {
      // Overlay is closing — start the unified turn right away.
      this.triggerTlTurn();
      return;
    }
    if (!this.deps.isTlBusy() && !this.triggerPending) {
      this.triggerTlTurn();
    }
  }

  /**
   * TL turn settled (agent_settled): a unified turn now starts if any
   * notifications were queued while the TL was busy. Also re-arms the
   * trigger so the next idle-time intervention starts a fresh turn.
   */
  onTlSettled(): void {
    if (this.disposed) return;
    this.triggerPending = false;
    if (this.pendingNotifications.length > 0) {
      this.triggerTlTurn();
    }
  }

  /**
   * Start ONE TL turn that consumes all queued nextTurn notifications.
   * triggerTurn (with followUp fallback while streaming) makes the TL
   * handle the whole burst in a single turn.
   */
  private triggerTlTurn(): void {
    if (this.pendingNotifications.length === 0 || this.triggerPending) return;
    const n = this.pendingNotifications.length;
    // Hand the queued messages to pi — the turn about to start injects them.
    this.pendingNotifications = [];
    this.triggerPending = true;
    try {
      this.deps.pi.sendMessage(
        {
          customType: "team-message",
          content: `[Member Inspector] 以上 ${n} 条为用户在检视浮窗中的操作提醒（中断/压缩/直发消息），请统一查看并处理。`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    } catch {
      // TL channel gone — drop
      this.triggerPending = false;
    }
  }

  // ── Send logic ─────────────────────────────────────────

  /**
   * Send the input buffer to the active member.
   * Decision #2: plain text → prompt/follow_up; "/..." → sent raw (member-side
   * command parsing). Decision #5: non-slash messages are prefixed and the TL
   * is notified. Decision #6: busy members get follow_up (Enter) or steer
   * (Ctrl+Enter); crashed/stopped members reject sends.
   */
  private sendInput(mode: "auto" | "steer"): void {
    const tab = this.state.activeTab;
    const text = this.state.inputBuffer.trim();
    if (!tab) return;
    if (!text) {
      this.state.closeInput();
      this.requestRenderSafe();
      return;
    }

    const opState = this.deps.memberOpsStates.get(tab.name);
    const handle = this.deps.getHandle(tab.name);
    if (!handle || opState === "stopped" || opState === "crashed") {
      this.state.notice = `✗ 成员 "${tab.label}" 未运行，无法发送`;
      this.state.closeInput();
      this.requestRenderSafe();
      return;
    }

    const isSlash = text.startsWith("/");
    const payload = isSlash ? text : `${USER_DIRECT_PREFIX}\n${text}`;

    try {
      const busy = opState === "working" || opState === "compacting";
      if (busy) {
        handle.sendCommand({
          type: mode === "steer" ? "steer" : "follow_up",
          message: payload,
        });
      } else {
        handle.sendCommand({ type: "prompt", message: payload });
      }
      this.state.notice =
        opState === "compacting"
          ? `✓ 已排队给 "${tab.label}"（压缩中，将在完成后消化）`
          : busy
          ? mode === "steer"
            ? `✓ 已 steer 给 "${tab.label}"（立即转向）`
            : `✓ 已排队给 "${tab.label}"（follow_up）`
          : `✓ 已发送给 "${tab.label}"`;

      // Notify TL about the direct intervention (decision #5)
      const truncated = text.length > 120 ? text.slice(0, 117) + "..." : text;
      this.queueTlNotification(
        `[Member Inspector] 用户通过检视浮窗直接向成员 "${tab.label}"（${tab.name}）发送了消息：\n${truncated}`
      );
    } catch (err) {
      this.state.notice = `✗ 发送失败：${err instanceof Error ? err.message : String(err)}`;
    }

    this.state.closeInput();
    // The member's subsequent activity events will mark the tab dirty
    this.requestRenderSafe();
  }

  /** Send a control command (abort / compact) to the active member. */
  private sendControl(type: "abort" | "compact"): void {
    const tab = this.state.activeTab;
    if (!tab) return;
    const opState = this.deps.memberOpsStates.get(tab.name);
    const handle = this.deps.getHandle(tab.name);
    if (!handle || opState === "stopped" || opState === "crashed") {
      this.state.notice = `✗ 成员 "${tab.label}" 未运行，无法执行 ${type}`;
      this.requestRenderSafe();
      return;
    }
    try {
      handle.sendCommand({ type });
      this.state.notice = `✓ 已向 "${tab.label}" 发送 ${type}`;
      this.queueTlNotification(
        `[Member Inspector] 用户通过检视浮窗向成员 "${tab.label}"（${tab.name}）执行了 ${type}。`
      );
    } catch (err) {
      this.state.notice = `✗ ${type} 失败：${err instanceof Error ? err.message : String(err)}`;
    }
    this.requestRenderSafe();
  }

  /**
   * Abort ALL members that are currently executing (working / compacting).
   * Idle / stopped / crashed members are skipped. A single TL notification
   * covers the whole batch.
   */
  private sendAbortAll(): void {
    const targets = this.state.tabs.filter((tab) => {
      const opState = this.deps.memberOpsStates.get(tab.name);
      const handle = this.deps.getHandle(tab.name);
      return !!handle && (opState === "working" || opState === "compacting");
    });

    if (targets.length === 0) {
      this.state.notice = "✗ 没有正在执行的成员可中断";
      this.requestRenderSafe();
      return;
    }

    let failed = 0;
    for (const tab of targets) {
      const handle = this.deps.getHandle(tab.name)!;
      try {
        handle.sendCommand({ type: "abort" });
      } catch {
        failed++;
      }
    }
    const labels = targets.map((t) => `"${t.label}"`).join("、");
    this.state.notice =
      failed === 0
        ? `✓ 已中断 ${targets.length} 个成员：${labels}`
        : `✓ 已中断 ${targets.length - failed}/${targets.length} 个成员：${labels}`;
    this.queueTlNotification(
      `[Member Inspector] 用户通过检视浮窗一次性中断了 ${targets.length} 个正在执行的成员：${labels}。`
    );
    this.requestRenderSafe();
  }

  // ── Input handling ─────────────────────────────────────

  handleInput(data: string): void {
    const bh = bodyHeight();

    // ── Input mode ──
    if (this.state.inputOpen) {
      if (matchesKey(data, Key.escape)) {
        this.state.closeInput();
      } else if (matchesKey(data, "ctrl+enter")) {
        this.sendInput("steer");
        return; // sendInput already renders
      } else if (matchesKey(data, Key.enter)) {
        this.sendInput("auto");
        return;
      } else if (matchesKey(data, Key.backspace)) {
        this.state.backspaceInput();
      } else if (matchesKey(data, "ctrl+u")) {
        this.state.clearInput();
      } else if (matchesKey(data, "ctrl+a")) {
        this.state.closeInput();
        this.sendControl("abort");
        return;
      } else if (matchesKey(data, "ctrl+b") || matchesKey(data, "ctrl+shift+a")) {
        this.state.closeInput();
        this.sendAbortAll();
        return;
      } else if (matchesKey(data, "ctrl+o")) {
        this.state.closeInput();
        this.sendControl("compact");
        return;
      } else if (data.length >= 1 && !isControlSequence(data)) {
        this.state.insertInput(data);
      }
      this.requestRenderSafe();
      return;
    }

    // ── Navigation mode ──
    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.state.switchTab(-1);
    } else if (matchesKey(data, Key.right)) {
      this.state.switchTab(1);
    } else if (matchesKey(data, Key.up)) {
      this.state.scrollBy(-3, bh);
    } else if (matchesKey(data, Key.down)) {
      this.state.scrollBy(3, bh);
    } else if (matchesKey(data, Key.pageUp)) {
      this.state.scrollBy(-(bh - 1), bh);
    } else if (matchesKey(data, Key.pageDown)) {
      this.state.scrollBy(bh - 1, bh);
    } else if (matchesKey(data, Key.end)) {
      this.state.scrollToEnd(bh);
    } else if (matchesKey(data, "i") || matchesKey(data, Key.enter)) {
      this.state.openInput();
    } else if (matchesKey(data, "e")) {
      this.state.toggleExpand();
      this.scheduleFlush();
    } else if (matchesKey(data, "t")) {
      this.state.toggleThinking();
      this.scheduleFlush();
    } else if (matchesKey(data, "ctrl+a")) {
      this.sendControl("abort");
      return;
    } else if (matchesKey(data, "ctrl+b") || matchesKey(data, "ctrl+shift+a")) {
      this.sendAbortAll();
      return;
    } else if (matchesKey(data, "ctrl+o")) {
      this.sendControl("compact");
      return;
    }
    this.state.notice = null; // any other key clears the transient notice
    this.requestRenderSafe();
  }

  // ── Rendering ──────────────────────────────────────────

  private lastWidth = 80;

  private get inspectorTheme(): InspectorTheme {
    const t = this.theme;
    return {
      fg: (color: string, text: string) => {
        try {
          return t?.fg ? t.fg(color, text) : text;
        } catch {
          return text;
        }
      },
      bold: (text: string) => {
        try {
          return t?.bold ? t.bold(text) : text;
        } catch {
          return text;
        }
      },
    };
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const theme = this.inspectorTheme;
    const inner = Math.max(20, width - 2);
    const bh = bodyHeight();
    const tab = this.state.activeTab;

    const border = (s: string) => {
      try {
        return this.theme?.fg ? this.theme.fg("borderMuted", s) : s;
      } catch {
        return s;
      }
    };

    // ── Top border with title ──
    // Total width must equal inner+2 like every other frame line
    // (╭─ = 2 cols, ╮ = 1 col → fill = inner - 1 - titleWidth).
    // A wider line gets truncated/wrapped by the overlay, which drops the
    // rounded corner and pushes the bottom border out of view.
    const title = " Member Inspector ";
    const topFill = repeat("─", Math.max(0, inner - 1 - visibleWidth(title)));
    const top = border("╭─") + theme.fg("accent", theme.bold?.(title) ?? title) + border(topFill + "╮");

    // ── Header: tabs ──
    const header = border("│ ") + padVisible(buildHeaderLine(this.state.tabs, this.state.activeIndex, inner - 2, theme), inner - 2) + border(" │");

    // ── Separator ──
    const sep = border("├" + repeat("─", inner) + "┤");

    // ── Body: visible slice of the active tab's lines ──
    const body: string[] = [];
    if (!tab) {
      body.push(padVisible("（无成员）", inner));
    } else {
      const visible = tab.lines.slice(tab.scrollOffset, tab.scrollOffset + bh);
      for (const l of visible) {
        body.push(padVisible(truncateLine(l, inner), inner));
      }
    }
    while (body.length < bh) body.push(repeat(" ", inner));
    const bodyLines = body.map((l) => border("│") + l + border("│"));

    // ── Footer line 1: member statuses / notice / new-below hint ──
    let footer1: string;
    if (this.state.notice) {
      footer1 = " " + this.state.notice;
    } else {
      footer1 = buildFooterStatusLine(this.state.tabs, this.deps.memberOpsStates, inner, theme);
    }
    if (tab?.newBelow) {
      footer1 = footer1 + "  ↓ 有更新";
    }
    const footer1Line = border("│ ") + padVisible(truncateLine(footer1, inner - 2), inner - 2) + border(" │");

    // ── Footer line 2: navigation key hints, or the input box ──
    let footer2: string;
    if (this.state.inputOpen) {
      const label = `> ${this.state.inputBuffer}`;
      footer2 = theme.fg("accent", "✎ ") + truncateLine(label, inner - 4) + "▌";
    } else {
      footer2 = " " + buildNavHints(tab?.expanded ?? false, tab?.showThinking ?? false);
    }
    const footer2Line = border("│ ") + padVisible(truncateLine(footer2, inner - 2), inner - 2) + border(" │");

    // ── Footer line 3: action key hints, or input-mode hints ──
    const footer3 = this.state.inputOpen ? " " + INPUT_HINTS : " " + KEY_HINTS_ACTION;
    const footer3Line = border("│ ") + padVisible(truncateLine(footer3, inner - 2), inner - 2) + border(" │");

    // ── Bottom border ──
    const bottom = border("╰" + repeat("─", inner) + "╯");

    return [top, header, sep, ...bodyLines, sep, footer1Line, footer2Line, footer3Line, bottom];
  }
}

// ── Small render helpers ───────────────────────────────────

function padVisible(text: string, width: number): string {
  const vw = visibleWidth(text);
  return vw >= width ? text : text + repeat(" ", width - vw);
}

/** Heuristic: printable input is 1+ chars that doesn't start with ESC. */
function isControlSequence(data: string): boolean {
  return data.startsWith("\x1b") || data.charCodeAt(0) < 32;
}
