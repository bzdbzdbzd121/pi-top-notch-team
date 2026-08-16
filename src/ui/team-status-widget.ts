import { visibleWidth } from "@earendil-works/pi-tui";
import type { TeamContext, MemberOperationalState } from "../session/context";
import type { TeamMember } from "../team/definition";
import type { ActivityTracker } from "../channel/activity-tracker";
import { nextStreamFlushDelay } from "./member-inspector-state";

// ── Types ─────────────────────────────────────────────────

export interface MemberContextInfo {
  percent: number;
  tokens: number;
  contextWindow: number;
}

// ── Helpers ───────────────────────────────────────────────

/** Repeat a character n times. */
function repeat(ch: string, n: number): string {
  if (n <= 0) return "";
  return ch.repeat(n);
}

/**
 * Duration micro-caption (enhancement A): `12s`, `1m20s`. Derived from
 * phaseSince at render time — zero timers.
 */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
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
   * Computes the member's display signature (logical state + phase + toolName
   * + seconds-rounded duration); unchanged signature → no render scheduling.
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
  /** N1 render side: raw (unstyled) line fingerprint of the last setWidget. */
  let lastRawKey: string | null = null;

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
            // window) — honest 🔧 fallback, never a false ✅ idle.
            icon = "🔧";
          } else {
            icon = "✅";
            color = "muted";
          }
        } else {
          const durText = formatDuration(Date.now() - activity.phaseSince);
          switch (activity.phase) {
            case "thinking":
              icon = "💭";
              color = "accent";
              extraRaw = ` ${durText}`;
              break;
            case "tool-calling":
              // Tool argument generation (ms-scale) — name unknown until executing.
              icon = "🔧";
              color = "warning";
              break;
            case "executing": {
              icon = "⚙️";
              color = "warning";
              // D10: the tracker stored the precomputed truncated name; the
              // widget only appends the ellipsis when truncation happened.
              const tool = activity.toolName;
              const toolText = tool ? ` ${tool}${activity.toolNameTruncated ? "…" : ""}` : "";
              extraRaw = `${toolText} ${durText}`;
              break;
            }
            case "output":
              icon = "📤";
              color = "success";
              extraRaw = ` ${durText}`;
              break;
            default:
              // working — honest gap fallback, neutral color, no duration.
              icon = "🔧";
              break;
          }
        }
      }

      // Context percentage: shown in every running state (idle included);
      // stopped/crashed keep the " —" placeholder instead.
      if (info != null && logicalState !== "stopped" && logicalState !== "crashed") {
        extraRaw += ` ${Math.round(info.percent)}%`;
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
    const { raw, styled } = buildDisplay(currentTheme);
    lastBuildMs = performance.now() - t0;
    // N1 render side: compare RAW (unstyled) lines with the last output —
    // unchanged content skips setWidget entirely (setWidget is a full
    // component rebuild + unconditional requestRender upstream, the single
    // largest cost item of this feature). Raw comparison has no key-set
    // blind spots (any render-affecting change shows up in the raw lines).
    const rawKey = raw.join("\n");
    if (rawKey === lastRawKey) return;
    lastRawKey = rawKey;
    try {
      currentUi.setWidget("team-status", styled);
    } catch {
      // UI may be gone
    }
  }

  // ── Live refresh scheduling (N1 scheduling side) ───────
  /**
   * Per-member display signature: everything that changes what the member's
   * segment looks like. The seconds-rounded duration makes second boundaries
   * trigger renders while suppressing sub-second churn (enhancement A + N1).
   */
  function memberSignature(memberName: string, now: number): string {
    const logical = memberOpsStates.get(memberName) ?? "stopped";
    const activity = activityTracker.getActivity(memberName, now);
    const phase = activity?.phase ?? "idle";
    const tool = activity?.toolName ?? "";
    const durSec = activity ? Math.max(0, Math.floor((now - activity.phaseSince) / 1000)) : 0;
    return `${logical}|${phase}|${tool}|${durSec}`;
  }

  function onMemberEvent(memberName: string, _event: any): void {
    if (!currentUi) return; // not installed
    const now = Date.now();
    const sig = memberSignature(memberName, now);
    if (sig === lastSignatures.get(memberName)) return; // N1 scheduling gate
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
      lastRawKey = null;
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
