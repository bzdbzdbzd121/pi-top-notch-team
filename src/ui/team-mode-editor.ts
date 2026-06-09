import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export class TeamModeEditor extends CustomEditor {
  private teamModeActive = false;
  private fullTheme: { fg: (color: string, text: string) => string };

  constructor(tui: any, theme: any, keybindings: any, fullTheme: { fg: (color: string, text: string) => string }) {
    super(tui, theme, keybindings);
    this.fullTheme = fullTheme;
  }

  setTeamMode(active: boolean): void {
    if (this.teamModeActive === active) return;
    this.teamModeActive = active;
    this.invalidate();
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.teamModeActive || lines.length < 2) return lines;

    const theme = this.fullTheme;
    const colors = ["error", "syntaxKeyword", "warning", "accent", "syntaxType", "success"] as const;
    const segLen = Math.ceil(width / colors.length);

    const buildRainbow = (len: number): string => {
      let result = "";
      let remaining = len;
      for (let i = 0; i < colors.length && remaining > 0; i++) {
        const seg = Math.min(segLen, remaining);
        result += theme.fg(colors[i], "─".repeat(seg));
        remaining -= seg;
      }
      return result;
    };

    // Rebuild top border line
    const first = lines[0]!;
    const plainFirst = first.replace(/\x1b\[[\d;]*m/g, "");
    const isScrollIndicator = plainFirst.includes("more");
    if (!isScrollIndicator) {
      lines[0] = buildRainbow(width);
    } else {
      // Scroll indicator: color text with accent, dashes with rainbow
      const plain = first.replace(/\x1b\[[\d;]*m/g, "");
      const indicatorMatch = plain.match(/^([─↑↓\s\dmore]+)/);
      const indicatorText = indicatorMatch?.[1] ?? "";
      const indicatorLen = visibleWidth(indicatorText);
      const dashLen = Math.max(0, width - indicatorLen);
      lines[0] = theme.fg("accent", indicatorText) + buildRainbow(dashLen);
    }

    // Rebuild bottom border line
    const last = lines[lines.length - 1]!;
    const plainLast = last.replace(/\x1b\[[\d;]*m/g, "");
    if (!plainLast.includes("more") && !plainLast.includes("[")) {
      // Pure border
      lines[lines.length - 1] = buildRainbow(width);
    } else if (plainLast.includes("more")) {
      const plain = plainLast;
      const indicatorMatch = plain.match(/^([─↑↓\s\dmore]+)/);
      const indicatorText = indicatorMatch?.[1] ?? "";
      const indicatorLen = visibleWidth(indicatorText);
      const dashLen = Math.max(0, width - indicatorLen);
      lines[lines.length - 1] = theme.fg("accent", indicatorText) + buildRainbow(dashLen);
    }

    return lines;
  }
}
