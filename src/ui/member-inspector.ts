import { matchesKey, Key, visibleWidth } from "@earendil-works/pi-tui";
// CSI-u 解码纪律：任何字符插入路径必须经 decodePrintableKey（与 pi 主输入框
// editor.js 一致——它同样深导入 keys.js）。主 index 只 re-export 了
// decodeKittyPrintable；deep import 覆盖 kitty CSI-u + modifyOtherKeys 两种
// 协议，且与上游 editor 行为完全对齐（一致性即正确性）。
import { decodePrintableKey } from "@earendil-works/pi-tui/dist/keys.js";
import type { MemberProcessHandle } from "../process/member-process";
import type { MemberOperationalState } from "../session/context";
import {
  MemberInspectorState,
  buildBodyLinesIncremental,
  canIncrementCache,
  createBodyBuildCache,
  fitLinesIncremental,
  buildHeaderLine,
  buildFooterStatusLine,
  truncateLine,
  nextStreamFlushDelay,
  KEY_HINTS_ACTION,
  INPUT_HINTS,
  buildNavHints,
  IDENTITY_THEME,
  type BodyBuildCache,
  type BuildBodyOptions,
  type InspectorTab,
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
  /** Current team members (name + label), re-polled while open. */
  getMembers: () => { name: string; label?: string }[];
  getHandle: (name: string) => MemberProcessHandle | undefined;
  memberOpsStates: Map<string, MemberOperationalState>;
}

/** Handle exposed to index.ts for event-hook + lifecycle integration. */
export interface MemberInspectorHandle {
  /** Mark a member's tab dirty (called from the RPC event hook). */
  markDirty(memberName: string): void;
  /**
   * Full member RPC event (message_start / message_update / message_end /
   * agent_end / ...). Routes streaming deltas to the live-tail path and
   * everything else to the dirty/refetch path.
   */
  onMemberEvent(memberName: string, event: any): void;
  /** Close the overlay programmatically (e.g. /team stop). */
  close(): void;
  isOpen(): boolean;
}

// ── Constants ──────────────────────────────────────────────

/** Throttle window between a dirty mark and a get_messages refetch. */
const REFRESH_THROTTLE_MS = 500;
/**
 * Coalescing window for stream deltas (message_update): the live tail is
 * rebuilt + rendered at this cadence while deltas arrive — much faster than
 * the RPC refetch path and with zero RPC traffic. Each rebuild is O(Δ) via
 * the incremental cache + the P2 append-only wrap cache. This is the MINIMUM
 * delay — the actual cadence adapts (see STREAM_FLUSH_MAX_MS).
 */
const STREAM_FLUSH_MS = 100;
/**
 * P2: upper bound for the adaptive stream cadence. When a rebuild eats over
 * half the current interval (huge delta bursts, cold caches), the delay
 * doubles up to this cap; cheap rebuilds recover toward STREAM_FLUSH_MS.
 */
const STREAM_FLUSH_MAX_MS = 1000;
/** Interval for polling context usage (get_session_stats). */
const STATS_POLL_MS = 5000;
/** Timeout for a single RPC query from the inspector. */
const RPC_TIMEOUT_MS = 3000;
/**
 * P1-④: interaction window — flushes and background renders are suspended
 * while the user is scrolling/typing (this long after the last key event)
 * so rebuilds never fight the user's input; the deferred flush fires once
 * the window closes.
 */
const INTERACTION_GRACE_MS = 800;
/**
 * P1-④: full-rebuild slice size. A full rebuild of a huge history is
 * executed in slices of this many messages, yielding to the event loop
 * between slices (setTimeout(0)) so key events are never starved by a
 * long synchronous build. The incremental path is cheap and stays
 * synchronous.
 */
