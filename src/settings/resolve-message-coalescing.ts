import type { TeamSettings } from "./settings";
import {
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_MAX_BATCH_CHARS,
} from "../channel/message-coalescer";
import type { CoalesceLimits } from "../channel/message-coalescer";

/** Effective message-coalescing configuration after applying fallbacks. */
export interface ResolvedMessageCoalescing extends CoalesceLimits {
  /** Master toggle. False = the dispatch layer skips coalescing entirely (fail-open, pre-S1 behavior). */
  enabled: boolean;
}

/**
 * Resolve the effective message-coalescing configuration.
 * Missing fields / invalid values fall back to the defaults
 * (enabled: true, 5 messages, 4000 chars).
 */
export function resolveMessageCoalescing(
  settings: TeamSettings
): ResolvedMessageCoalescing {
  const mc = settings.messageCoalescing;
  return {
    enabled: mc?.enabled ?? true,
    maxBatchSize: mc?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    maxBatchChars: mc?.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS,
  };
}

/**
 * Human-readable label for the message-coalescing setting (used in menus).
 * Examples: "开启 · 最多 5 条 · 4000 字符" / "关闭"
 */
export function describeMessageCoalescingSetting(settings: TeamSettings): string {
  const r = resolveMessageCoalescing(settings);
  if (!r.enabled) return "关闭";
  return `开启 · 最多 ${r.maxBatchSize} 条 · ${r.maxBatchChars} 字符`;
}
