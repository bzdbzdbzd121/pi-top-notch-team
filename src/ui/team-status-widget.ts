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
  install(ui: { setWidget: Function }, theme: { fg: Function }): void;
  /** Uninstall the widget. Call when session ends. */
  uninstall(): void;
  /** Manually refresh display. */
  refresh(): void;
}

export function createTeamStatusWidget(options: {
  teamName: string;
  members: TeamMember[];
  teamCtx: TeamContext;
  memberOpsStates: Map<string, MemberOperationalState>;
}): TeamStatusWidget {
  const { teamName, members, teamCtx, memberOpsStates } = options;
  const contextUsageMap = new Map<string, MemberContextInfo | null>();

  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let currentUi: { setWidget: Function } | null = null;
  let currentTheme: { fg: Function } | null = null;

  // ── Build display lines (with border) ──────────────────
  function buildLines(theme: { fg: Function }): string[] {
    // Build status segments (raw for width, styled for display)
    type Segment = { raw: string; styled: string };
    const segments: Segment[] = [];

    for (const m of members) {
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

      segments.push({ raw, styled, separatorRaw, separatorStyled } as any);
    }

    // Build the full raw status line for width calculation
    const rawStatus = segments
      .map((s: any) => s.raw)
      .join(" | ");
    const styledStatus = segments
      .map((s: any) => s.styled)
      .join(" | ");

    // Title text
    const title = `● TEAM MODE — ${teamName}`;

    // Compute content box width (inner width excluding borders).
    // visibleWidth from @earendil-works/pi-tui correctly handles
    // CJK characters (2 columns) and ASCII (1 column).
    const contentWidth = Math.max(
      visibleWidth(title) + 4,        // 2 padding on each side
      visibleWidth(rawStatus) + 4
    );

    // Gap fillers
    const titleFill = repeat("─", Math.max(0, contentWidth - visibleWidth(title) - 4));
    const statusPadding = repeat(" ", Math.max(0, contentWidth - visibleWidth(rawStatus) - 4));
    const bottomFill = repeat("─", contentWidth);

    // Build lines with left-only border (no right border)
    const topBorder = `┌─ ${theme.fg("accent", title)} ${titleFill}`;
    const middleLine = `│ ${styledStatus}${statusPadding}`;
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

  // ── Poll context usage from all running members ─────────
  async function pollContextUsage(): Promise<void> {
    for (const member of members) {
      const handle = teamCtx.memberHandles.get(member.name);
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
  }

  // ── Public API ──────────────────────────────────────────
  return {
    install(ui: { setWidget: Function }, theme: { fg: Function }) {
      currentUi = ui;
      currentTheme = theme;

      // Initial render
      refresh();

      // Start polling (immediate + every 10s)
      pollContextUsage();
      pollingTimer = setInterval(pollContextUsage, 10_000);
    },

    uninstall() {
      if (pollingTimer) {
        clearInterval(pollingTimer);
        pollingTimer = null;
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
