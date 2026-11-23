import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityPhase } from "../channel/activity-tracker";
import type { MemberOperationalState } from "../session/context";
import type { OpClass } from "./member-overview-palette";
import type { OverviewAction } from "./member-overview-store";

/** The eleven states a member row can describe (§3.5.1). */
export type StatusWord =
  | "thinking" | "output" | "read" | "modify" | "tool" | "compacting"
  | "waiting" | "working" | "idle" | "crashed" | "stopped";

export const STATUS_WORDS: readonly StatusWord[] = Object.freeze([
  "thinking", "output", "read", "modify", "tool", "compacting",
  "waiting", "working", "idle", "crashed", "stopped",
]);

/** Word length tiers: 3 Chinese characters (6 columns) or 2 (4 columns). */
export type BadgeTier = 3 | 2;
export const BADGE_TIERS: readonly BadgeTier[] = Object.freeze([3, 2] as BadgeTier[]);

/**
 * Single source of truth for both tiers. Every word is a complete word: the
 * narrow tier never truncates, it has its own shorter wording (`已崩溃` → `崩溃`).
 */
export const BADGE_WORDS: Record<BadgeTier, Record<StatusWord, string>> = Object.freeze({
  3: Object.freeze({
    thinking: "思考中", output: "输出中", read: "读取中", modify: "写入中", tool: "执行中",
    compacting: "压缩中", waiting: "等待中", working: "工作中", idle: "空闲",
    crashed: "已崩溃", stopped: "已停止",
  }),
  2: Object.freeze({
    thinking: "思考", output: "输出", read: "读取", modify: "写入", tool: "执行",
    compacting: "压缩", waiting: "等待", working: "工作", idle: "空闲",
    crashed: "崩溃", stopped: "停止",
  }),
});

/** Fixed field width per tier; the lane starts at the same column for every row. */
export const BADGE_WIDTH: Record<BadgeTier, number> = Object.freeze({ 3: 6, 2: 4 });

/** Minimum lane width that justifies each tier (§C.2). */
export const TIER_MIN_LANE: Record<BadgeTier, number> = Object.freeze({ 3: 20, 2: 14 });

/** Left-aligned field of exactly `BADGE_WIDTH[tier]` columns (§Q16). */
export function badgeText(word: StatusWord, tier: BadgeTier): string {
  const text = BADGE_WORDS[tier]?.[word] ?? "";
  const width = BADGE_WIDTH[tier] ?? 0;
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * Pick the widest tier whose badge still leaves a usable timeline. `laneWith`
 * reports the lane width for a given badge width, so the module stays independent
 * of the row layout formula.
 */
export function pickTier(laneWith: (badgeWidth: number) => number): BadgeTier | "fallback" {
  for (const tier of BADGE_TIERS)
    if (laneWith(BADGE_WIDTH[tier]) >= TIER_MIN_LANE[tier]) return tier;
  return "fallback";
}

export interface StatusInput {
  state: MemberOperationalState;
  phase?: ActivityPhase;
  latest?: OverviewAction;
  /** The newest turn has no recorded end (`TimelineInfo.openTurnStart`). */
  turnOpen: boolean;
  /** A record exists at or after the last turn's start. */
  hasActionThisTurn: boolean;
}

/**
 * Badge word for one row. Control-plane states win over activity phases (the
 * same precedence the icon trail used), so a crash or a compaction is never
 * hidden behind a stale phase.
 */
export function statusWord(input: StatusInput): StatusWord {
  if (input.state === "compacting") return "compacting";
  if (input.state === "crashed") return "crashed";
  if (input.state === "stopped") return "stopped";
  if (input.state === "idle") return "idle";
  switch (input.phase) {
    case "thinking": return "thinking";
    case "output": return "output";
    case "tool-calling": return "tool";
    case "executing": {
      const latest = input.latest;
      if (latest?.status === "active") {
        if (latest.kind === "read") return "read";
        if (latest.kind === "modify") return "modify";
      }
      return "tool";
    }
    default:
      // No open turn, or nothing recorded since it opened: dispatched but silent.
      return !input.turnOpen || !input.hasActionThisTurn ? "waiting" : "working";
  }
}

/** The word's colour is its timeline semantic; grey words map to hue-free classes. */
export const STATUS_CLASS: Record<StatusWord, OpClass> = Object.freeze({
  thinking: "thinking",
  output: "output",
  read: "read",
  modify: "modify",
  tool: "tool",
  compacting: "compact",
  waiting: "busySilent",
  working: "busySilent",
  idle: "idle",
  crashed: "crash",
  stopped: "stop",
});

export function statusClass(word: StatusWord): OpClass {
  return STATUS_CLASS[word] ?? "idle";
}
