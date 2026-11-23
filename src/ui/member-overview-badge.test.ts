import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  BADGE_TIERS, BADGE_WIDTH, BADGE_WORDS, STATUS_WORDS, TIER_MIN_LANE, badgeText, pickTier,
  statusClass, statusWord, type BadgeTier, type StatusWord,
} from "./member-overview-badge.js";
import { OP_CLASSES } from "./member-overview-palette.js";
import type { OverviewAction } from "./member-overview-store.js";

const action = (kind: OverviewAction["kind"], status: OverviewAction["status"] = "done"): OverviewAction =>
  ({ id: 1, kind, status, at: 0 });

describe("member overview badge", () => {
  it("keeps every word non-empty, CJK-only, and inside the field", () => {
    for (const tier of BADGE_TIERS) {
      for (const word of STATUS_WORDS) {
        const text = BADGE_WORDS[tier][word];
        expect(text.length).toBeGreaterThan(0);
        expect(visibleWidth(text)).toBeLessThanOrEqual(BADGE_WIDTH[tier]);
        for (const char of text) expect(char).toMatch(/^[\u4e00-\u9fff]$/);
        const padded = badgeText(word, tier);
        expect(padded.startsWith(text)).toBe(true);
        expect(visibleWidth(padded)).toBe(BADGE_WIDTH[tier]);
        // No ellipsis, ever: a word that does not fit is a word-table bug, not a clip.
        expect(padded).not.toContain("…");
      }
    }
  });

  it("pins both tiers so maintenance cannot drift one of them", () => {
    expect(BADGE_WIDTH).toEqual({ 3: 6, 2: 4 });
    expect(BADGE_WORDS[3]).toEqual({
      thinking: "思考中", output: "输出中", read: "读取中", modify: "写入中", tool: "执行中",
      compacting: "压缩中", waiting: "等待中", working: "工作中", idle: "空闲",
      crashed: "已崩溃", stopped: "已停止",
    });
    expect(BADGE_WORDS[2]).toEqual({
      thinking: "思考", output: "输出", read: "读取", modify: "写入", tool: "执行",
      compacting: "压缩", waiting: "等待", working: "工作", idle: "空闲",
      crashed: "崩溃", stopped: "停止",
    });
    // Every status exists exactly once per tier; the two tiers stay in lockstep.
    for (const word of STATUS_WORDS) expect(BADGE_WORDS[2][word]).toBeTruthy();
    expect(Object.keys(BADGE_WORDS[2]).sort()).toEqual(Object.keys(BADGE_WORDS[3]).sort());
  });

  it("keeps the badge field width constant so the lane cannot drift", () => {
    for (const tier of BADGE_TIERS) {
      const widths = new Set(STATUS_WORDS.map(word => visibleWidth(badgeText(word, tier))));
      expect([...widths]).toEqual([BADGE_WIDTH[tier]]);
    }
    // 空闲 is the only two-character word and is padded inside the 3-char field.
    expect(badgeText("idle", 3)).toBe("空闲  ");
    expect(badgeText("idle", 2)).toBe("空闲");
  });

  it("picks the widest tier whose badge still leaves a usable lane", () => {
    expect(TIER_MIN_LANE).toEqual({ 3: 20, 2: 14 });
    expect(pickTier(() => 20)).toBe(3);
    expect(pickTier(() => 19)).toBe(2);
    expect(pickTier(width => width === 6 ? 19 : 14)).toBe(2);
    expect(pickTier(width => width === 6 ? 19 : 13)).toBe("fallback");
    expect(pickTier(() => 0)).toBe("fallback");
  });

  it("maps every state × phase × turn combination without throwing", () => {
    const states = ["idle", "working", "compacting", "crashed", "stopped"] as const;
    const phases = [undefined, "thinking", "tool-calling", "executing", "output", "working", "idle"] as const;
    const latests = [undefined, action("read", "active"), action("modify", "active"), action("tool", "active"), action("read", "done")];
    const seen = new Set<StatusWord>();
    for (const state of states)
      for (const phase of phases)
        for (const latest of latests)
          for (const turnOpen of [false, true])
            for (const hasActionThisTurn of [false, true]) {
              const word = statusWord({ state, phase, latest, turnOpen, hasActionThisTurn });
              expect(STATUS_WORDS).toContain(word);
              seen.add(word);
            }
    // The exhaustive sweep really reaches every word.
    expect(seen.size).toBe(STATUS_WORDS.length);
  });

  it("derives the word from the control plane first, then the phase", () => {
    const base = { turnOpen: true, hasActionThisTurn: true };
    expect(statusWord({ ...base, state: "crashed", phase: "thinking" })).toBe("crashed");
    expect(statusWord({ ...base, state: "stopped", phase: "thinking" })).toBe("stopped");
    expect(statusWord({ ...base, state: "compacting", phase: "thinking" })).toBe("compacting");
    expect(statusWord({ ...base, state: "idle", phase: "thinking" })).toBe("idle");
    expect(statusWord({ ...base, state: "working", phase: "thinking" })).toBe("thinking");
    expect(statusWord({ ...base, state: "working", phase: "output" })).toBe("output");
    expect(statusWord({ ...base, state: "working", phase: "tool-calling" })).toBe("tool");
    expect(statusWord({ ...base, state: "working", phase: "executing", latest: action("read", "active") })).toBe("read");
    expect(statusWord({ ...base, state: "working", phase: "executing", latest: action("modify", "active") })).toBe("modify");
    expect(statusWord({ ...base, state: "working", phase: "executing", latest: action("tool", "active") })).toBe("tool");
    // A finished read is no longer "reading".
    expect(statusWord({ ...base, state: "working", phase: "executing", latest: action("read", "done") })).toBe("tool");
    expect(statusWord({ ...base, state: "working", phase: "executing" })).toBe("tool");
  });

  it("reports 等待中 for a dispatched member with nothing recorded this turn", () => {
    const base = { state: "working" as const };
    expect(statusWord({ ...base, turnOpen: true, hasActionThisTurn: false })).toBe("waiting");
    expect(statusWord({ ...base, turnOpen: false, hasActionThisTurn: true })).toBe("waiting");
    expect(statusWord({ ...base, turnOpen: false, hasActionThisTurn: false })).toBe("waiting");
    expect(statusWord({ ...base, turnOpen: true, hasActionThisTurn: true })).toBe("working");
  });

  it("colours each word with its timeline semantic", () => {
    expect(statusClass("thinking")).toBe("thinking");
    expect(statusClass("output")).toBe("output");
    expect(statusClass("read")).toBe("read");
    expect(statusClass("modify")).toBe("modify");
    expect(statusClass("tool")).toBe("tool");
    expect(statusClass("compacting")).toBe("compact");
    expect(statusClass("crashed")).toBe("crash");
    expect(statusClass("stopped")).toBe("stop");
    // Hue-free states are grey on purpose (§3.5.1): no dedicated colour, no lie.
    expect(statusClass("waiting")).toBe("busySilent");
    expect(statusClass("working")).toBe("busySilent");
    expect(statusClass("idle")).toBe("idle");
    for (const word of STATUS_WORDS) expect(OP_CLASSES).toContain(statusClass(word));
  });

  it("degrades to a padded empty field for an unknown tier or word instead of throwing", () => {
    expect(badgeText("idle", 4 as BadgeTier)).toBe("");
    expect(badgeText("nope" as StatusWord, 2)).toBe("    ");
    expect(statusClass("nope" as StatusWord)).toBe("idle");
  });
});
