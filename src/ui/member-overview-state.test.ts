import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  buildInspectorHeader, getOverviewWindowOffset, type OverviewRow,
} from "./member-overview-state";

// The overview page itself is rendered by member-overview-timeline.ts (see
// member-overview-timeline.test.ts). This file covers what is still shared with
// it: the header tab window and the roster window offset.

const members = Array.from({ length: 24 }, (_, i) => ({ name: `m${i}`, label: `成员${i}` }));
const row = (name: string, patch: Partial<OverviewRow> = {}): OverviewRow => ({
  name, label: name, state: "working", percent: 42, actions: [], ...patch,
});

describe("overview window offset", () => {
  it("scrolls the selected member into the given member capacity", () => {
    const rows = members.map(m => row(m.name));
    expect(getOverviewWindowOffset(rows, "m20", 0, 5)).toBe(16);
    expect(getOverviewWindowOffset(rows, "m2", 17, 5)).toBe(2);
    expect(getOverviewWindowOffset(rows, undefined, 999, 5)).toBe(19);
    expect(getOverviewWindowOffset(rows, undefined, -10, 5)).toBe(0);
    expect(getOverviewWindowOffset([], undefined, 99, 0)).toBe(0);
  });
});

describe("horizontal inspector tab window", () => {
  it("pins overview and keeps the active member visible with hidden-side markers", () => {
    const header = stripAnsi(buildInspectorHeader(members, { kind: "member", name: "m12" }, undefined, 42));
    expect(header).toContain("总览");
    expect(header).toContain("❰成员12❱");
    expect(header).toContain("‹");
    expect(header).toContain("›");
    expect(header).not.toContain("成员0 ");
  });

  it("anchors overview member tabs around the selected row", () => {
    const header = stripAnsi(buildInspectorHeader(members, { kind: "overview" }, "m20", 42));
    expect(header).toContain("❰总览❱");
    expect(header).toContain("成员20");
    expect(header).not.toContain("❰成员20❱");
  });

  it("shows all members without unnecessary arrows when they fit", () => {
    const header = stripAnsi(buildInspectorHeader(members.slice(0, 2), { kind: "overview" }, undefined, 60));
    expect(header).toContain("成员0");
    expect(header).toContain("成员1");
    expect(header).not.toMatch(/[‹›]/);
  });

  it("distinguishes duplicate member labels in tabs", () => {
    const header = stripAnsi(buildInspectorHeader([{ name: "alpha", label: "开发" }, { name: "beta", label: "开发" }], { kind: "member", name: "beta" }, undefined, 60));
    expect(header).toContain("alpha");
    expect(header).toContain("beta");
  });

  it("retains a recognizable overview label at tiny widths", () => {
    expect(stripAnsi(buildInspectorHeader(members, { kind: "overview" }, "m20", 2))).toBe("总");
    expect(stripAnsi(buildInspectorHeader([], { kind: "overview" }, undefined, 4))).toBe("总览");
  });

  it("reflows on resize, uses whole graphemes, and handles stale selections", () => {
    const list = [{ name: "a", label: "\x1b[31m程序👩‍💻研发e\u0301\x1b[0m" }, ...members];
    for (let width = 0; width <= 120; width++) {
      for (const name of ["a", "m20", "missing"]) {
        const header = buildInspectorHeader(list, { kind: "member", name }, undefined, width);
        expect(visibleWidth(header)).toBe(width);
        expect(stripAnsi(header)).not.toMatch(/[\r\n\t]|\uFFFD|\u200d(?:…|$)/u);
      }
    }
    expect(stripAnsi(buildInspectorHeader([], { kind: "overview" }, undefined, 20))).toContain("总览");
  });
});
