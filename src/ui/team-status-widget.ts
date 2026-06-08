import type { TeamContext, MemberOperationalState } from "../session/context";
import type { TeamMember } from "../team/definition";

// ── Types ─────────────────────────────────────────────────

export interface MemberContextInfo {
  percent: number;
  tokens: number;
  contextWindow: number;
}

// ── Widget Factory ────────────────────────────────────────

export interface TeamStatusWidget {
  /** Install the widget. Call once when session starts. */
  install(ui: { setWidget: Function; setStatus: Function }, theme: { fg: Function }): void;
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
  let currentUi: { setWidget: Function; setStatus: Function } | null = null;
  let currentTheme: { fg: Function } | null = null;

  // ── Build display lines from current data ──────────────
  function buildLines(theme: { fg: Function }): string[] {
    const header = theme.fg("accent", "● TEAM MODE") + ` — ${teamName}`;

    const statusParts = members.map((m) => {
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

      let text = theme.fg(stateColor, ` ${icon} ${label}`);

      if (info != null && state !== "stopped" && state !== "crashed") {
        const pct = Math.round(info.percent);
        const pctColor: string =
          pct > 80 ? "error" : pct > 60 ? "warning" : "success";
        text += theme.fg(pctColor, ` ${pct}%`);
      } else if (state === "stopped" || state === "crashed") {
        text += theme.fg("muted", " —");
      }

      return text;
    });

    const lines: string[] = [header];
    if (statusParts.length > 0) {
      lines.push(statusParts.join(theme.fg("dim", "  │  ")));
    }
    return lines;
  }

  // ── Refresh widget display ─────────────────────────────
  function refresh(): void {
    if (!currentUi || !currentTheme) return;
    const lines = buildLines(currentTheme);
    try {
      currentUi.setWidget("team-status", lines, { placement: "belowEditor" });
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
    install(
      ui: { setWidget: Function; setStatus: Function },
      theme: { fg: Function }
    ) {
      currentUi = ui;
      currentTheme = theme;

      // Set footer status
      try {
        currentUi.setStatus("team-status", theme.fg("accent", "● team"));
      } catch {
        // ignore
      }

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
          currentUi.setStatus("team-status", undefined);
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