const CHUNK_SIZE = 100;
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
    onMemberEvent(name: string, event: any) {
      component?.onMemberEvent(name, event);
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
  /** Stream-delta coalescing timer (live tail rebuilds, no RPC). */
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  /** P2: adaptive stream cadence (backs off / recovers with rebuild cost). */
  private streamFlushDelayMs = STREAM_FLUSH_MS;
  /** P1-④/S2: compensation render pending for a suspended background render. */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** P1-④: timestamp of the last key event (interaction window clock). */
  private lastInteractionAt = 0;
  /** In-flight refetch guard per member. */
  private fetching = new Set<string>();
  /** P1-③ per-tab incremental build caches (append-only prefix reuse). */
  private bodyCaches = new Map<string, BodyBuildCache>();
  /**
   * Last RPC-fetched message history per member — the base the live tail
   * (pending completions + in-progress message) is appended to for streaming
   * renders without waiting for the next get_messages round-trip.
   */
  private lastMessages = new Map<string, any[]>();
  /**
   * P2-③: per-tab cached `buildMessages` array (history + pending + live).
   * Rebuilt only when the pieces actually change (refetch replaces history,
   * message_end/agent_end change pending/live) — the streaming flush reuses
   * the same array instead of re-spreading O(history) every 100ms.
   */
  private buildMessagesCache = new Map<
    string,
    { msgs: any[]; history: any[]; pendingLen: number; live: any }
  >();

  /**
   * P2-③: assemble [history, ...pending, ...(live ? [live] : [])] with a
   * per-tab cached array — incremental appends instead of a full spread per
   * flush. Cache is keyed by the exact (history ref, pending length, live
   * ref) triple, so any structural change rebuilds exactly once; the
   * streaming flush (same pieces) reuses the cached array at O(1).
   */
  private getBuildMessages(name: string, history: any[], pending: any[], live: any): any[] {
    if (pending.length === 0 && !live) return history; // plain history — no assembly
    const c = this.buildMessagesCache.get(name);
    if (c && c.history === history && c.pendingLen === pending.length && c.live === live) {
      return c.msgs;
    }
    const msgs = [...history, ...pending, ...(live ? [live] : [])];
    this.buildMessagesCache.set(name, { msgs, history, pendingLen: pending.length, live });
    return msgs;
  }

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
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.refreshTimer = null;
    this.statsTimer = null;
    this.renderTimer = null;
    this.streamTimer = null;
    this.bodyCaches.clear();
    this.lastMessages.clear();
    this.done(null);
  }

  invalidate(): void {
    // P1-①: resize / theme change may have invalidated the build-time fixed
    // width contract (lines were padded to the old inner width). Mark ALL
    // tabs dirty so the next throttled flush rebuilds them at the new width.
    // P1-③ (B1): also drop the incremental caches. Theme preview/switch
    // routes through here (pi-tui overlay invalidate), and the cached prefix
    // lines have theme colours baked in at build time — reusing them would
    // leave a stale-colour body next to freshly-themed chrome. The cost is
    // one full rebuild on the next flush, which happens anyway for width
    // changes.
    if (this.disposed) return;
    this.bodyCaches.clear();
    for (const tab of this.state.tabs) tab.dirty = true;
    this.scheduleFlush();
  }

  // ── Dirty marking (member activity events) ─────────────

  /**
   * Full-event router for the RPC activity hook. Streaming deltas
   * (message_start / message_update / message_end) are assembled into the
   * live tail and rendered locally at STREAM_FLUSH_MS — no RPC refetch per
   * delta. All other events keep the legacy dirty → throttled refetch path.
   */
  onMemberEvent(memberName: string, event: any): void {
    if (this.disposed) return;
    const tab = this.state.tabs.find((t) => t.name === memberName);
    if (!tab) return;
    switch (event?.type) {
      case "message_start":
        if (event.message?.role === "assistant") {
          this.state.setLiveMessage(memberName, event.message);
          this.scheduleStreamFlush();
        } else {
          // user / toolResult message started — completed messages arrive via
          // the refetch path (message_end below re-marks dirty).
          this.markDirty(memberName);
        }
        return;
      case "message_update":
        if (event.assistantMessageEvent) {
          this.state.applyLiveDelta(memberName, event.assistantMessageEvent);
          this.scheduleStreamFlush();
        }
        return;
      case "message_end":
        if (event.message?.role === "assistant") {
          // Keep the authoritative message visible (pending completion) until
          // the refetch confirms it in history — no end-of-message flicker.
          this.state.completeLiveMessage(memberName, event.message);
          this.scheduleStreamFlush();
        }
        this.markDirty(memberName); // refetch: completed message lands in history
        return;
      case "agent_end":
        this.state.clearStreaming(memberName);
        this.markDirty(memberName);
        return;
      default:
        this.markDirty(memberName);
    }
  }

  markDirty(memberName: string): void {
    const tab = this.state.tabs.find((t) => t.name === memberName);
    if (!tab) return;
    tab.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(delay: number = REFRESH_THROTTLE_MS): void {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.flushDirty();
    }, delay);
  }

  /**
   * P1-④: true while the interaction window is open (a key event happened
   * less than INTERACTION_GRACE_MS ago). Flushes and background renders are
   * suspended in this window so rebuilds never interrupt scrolling/typing.
   */
  private inInteractionWindow(): boolean {
    return Date.now() - this.lastInteractionAt < INTERACTION_GRACE_MS;
  }

  /** Refetch messages for all dirty tabs with running processes. */
  private flushDirty(): void {
    if (this.disposed) return;

    // P1-④: suspend while the user is interacting. Dirty flags are kept
    // (markDirty during the window stays pending), and the flush is
    // re-deferred until the window closes — then it runs exactly once.
    if (this.inInteractionWindow()) {
      this.scheduleFlush(INTERACTION_GRACE_MS);
      return;
    }

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
    // Drop incremental caches for tabs whose members no longer exist
    // (dynamic member removed mid-session).
    const live = new Set(this.state.tabs.map((t) => t.name));
    for (const k of this.bodyCaches.keys()) {
      if (!live.has(k)) this.bodyCaches.delete(k);
    }
    for (const k of this.buildMessagesCache.keys()) {
      if (!live.has(k)) this.buildMessagesCache.delete(k);
    }

    const bh = bodyHeight();
    for (const tab of this.state.tabs) {
      if (!tab.dirty || this.fetching.has(tab.name)) continue;
      const handle = this.deps.getHandle(tab.name);
      const opState = this.deps.memberOpsStates.get(tab.name);
      if (!handle || opState === "stopped" || opState === "crashed") {
        // Stopped/crashed members have NO new data source — if a history
        // cache exists it is the authoritative full set, so a global e/t
        // toggle rebuilds locally (zero RPC). Without a cache there is
        // nothing to render: clear the dirty mark and skip.
        if (this.lastMessages.has(tab.name)) {
          this.rebuildTabFromCache(tab);
        } else {
          tab.dirty = false;
        }
        continue;
      }
      this.fetching.add(tab.name);
      // Consume the dirty mark NOW — marks arriving DURING the fetch
      // (e/t toggle, member activity in the chunked-build yield gaps)
      // re-set it, and .then can tell "pending" apart from "stale".
      tab.dirty = false;
      handle
        .sendCommandAndWait(
          { type: "get_messages" },
          (event: any) =>
            event.type === "response" && event.command === "get_messages",
          RPC_TIMEOUT_MS
        )
        .then(async (response: any) => {
          // P1-④/S3: the overlay may have been closed while the fetch was
          // in flight — do not commit or render into a dead component.
          if (this.disposed) return;
          const messages = response?.data?.messages ?? [];
          // Keep the fetched history as the streaming base (live tail renders
          // from it without waiting for the next refetch).
          this.lastMessages.set(tab.name, messages);
          // Completed messages that were shown as pending are now confirmed
          // in history — drop them so they render exactly once.
          this.state.reconcilePending(tab.name, messages);
          const width = this.lastWidth - 4;
          // P1-③: incremental body build — reuse the per-tab cache when the
          // history is append-only (boundary fingerprint guard inside), else
          // full rebuild. Byte-identical output in both modes.
          let cache = this.bodyCaches.get(tab.name);
          if (!cache) {
            cache = createBodyBuildCache();
            this.bodyCaches.set(tab.name, cache);
          }
          const opts = {
            width: Math.max(20, width),
            expanded: this.state.expanded,
            showThinking: this.state.showThinking,
            theme: this.inspectorTheme,
          };
          // Streaming tail: pending completions + the in-progress message are
          // appended after the fetched history (the incremental cache treats
          // the last element as the streaming tail and rebuilds it every
          // flush — the live path needs no special handling). P2-③: the
          // assembled array is cached per tab — the streaming flush reuses
          // it instead of re-spreading O(history) every 100ms.
          const buildMessages = this.getBuildMessages(
            tab.name,
            messages,
            tab.pendingCompletions,
            tab.live
          );
          // P1-④: route large FULL rebuilds through the chunked path — the
          // build runs in slices of CHUNK_SIZE messages, yielding to the
          // event loop between slices so key events are never starved by a
          // long synchronous rebuild. Incremental refreshes (the common
          // case) stay synchronous: O(增量) is cheap.
          const raw = canIncrementCache(cache, buildMessages, opts)
            ? buildBodyLinesIncremental(cache, buildMessages, opts)
            : await this.buildBodyLinesChunked(cache, buildMessages, opts);
          // P1-④/B1: a dirty mark that arrived DURING the fetch (e/t toggle,
          // member activity while the chunked build yields) must not be
          // silently consumed by setTabLines — capture it first, then
          // re-flush once with the fresh opts/messages.
          const pending = tab.dirty;
          // P2-①: fit only the new tail (incremental) or everything (full),
          // then P2-③ local-append into the tab's STABLE lines array
          // (render() slices it verbatim — zero per-frame width tax).
          const fitted = fitLinesIncremental(
            cache,
            raw,
            Math.max(20, this.lastWidth - 2)
          );
          this.state.setTabLines(tab.name, fitted.lines, bh, fitted.changed);
          if (pending) {
            // Re-enqueue: setTabLines consumed the flag, and flushDirty
            // only picks up dirty tabs — restore it so the catch-up flush
            // rebuilds with the fresh opts/messages.
            tab.dirty = true;
            this.scheduleFlush();
          }
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

  /**
   * Coalesced stream flush: rebuilds the live tail (pending completions +
   * in-progress message) from the last fetched history at STREAM_FLUSH_MS
   * cadence — zero RPC traffic per delta. Incremental tail rebuilds are
   * O(tail); the full path only runs on a cold cache (inspector opened
   * mid-stream) and is a one-off.
   */
  private scheduleStreamFlush(): void {
    if (this.streamTimer || this.disposed) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      this.flushStreaming();
    }, this.streamFlushDelayMs);
  }

  private flushStreaming(): void {
    if (this.disposed) return;
    // P1-④: same interaction-window suspension as flushDirty — the rebuild
    // is re-deferred while the user scrolls/types, dirty flags stay set.
    if (this.inInteractionWindow()) {
      this.scheduleStreamFlush();
      return;
    }
    const bh = bodyHeight();
    // P2: only the ACTIVE tab's live tail is rebuilt. Inactive tabs are not
    // visible — their deltas keep accumulating in state and their lines catch
    // up on tab switch (handleInput calls flushStreaming) or via the refetch
    // path (message_end / agent_end markDirty → flushDirty covers all tabs).
    // N concurrently streaming members no longer multiply the rebuild cost.
    const tab = this.state.activeTab;
    const started = Date.now();
    if (tab && (tab.live || tab.pendingCompletions.length > 0)) {
      const messages = this.lastMessages.get(tab.name) ?? [];
      let cache = this.bodyCaches.get(tab.name);
      if (!cache) {
        cache = createBodyBuildCache();
        this.bodyCaches.set(tab.name, cache);
      }
      const opts = {
        width: Math.max(20, this.lastWidth - 4),
        expanded: this.state.expanded,
        showThinking: this.state.showThinking,
        theme: this.inspectorTheme,
      };
      const buildMessages = this.getBuildMessages(
        tab.name,
        messages,
        tab.pendingCompletions,
        tab.live
      );
      const raw = buildBodyLinesIncremental(cache, buildMessages, opts);
      // Same dirty-flag protection as flushDirty: a markDirty that arrived
      // while we built must not be consumed by setTabLines — restore it so
      // the refetch path still runs.
      const pending = tab.dirty;
      // P2-①③: fit only the new tail, local-append into the stable array.
      const fitted = fitLinesIncremental(
        cache,
        raw,
        Math.max(20, this.lastWidth - 2)
      );
      this.state.setTabLines(tab.name, fitted.lines, bh, fitted.changed);
      if (pending) {
        tab.dirty = true;
        this.scheduleFlush();
      }
    }
    // P2: adapt the cadence to the measured rebuild cost (hysteresis band
    // inside nextStreamFlushDelay keeps it stable between adjustments).
    this.streamFlushDelayMs = nextStreamFlushDelay(
      this.streamFlushDelayMs,
      Date.now() - started,
      STREAM_FLUSH_MS,
      STREAM_FLUSH_MAX_MS
    );
    this.requestRenderSafe();
  }

  /**
   * P1 (global toggles): rebuild a stopped/crashed tab's display lines from
   * the last RPC-fetched history — zero RPC. A stopped/crashed member cannot
   * produce new messages, so `lastMessages` is the authoritative full set and
   * the local rebuild is always consistent with the current global e/t state
   * (the exact inconsistency globalizing the toggles would otherwise expose:
   * a stale collapsed render on a tab whose member is no longer fetchable).
   * Mirrors the flushStreaming build (incremental cache + streaming tail +
   * fixed-width contract) so toggles land identically on every tab.
   */
  private rebuildTabFromCache(tab: InspectorTab): void {
    const messages = this.lastMessages.get(tab.name) ?? [];
    let cache = this.bodyCaches.get(tab.name);
    if (!cache) {
      cache = createBodyBuildCache();
      this.bodyCaches.set(tab.name, cache);
    }
    const opts = {
      width: Math.max(20, this.lastWidth - 4),
      expanded: this.state.expanded,
      showThinking: this.state.showThinking,
      theme: this.inspectorTheme,
    };
    const buildMessages = this.getBuildMessages(
      tab.name,
      messages,
      tab.pendingCompletions,
      tab.live
    );
    const raw = buildBodyLinesIncremental(cache, buildMessages, opts);
    const fitted = fitLinesIncremental(
      cache,
      raw,
      Math.max(20, this.lastWidth - 2)
    );
    this.state.setTabLines(tab.name, fitted.lines, bodyHeight(), fitted.changed);
    this.requestRenderSafe();
  }

  /**
   * P1-④: chunked full rebuild. Slices of CHUNK_SIZE messages are appended
   * through the shared incremental builder (slice k covers messages
   * [0, k·CHUNK_SIZE), growing the per-tab cache), yielding to the event
   * loop between slices via setTimeout(0) — key events stay responsive
   * during huge rebuilds. The final slice covers the whole history and
   * returns lines byte-identical to a single synchronous full build; the
   * intermediate slices only advance the cache and never reach the UI
   * (setTabLines runs once, after the last slice). The tab stays in the
   * fetching set for the whole run, so re-entrant flushes are blocked.
   */
  private async buildBodyLinesChunked(
    cache: BodyBuildCache,
    messages: any[],
    opts: BuildBodyOptions
  ): Promise<{ lines: string[]; added: string[]; tailLen: number; mode: "full" | "incremental" }> {
    const total = messages.length;
    for (let end = CHUNK_SIZE; end < total; end += CHUNK_SIZE) {
      // Grow the cache to messages[0..end) (first slice = full on a cold
      // cache, later slices = incremental appends — same builder). The
      // index bound avoids a per-slice array copy (S4).
      buildBodyLinesIncremental(cache, messages, opts, end);
      // Yield to the event loop so key events are not starved.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.disposed) return { lines: cache.lines, added: [], tailLen: 0, mode: "full" }; // overlay closed mid-build
    }
    // Final slice: whole history, streaming tail included.
    return buildBodyLinesIncremental(cache, messages, opts);
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

  private requestRenderSafe(interactive = false): void {
    if (this.disposed) return;
    // P1-④: background-triggered renders (flush completion, stats poll) are
    // suspended inside the interaction window — the user's own key-feedback
    // renders (interactive=true) always pass through.
    if (interactive || !this.inInteractionWindow()) {
      try {
        this.tui.requestRender();
      } catch {
        // TUI gone
      }
      return;
    }
    // P1-④/S2: a suspended background render is deferred, not dropped —
    // schedule a compensation render once the window closes (re-deferred
    // if the user keeps interacting).
    if (this.renderTimer) return; // one compensation render suffices
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (this.disposed) return;
      this.requestRenderSafe(); // re-check the window; re-defer if still open
    }, INTERACTION_GRACE_MS);
  }

  // ── Send logic ─────────────────────────────────────────

  /**
   * Send the input buffer to the active member.
   * Decision #2: plain text → prompt/follow_up; "/..." → sent raw (member-side
   * command parsing). Decision #5: non-slash messages are prefixed so the
   * Member can distinguish the source. Decision #6: busy members get
   * follow_up (Enter) or steer (Ctrl+Enter); crashed/stopped members reject
   * sends.
   */
  private sendInput(mode: "auto" | "steer"): void {
    const tab = this.state.activeTab;
    const text = this.state.inputBuffer.trim();
    if (!tab) {
      // 静默早退显式化（边界 D）：动态模式 0 成员时浮窗可打开但无成员可发。
      // 原实现纯 return 零提示——notice 必须配 render 才可见。
      this.state.notice = "✗ 无成员可发送";
      this.requestRenderSafe(true);
      return;
    }
    if (!text) {
      // 静默路径显式化：空文本直接 close 会让用户觉得"没反应"（kitty 协议
      // 终端下打字进不去时恰会命中这里）——先提示再关闭。
      this.state.notice = "输入为空";
      this.state.closeInput();
      this.requestRenderSafe(true);
      return;
    }

    const opState = this.deps.memberOpsStates.get(tab.name);
    const handle = this.deps.getHandle(tab.name);
    if (!handle || opState === "stopped" || opState === "crashed") {
      this.state.notice = `✗ 成员 "${tab.label}" 未运行，无法发送`;
      this.state.closeInput();
      this.requestRenderSafe(true);
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
    } catch (err) {
      this.state.notice = `✗ 发送失败：${err instanceof Error ? err.message : String(err)}`;
    }

    this.state.closeInput();
    // The member's subsequent activity events will mark the tab dirty
    this.requestRenderSafe(true);
  }

  /** Send a control command (abort / compact) to the active member. */
  private sendControl(type: "abort" | "compact"): void {
    const tab = this.state.activeTab;
    if (!tab) return;
    const opState = this.deps.memberOpsStates.get(tab.name);
    const handle = this.deps.getHandle(tab.name);
    if (!handle || opState === "stopped" || opState === "crashed") {
      this.state.notice = `✗ 成员 "${tab.label}" 未运行，无法执行 ${type}`;
      this.requestRenderSafe(true);
      return;
    }
    try {
      handle.sendCommand({ type });
      this.state.notice = `✓ 已向 "${tab.label}" 发送 ${type}`;
    } catch (err) {
      this.state.notice = `✗ ${type} 失败：${err instanceof Error ? err.message : String(err)}`;
    }
    this.requestRenderSafe(true);
  }

  /**
   * Abort ALL members that are currently executing (working / compacting).
   * Idle / stopped / crashed members are skipped.
   */
  private sendAbortAll(): void {
    const targets = this.state.tabs.filter((tab) => {
      const opState = this.deps.memberOpsStates.get(tab.name);
      const handle = this.deps.getHandle(tab.name);
      return !!handle && (opState === "working" || opState === "compacting");
    });

    if (targets.length === 0) {
      this.state.notice = "✗ 没有正在执行的成员可中断";
      this.requestRenderSafe(true);
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
    this.requestRenderSafe(true);
  }

  // ── Input handling ─────────────────────────────────────

  handleInput(data: string): void {
    const bh = bodyHeight();
    // P1-④: browsing (scrolling) and typing open the interaction window —
    // their flushes/renders are suspended so rebuilds never fight the user
    // mid-scroll or mid-typing. Deliberate view switches (e/t, tab change)
    // and control commands do NOT open the window: their refresh is the
    // user's explicit intent and must run immediately.
    if (this.state.inputOpen || isScrollKey(data)) {
      this.lastInteractionAt = Date.now();
    }

    // ── Input mode ──
    if (this.state.inputOpen) {
      if (matchesKey(data, Key.escape)) {
        this.state.closeInput();
      } else if (
        matchesKey(data, "ctrl+enter") ||
        matchesKey(data, "alt+enter")
      ) {
        // 双绑定（场景 L）：ctrl+enter 依赖终端协议（kitty CSI-u /
        // modifyOtherKeys），legacy 终端两者同字节（\r）不可区分——alt+enter
        // 提供协议无关的 steer 路径。steer 分支必须先于 enter 分支。
        this.sendInput("steer");
        return; // sendInput already renders
      } else if (matchesKey(data, Key.enter) || data === "\n") {
        // `\n` 兜底：kitty 协议激活后 pi-tui 不再将 `\n` 识别为 enter（被当作
        // shift+enter 映射），LF 编码混合终端下会吞键——字面单字节兜底放行。
        // 非 kitty 下 matchesKey 已覆盖，此处幂等。
        // ⚠️ 必须位于任何未来 ctrl+j 分支之后（legacy 终端 ctrl+j 即 \n）。
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
      } else {
        // CSI-u 解码（场景 K 主线）：kitty 键盘协议 flag 1（disambiguate）激活后
        // 所有按键均编码为 CSI-u（按 a → \x1b[97u），不解码则文字永远进不去。
        // decodePrintableKey 仅接受纯字符/Shift 字符：ctrl/alt 修饰序列返回
        // undefined（不劫持上方的 ctrl+enter/enter 匹配——分支顺序双保险），
        // legacy 原字符也返回 undefined（走下方兜底，零影响）。
        const printable = decodePrintableKey(data);
        if (printable !== undefined) {
          this.state.insertInput(printable); // kitty CSI-u / modifyOtherKeys 字符 → 解码后插入
        } else if (data.length >= 1 && !isControlSequence(data)) {
          this.state.insertInput(data); // legacy 原字符兜底（零影响）
        }
      }
      this.requestRenderSafe(true);
      return;
    }

    // ── Navigation mode ──
    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.state.switchTab(-1);
      // P2: inactive tabs skip streaming rebuilds — catch up the newly
      // active tab's live tail immediately (O(Δ) via the wrap cache).
      this.flushStreaming();
    } else if (matchesKey(data, Key.right)) {
      this.state.switchTab(1);
      this.flushStreaming();
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
      // P1-④/S1: the expand intent is explicit — clear the interaction
      // window so the refresh runs immediately, even mid-scroll.
      this.lastInteractionAt = 0;
      this.scheduleFlush();
    } else if (matchesKey(data, "t")) {
      this.state.toggleThinking();
      this.lastInteractionAt = 0;
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
    this.requestRenderSafe(true);
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
    // P1-①: detect terminal width changes. The build-time fixed-width contract
    // ties line widths to the last render width — after a resize the cached
    // lines are padded for the old width, so trigger a rebuild.
    if (width !== this.lastWidth) {
      this.lastWidth = width;
      for (const tab of this.state.tabs) tab.dirty = true;
      this.scheduleFlush();
    } else {
      this.lastWidth = width;
    }
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
    // P1-①: emit VERBATIM. Lines were fixed-widthed at build time
    // (fitLinesToWidth) so the right border stays aligned; no truncateLine /
    // padVisible here — the scroll hot path does ZERO width computation.
    const body: string[] = [];
    if (!tab) {
      body.push(padVisible("（无成员）", inner));
    } else {
      const visible = tab.lines.slice(tab.scrollOffset, tab.scrollOffset + bh);
      body.push(...visible);
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
      footer2 = " " + buildNavHints(this.state.expanded, this.state.showThinking);
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

/** P1-④: scrolling keys open the interaction window (browsing intent). */
function isScrollKey(data: string): boolean {
  return (
    matchesKey(data, Key.up) ||
    matchesKey(data, Key.down) ||
    matchesKey(data, Key.pageUp) ||
    matchesKey(data, Key.pageDown) ||
    matchesKey(data, Key.end)
  );
}
