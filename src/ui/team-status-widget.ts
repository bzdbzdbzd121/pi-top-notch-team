import { visibleWidth } from "@earendil-works/pi-tui";
import type { TeamContext, MemberOperationalState } from "../session/context";
import type { TeamMember } from "../team/definition";
import type { ActivityTracker } from "../channel/activity-tracker";
import { nextStreamFlushDelay } from "./member-inspector-state";

// ── Types ─────────────────────────────────────────────────

export interface MemberContextInfo {
  // percent can be null: pi 上游 getContextUsage() 在压缩完成后返回 percent:null
  // （合法「未知」，见 auto-compact.ts queryStats 注释）——显示层渲染 "?"，
  // 不得 Math.round(null)===0 显示误导性 "0%"。
  percent: number | null;
  tokens: number | null;
  contextWindow: number;
}

// ── Helpers ───────────────────────────────────────────────

/** Repeat a character n times. */
function repeat(ch: string, n: number): string {
  if (n <= 0) return "";
  return ch.repeat(n);
}

// ── Widget Factory ────────────────────────────────────────

export interface TeamStatusWidget {
  /** Install the widget. Call once when session starts. */
  install(ui: { setWidget: (key: string, content: any) => void }, theme: { fg: (...args: any[]) => string }): void;
  /** Uninstall the widget. Call when session ends. */
  uninstall(): void;
  /** Manually refresh display (render-side gate applies: unchanged → no setWidget). */
  refresh(): void;
  /**
   * Event-driven live-refresh entry (N1 scheduling side): called by the
   * onMemberActivity multi-cast AFTER the activity tracker consumed the event.
   * Computes the member's display signature (logical state + phase — v2:
   * duration/toolName are gone from the display, so the signature is just
   * `logical|phase`); unchanged signature → no render scheduling.
   */
  onMemberEvent(memberName: string, event: any): void;
}

/** Poll interval when all members are idle (30s). */
const IDLE_POLL_INTERVAL = 30_000;
/** Poll interval when at least one member is working (15s — reduced from 5s). */
const ACTIVE_POLL_INTERVAL = 15_000;

/** Live-refresh merge window (100–150ms per design; ~8 renders/s worst case). */
const LIVE_REFRESH_WINDOW_MS = 120;
/** Adaptive backoff cap (dense streams drop the cadence toward ~1/s). */
const LIVE_REFRESH_MAX_WINDOW_MS = 1000;

