import { visibleWidth } from "@earendil-works/pi-tui";

// ── Helpers ───────────────────────────────────────────────

function repeat(ch: string, n: number): string {
  if (n <= 0) return "";
  return ch.repeat(n);
}

// ── Widget Factory ────────────────────────────────────────

export interface EditModeWidget {
  /** Install the widget. Call when /team edit enters. */
  install(ui: { setWidget: (key: string, content: any) => void }, theme: { fg: (...args: any[]) => string }): void;
  /** Uninstall the widget. Call when edit mode exits. */
  uninstall(): void;
}

export function createEditModeWidget(teamName: string): EditModeWidget {
  let currentUi: { setWidget: (key: string, content: any) => void } | null = null;
  let currentTheme: { fg: (...args: any[]) => string } | null = null;

  function buildLines(theme: { fg: (...args: any[]) => string }): string[] {
    const title = `✏️ EDIT MODE — ${teamName}`;
    const hint = "用自然语言描述修改, TL 引导完成 | /team done 退出";
    const titleVw = visibleWidth(title);
    const hintVw = visibleWidth(hint);
    const lineWidth = Math.max(titleVw + 4, hintVw + 2) + 4;
    const titleFill = repeat("─", Math.max(0, lineWidth - titleVw - 4));
    const hintPad = repeat(" ", Math.max(0, lineWidth - hintVw - 2));
    const bottomFill = repeat("─", Math.max(0, lineWidth - 1));

    return [
      `┌─ ${theme.fg("accent", title)} ${titleFill}`,
      `│ ${theme.fg("dim", hint)}${hintPad}`,
      `└${theme.fg("dim", bottomFill)}`,
    ];
  }

  return {
    install(ui, theme) {
      currentUi = ui;
      currentTheme = theme;
      try {
        ui.setWidget("team-edit-mode", buildLines(theme));
      } catch {
        // UI may be gone
      }
    },

    uninstall() {
      if (currentUi) {
        try {
          currentUi.setWidget("team-edit-mode", undefined);
        } catch {
          // ignore
        }
        currentUi = null;
      }
      currentTheme = null;
    },
  };
}
