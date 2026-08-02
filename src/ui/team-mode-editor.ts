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

    // Rebuild bottom border line.
    // NOTE: when autocomplete suggestions are visible, the base Editor appends
    // suggestion rows AFTER the bottom border (see pi-tui editor render), so the
    // last line is then a candidate row — not the border. Blindly rewriting
    // lines[last] destroys the last autocomplete item on every keystroke
    // (observed: candidates vanish one by one while typing "/team s" → "/team st").
    // Instead, scan upward for the first line made solely of border glyphs and
    // treat only that line as the bottom border.
    for (let i = lines.length - 1; i >= 1; i--) {
      const plain = lines[i]!.replace(/\x1b\[[\d;]*m/g, "");
      const isPureBorder = /^[─\s]+$/.test(plain);
      const isScrollIndicator = plain.includes("more") && /^[─↑↓\s\dmore]+$/.test(plain);
      if (isPureBorder) {
        lines[i] = buildRainbow(width);
        break;
      }
      if (isScrollIndicator) {
        // Scroll indicator: color text with accent, dashes with rainbow
        const indicatorMatch = plain.match(/^([─↑↓\s\dmore]+)/);
        const indicatorText = indicatorMatch?.[1] ?? "";
        const indicatorLen = visibleWidth(indicatorText);
        const dashLen = Math.max(0, width - indicatorLen);
        lines[i] = theme.fg("accent", indicatorText) + buildRainbow(dashLen);
        break;
      }
      // Non-border content line (autocomplete row or text): keep scanning up.
    }

    return lines;
  }
}