export function createTeamStatusWidget(options: {
  teamName: string;
  /** Dynamic getter for members — called on each refresh so dynamically added members appear. */
  getMembers: () => TeamMember[];
  teamCtx: TeamContext;
  memberOpsStates: Map<string, MemberOperationalState>;
  /**
   * Fine-grained activity display layer (phase 1). Fed by the onMemberActivity
   * multi-cast; the widget only reads it (getActivity → derivePhase is lazy,
   * so staleness is judged at render time — D3).
   */
  activityTracker: ActivityTracker;
  /**
   * Session origin marker (ADR-0003): "agent" sessions show 🤖, user sessions 👤
   * in the title so the user can always tell how the session was started.
   * Defaults to "user".
   */
  origin?: "user" | "agent";
}): TeamStatusWidget {
  const { teamName, getMembers, teamCtx, memberOpsStates, activityTracker, origin = "user" } = options;
  const originMarker = origin === "agent" ? "🤖" : "👤";
  const contextUsageMap = new Map<string, MemberContextInfo | null>();

  let pollingTimer: ReturnType<typeof setTimeout> | null = null;
  let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let liveRefreshPending = false;
  let liveRefreshWindowMs = LIVE_REFRESH_WINDOW_MS;
  let lastBuildMs = 0;
  let currentUi: { setWidget: (key: string, content: any) => void } | null = null;
  let currentTheme: { fg: (...args: any[]) => string } | null = null;

  /** N1 scheduling side: per-member display signatures (last rendered decision). */
  const lastSignatures = new Map<string, string>();
  /**
   * N1 render side: fingerprint of the last setWidget. Keyed on the STYLED
   * lines (raw text + ANSI colors) — a raw-only comparison is color-blind:
   * working fallback (default color) and tool-calling (warning) produce
   * IDENTICAL raw lines but visually different output (B1). v2 note: with
   * pairs (working 💭 default vs thinking 💭 accent) render IDENTICAL raw
   * lines — the styled comparison is exactly why the gate stays color-aware.
   */
  let lastRenderKey: string | null = null;

  // ── Build display lines (with border) ──────────────────
  // Returns BOTH raw (unstyled, for width computation + N1 render gate) and
  // styled lines (for display). Raw/styled dual-track is the existing pattern.
  function buildDisplay(theme: { fg: (...args: any[]) => string }): { raw: string[]; styled: string[] } {
    const currentMembers = getMembers();

    // Handle design phase (0 members)
    if (currentMembers.length === 0) {
      const title = `● DYNAMIC TEAM ${originMarker} — 设计阶段`;
      const statusText = "✅ 设计团队中（尚无成员）";
      const titleVw = visibleWidth(title);
      const statusVw = visibleWidth(statusText);
      const lineWidth = Math.max(titleVw + 4, statusVw + 2) + 4;
      const titleFill = repeat("─", Math.max(0, lineWidth - titleVw - 4));
      const statusPad = repeat(" ", Math.max(0, lineWidth - statusVw - 2));
      const bottomFill = repeat("─", Math.max(0, lineWidth - 1));
      return {
        raw: [
          `┌─ ${title} ${titleFill}`,
          `│ ${statusText}${statusPad}`,
          `└${bottomFill}`,
        ],
        styled: [
          `┌─ ${theme.fg("accent", title)} ${titleFill}`,
          `│ ${statusText}${statusPad}`,
          `└${theme.fg("dim", bottomFill)}`,
        ],
      };
    }

    // Build status segments (raw for width, styled for display)
    interface Segment {
      raw: string;
      styled: string;
      separatorRaw: string;
      separatorStyled: string;
    }
    const segments: Segment[] = [];

    for (const m of currentMembers) {
      const logicalState = memberOpsStates.get(m.name) ?? "stopped";
      const info = contextUsageMap.get(m.name);
      const label = m.label ?? m.name;

      // Render priority: compacting > crashed/stopped > fine-grained phase >
      // working fallback > idle. Process-level states (memberOpsStates) are the
      // authority for compacting/crashed/stopped (D10/D12 — the tracker never
      // sees compaction events, and process death is the logical layer's job).
      let icon: string;
      let color: string | null = null; // null = default (working fallback)
      let extraRaw = "";

      if (logicalState === "compacting") {
        icon = "🗜️";
        color = "accent";
      } else if (logicalState === "crashed") {
        icon = "💥";
        color = "muted";
        extraRaw = " —";
      } else if (logicalState === "stopped") {
        icon = "⏹️";
        color = "muted";
        extraRaw = " —";
      } else {
        const activity = activityTracker.getActivity(m.name);
        if (!activity || activity.phase === "idle") {
          if (logicalState === "working") {
            // Working but no fine-grained data yet (the dispatch → agent_start
            // window) — honest 💭 fallback (default color), never a false ✅ idle.
            icon = "💭";
          } else {
            icon = "✅";
            color = "muted";
          }
        } else {
          switch (activity.phase) {
            case "thinking":
              icon = "💭";
              color = "accent";
              break;
            case "tool-calling":
              // Tool argument generation (ms-scale) — same visual as executing
              // (🔧 warning): the phases stay structurally distinct, the
              // display intentionally does not distinguish them (v2).
              icon = "🔧";
              color = "warning";
              break;
            case "executing":
              // v2: executing uses 🔧 (same icon+color as tool-calling —靠阶段语义区分).
              icon = "🔧";
              color = "warning";
              break;
            case "output":
              // v2.2: output uses ✏️ (U+270F+U+FE0F).
              icon = "✏️";
              color = "success";
              break;
            default:
              // working — honest gap fallback (💭, default color; thinking is
              // the SAME icon in accent — the color is the discriminator).
              icon = "💭";
              break;
          }
        }
      }

      // Context percentage: shown in every running state (idle included);
      // stopped/crashed keep the " —" placeholder instead. percent:null is a
      // LEGAL post-compaction "unknown" (上游 getContextUsage 契约)——渲染
      // "?"，不得 Math.round(null)===0 显示误导性 "0%"（问题二 Phase 2）。
      if (info != null && logicalState !== "stopped" && logicalState !== "crashed") {
        extraRaw += info.percent === null ? " ?" : ` ${Math.round(info.percent)}%`;
      }

      const raw = ` ${icon} ${label}${extraRaw}`;
      const styled = color ? theme.fg(color, raw) : raw;

      const separatorRaw = "  │  ";
      const separatorStyled = theme.fg("dim", separatorRaw);
      segments.push({ raw, styled, separatorRaw, separatorStyled });
    }

    // Build the full raw status line for width calculation
    const sepRaw = "  │  ";
    const sepStyled = theme.fg("dim", sepRaw);
    const rawStatus = segments.map((s) => s.raw).join(sepRaw);
    const styledStatus = segments.map((s) => s.styled).join(sepStyled);

    // Title text
    const title = `● TEAM MODE ${originMarker} — ${teamName}`;

    // Compute total visible width for all lines.
    // Each line has different left-border prefix width:
    //   top:   ┌─   (3 cols) + content + filler
    //   mid:   │    (2 cols) + content + padding
    //   bot:   └    (1 col)  + filler
    // We choose lineWidth so that ALL three lines land at the same column.
    const titleVw = visibleWidth(title);
    const statusVw = visibleWidth(rawStatus);
    const lineWidth = Math.max(titleVw + 4, statusVw + 2) + 4;

    const titleFill = repeat("─", Math.max(0, lineWidth - titleVw - 4));
    const statusPad  = repeat(" ", Math.max(0, lineWidth - statusVw - 2));
    const bottomFill = repeat("─", Math.max(0, lineWidth - 1));

    // Build lines with left-only border (no right-side vertical bar)
    const topBorderRaw    = `┌─ ${title} ${titleFill}`;
    const middleLineRaw   = `│ ${rawStatus}${statusPad}`;
    const bottomBorderRaw = `└${bottomFill}`;
    const topBorder    = `┌─ ${theme.fg("accent", title)} ${titleFill}`;
    const middleLine   = `│ ${styledStatus}${statusPad}`;
    const bottomBorder = `└${theme.fg("dim", bottomFill)}`;

    return {
      raw: [topBorderRaw, middleLineRaw, bottomBorderRaw],
      styled: [topBorder, middleLine, bottomBorder],
    };
  }

  // ── Refresh widget display (N1 render-side gate) ───────
  function refresh(): void {
    if (!currentUi || !currentTheme) return;
    const t0 = performance.now();
    const display = buildDisplay(currentTheme);
    lastBuildMs = performance.now() - t0;
    // N1 render side: compare the STYLED lines (raw text + colors) with the
    // last output — unchanged content skips setWidget entirely (setWidget is
    // a full component rebuild + unconditional requestRender upstream, the
    // single largest cost item of this feature). Styled embeds raw text, so a
    // single comparison covers both content and color changes — raw-only
    // comparison has a color blind spot (B1): same-icon different-color pairs
    // render identical raw lines — pre-v2: working 🔧 vs tool-calling 🔧;
    // v2.2: working 💭 default vs thinking 💭 accent. The styled comparison
    // captures both the color-only transitions and dedups the same-icon
    // same-color pair (tool-calling ↔ executing, both 🔧 warning).
    const renderKey = display.styled.join("\n");
    if (renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;
    try {
      currentUi.setWidget("team-status", display.styled);
    } catch {
      // UI may be gone
    }
  }

  // ── Live refresh scheduling (N1 scheduling side) ───────
  /**
   * Per-member display signature: everything that changes what the member's
   * segment looks like. v2: duration and toolName are gone from the display,
   * so the signature is exactly `logical|phase` — same-phase deltas (and the
   * tool-calling ↔ executing pair, whose styled output is identical) never
   * schedule a render.
   */
  function memberSignature(memberName: string): string {
    const logical = memberOpsStates.get(memberName) ?? "stopped";
    const activity = activityTracker.getActivity(memberName);
    const phase = activity?.phase ?? "idle";
    return `${logical}|${phase}`;
  }

  function onMemberEvent(memberName: string, event: any): void {
    if (!currentUi) return; // not installed
    const sig = memberSignature(memberName);
    // S1: process death must ALWAYS re-render promptly even when the signature
    // is unchanged (e.g. an idle member with no tracker entry: P3 delete is a
    // no-op, logical state updates AFTER the multi-cast) — otherwise the crash
    // would only surface at the next poll (up to 30s). The flush runs ≥120ms
    // later, by which time the event-handler's state machine update has landed.
    const isProcessDeath =
      event?.type === "process_exit" || event?.type === "process_error";
    if (sig === lastSignatures.get(memberName) && !isProcessDeath) {
      return; // N1 scheduling gate
    }
    lastSignatures.set(memberName, sig);
    if (liveRefreshTimer) {
      liveRefreshPending = true; // dense stream — next flush backs off
      return;
    }
    scheduleLiveRefresh();
  }

  function scheduleLiveRefresh(): void {
    if (liveRefreshTimer || !currentUi) return;
    liveRefreshTimer = setTimeout(() => {
      liveRefreshTimer = null;
      const prevWindow = liveRefreshWindowMs;
      if (liveRefreshPending) {
        // Dense stream: adapt the window (shared nextStreamFlushDelay pattern,
        // cap LIVE_REFRESH_MAX_WINDOW_MS — worst case ~1/s under sustained load).
        liveRefreshWindowMs = nextStreamFlushDelay(
          prevWindow,
          lastBuildMs,
          LIVE_REFRESH_WINDOW_MS,
          LIVE_REFRESH_MAX_WINDOW_MS
        );
        liveRefreshPending = false;
      } else {
        liveRefreshWindowMs = LIVE_REFRESH_WINDOW_MS;
      }
      refresh();
    }, liveRefreshWindowMs);
  }

  // ── AbortController for cancelling in-flight poll requests ──
  let abortController: AbortController | null = new AbortController();

  // ── Schedule next poll with adaptive interval ─────────
  function scheduleNextPoll(): void {
    const hasActiveMember = Array.from(memberOpsStates.values()).some(
      (state) => state === "working" || state === "compacting"
    );
    const interval = hasActiveMember ? ACTIVE_POLL_INTERVAL : IDLE_POLL_INTERVAL;
    pollingTimer = setTimeout(() => {
      pollContextUsage();
    }, interval);
  }

  // ── Poll context usage from all running members ─────────
  async function pollContextUsage(): Promise<void> {
    abortController = new AbortController();
    const signal = abortController.signal;
    const currentMembers = getMembers();

    // N3: parallel stats queries — the previous serial for-await loop had a
    // worst case of 3N s (N members × 3s timeout each, N=8 → 24s, longer than
    // the 15s period → scheduling drift). Promise.allSettled caps one poll at
    // the MAX timeout (≤3s); per-member failures are fail-open (keep previous).
    await Promise.allSettled(
      currentMembers.map(async (member) => {
        const handle = teamCtx.getHandle(member.name);
        const state = memberOpsStates.get(member.name);
        if (!handle || state === "stopped" || state === "crashed") return;
        try {
          const response = await handle.sendCommandAndWait(
            { type: "get_session_stats" },
            (event: any) =>
              event.type === "response" && event.command === "get_session_stats",
            3000
          );
          if (signal.aborted) return; // uninstall raced the in-flight query
          if (response?.data?.contextUsage) {
            contextUsageMap.set(member.name, {
              percent: response.data.contextUsage.percent,
              tokens: response.data.contextUsage.tokens,
              contextWindow: response.data.contextUsage.contextWindow,
            });
          }
        } catch {
          // Timeout or error — keep previous value
        }
      })
    );

    // N2: poll completion ALWAYS refreshes (the render-side gate skips
    // unchanged content). The poll is the only time-driven render source: it
    // keeps duration/percentage moving during long event-less periods and
    // gives the lazy 30s staleness judgment its execution window (third
    // anti-stuck loop).
    if (signal.aborted) return; // uninstall happened — do not reschedule
    refresh();
    // Schedule next poll with adaptive interval (recursive setTimeout)
    scheduleNextPoll();
  }

  // ── Public API ──────────────────────────────────────────
  return {
    install(ui: { setWidget: (key: string, content: any) => void }, theme: { fg: (...args: any[]) => string }) {
      currentUi = ui;
      currentTheme = theme;

      // Initial render
      refresh();

      // Start first poll (subsequent polls scheduled adaptively) — the
      // install-time initial query (D12).
      pollContextUsage();
    },

    uninstall() {
      if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
      }
      if (liveRefreshTimer) {
        clearTimeout(liveRefreshTimer);
        liveRefreshTimer = null;
      }
      liveRefreshPending = false;
      lastSignatures.clear();
      lastRenderKey = null;
      // Cancel any in-flight poll requests
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      if (currentUi) {
        try {
          currentUi.setWidget("team-status", undefined);
        } catch {
          // ignore
        }
        currentUi = null;
      }
      currentTheme = null;
      contextUsageMap.clear();
    },

    refresh,

    onMemberEvent,
  };
}
