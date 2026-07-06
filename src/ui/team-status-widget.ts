import { visibleWidth } from "@earendil-works/pi-tui";
import type { TeamContext, MemberOperationalState } from "../session/context";
import type { TeamMember } from "../team/definition";

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

// ── Widget Factory ────────────────────────────────────────

export interface TeamStatusWidget {
  /** Install the widget. Call once when session starts. */
  install(ui: { setWidget: (key: string, content: any) => void }, theme: { fg: (...args: any[]) => string }): void;
  /** Uninstall the widget. Call when session ends. */
  uninstall(): void;
  /** Manually refresh display. */
  refresh(): void;
}

/** Poll interval when all members are idle (30s). */
const IDLE_POLL_INTERVAL = 30_000;
/** Poll interval when at least one member is working (5s). */
const ACTIVE_POLL_INTERVAL = 5_000;

export function createTeamStatusWidget(options: {
  teamName: string;
  /** Dynamic getter for members — called on each refresh so dynamically added members appear. */
  getMembers: () => TeamMember[];
  teamCtx: TeamContext;
  memberOpsStates: Map<string, MemberOperationalState>;
}): TeamStatusWidget {
  const { teamName, getMembers, teamCtx, memberOpsStates } = options;
  const contextUsageMap = new Map<string, MemberContextInfo | null>();

  let pollingTimer: ReturnType<typeof setTimeout> | null = null;
  let currentUi: { setWidget: (key: string, content: any) => void } | null = null;
  let currentTheme: { fg: (...args: any[]) => string } | null = null;

  // ── Build display lines (with border) ──────────────────
  function buildLines(theme: { fg: (...args: any[]) => string }): string[] {
    const currentMembers = getMembers();

    // Handle design phase (0 members)
    if (currentMembers.length === 0) {
      const title = `● DYNAMIC TEAM — 设计阶段`;
      const statusText = "✅ 设计团队中（尚无成员）";
      const titleVw = visibleWidth(title);
      const statusVw = visibleWidth(statusText);
      const lineWidth = Math.max(titleVw + 4, statusVw + 2) + 4;
      const titleFill = repeat("─", Math.max(0, lineWidth - titleVw - 4));
      const statusPad = repeat(" ", Math.max(0, lineWidth - statusVw - 2));
      const bottomFill = repeat("─", Math.max(0, lineWidth - 1));
      return [
        `┌─ ${theme.fg("accent", title)} ${titleFill}`,
        `│ ${statusText}${statusPad}`,
        `└${theme.fg("dim", bottomFill)}`,
      ];
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
      const state = memberOpsStates.get(m.name) ?? "stopped";
      const info = contextUsageMap.get(m.name);

      const icon =
        state === "working" ? "🔧"
        : state === "idle" ? "✅"
        : state === "crashed" ? "💥"
        : "⏹️";

      const label = m.label ?? m.name;
      const stateColor =
        state === "working" ? "warning"
        : state === "idle" ? "success"
        : "muted";

      const separatorRaw = "  │  ";
      const separatorStyled = theme.fg("dim", separatorRaw);

      // Build raw segment
      let raw = ` ${icon} ${label}`;
      let styled = theme.fg(stateColor, ` ${icon} ${label}`);

      if (info != null && state !== "stopped" && state !== "crashed") {
        const pct = Math.round(info.percent);
        const pctColor: string =
          pct > 80 ? "error" : pct > 60 ? "warning" : "success";
        raw += ` ${pct}%`;
        styled += theme.fg(pctColor, ` ${pct}%`);
      } else if (state === "stopped" || state === "crashed") {
        raw += " —";
        styled += theme.fg("muted", " —");
      }

      segments.push({ raw, styled, separatorRaw, separatorStyled });
    }

    // Build the full raw status line for width calculation
    const sepRaw = "  │  ";
    const sepStyled = theme.fg("dim", sepRaw);
    const rawStatus = segments.map((s) => s.raw).join(sepRaw);
    const styledStatus = segments.map((s) => s.styled).join(sepStyled);

    // Title text
    const title = `● TEAM MODE — ${teamName}`;

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
    const topBorder    = `┌─ ${theme.fg("accent", title)} ${titleFill}`;
    const middleLine   = `│ ${styledStatus}${statusPad}`;
    const bottomBorder = `└${theme.fg("dim", bottomFill)}`;

    return [topBorder, middleLine, bottomBorder];
  }

  // ── Refresh widget display ─────────────────────────────
  function refresh(): void {
    if (!currentUi || !currentTheme) return;
    const lines = buildLines(currentTheme);
    try {
      currentUi.setWidget("team-status", lines);
    } catch {
      // UI may be gone
    }
  }

  // ── AbortController for cancelling in-flight poll requests ──
  let abortController = new AbortController();

  // ── Schedule next poll with adaptive interval ─────────
  function scheduleNextPoll(): void {
    const hasActiveMember = Array.from(memberOpsStates.values()).some(
      (state) => state === "working"
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
    for (const member of currentMembers) {
      if (signal.aborted) break;
      const handle = teamCtx.getHandle(member.name);
      const state = memberOpsStates.get(member.name);
      if (!handle || state === "stopped" || state === "crashed") continue;

      try {
        const response = await handle.sendCommandAndWait(
          { type: "get_session_stats" },
          (event: any) =>
            event.type === "response" && event.command === "get_session_stats",
          3000
        );
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
    }
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

      // Start first poll (subsequent polls scheduled adaptively)
      pollContextUsage();
    },

    uninstall() {
      if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
      }
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
  };
}
