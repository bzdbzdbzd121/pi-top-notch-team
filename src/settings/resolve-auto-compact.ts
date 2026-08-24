import type { TeamSettings } from "./settings";

/** Default compaction threshold (percent of context window) when none is configured. */
export const DEFAULT_THRESHOLD_PERCENT = 80;
/** Default wait time for the compaction RPC to complete, in minutes. */
export const DEFAULT_TIMEOUT_MINUTES = 10;

/** Context usage snapshot of a member (from get_session_stats). */
export interface ContextUsage {
  percent: number;
  tokens: number;
}

/** Effective auto-compaction configuration after applying fallbacks. */
export interface ResolvedAutoCompact {
  enabled: boolean;
  /** Effective percent threshold (1–100). Undefined = percent unrestricted. */
  thresholdPercent?: number;
  /** Effective absolute-token threshold. Undefined = tokens unrestricted. */
  thresholdTokens?: number;
  /** How long to wait for the compaction RPC before failing open. */
  timeoutMinutes: number;
  /**
   * True when `thresholdPercent` was filled in by the default fallback
   * (enabled but neither threshold configured). UI uses this to display
   * the effective configuration honestly ("80%（默认）").
   */
  percentIsDefaultFallback: boolean;
}

/**
 * Resolve the effective auto-compaction configuration.
 *
 * Fallback rule: when enabled but neither threshold is configured,
 * the default percent threshold (80) applies and is flagged via
 * `percentIsDefaultFallback` so the UI can surface it.
 */
export function resolveAutoCompact(settings: TeamSettings): ResolvedAutoCompact {
  const ac = settings.autoCompact;
  const resolved: ResolvedAutoCompact = {
    enabled: ac.enabled,
    thresholdPercent: ac.thresholdPercent,
    thresholdTokens: ac.thresholdTokens,
    timeoutMinutes: Math.max(1, Math.floor(ac.timeoutMinutes)),
    percentIsDefaultFallback: false,
  };
  if (
    resolved.enabled &&
    resolved.thresholdPercent === undefined &&
    resolved.thresholdTokens === undefined
  ) {
    resolved.thresholdPercent = DEFAULT_THRESHOLD_PERCENT;
    resolved.percentIsDefaultFallback = true;
  }
  return resolved;
}

/**
 * Decide whether a member's context usage exceeds the compaction threshold.
 * OR semantics: any configured threshold that is met triggers compaction.
 */
export function shouldCompact(usage: ContextUsage, resolved: ResolvedAutoCompact): boolean {
  if (!resolved.enabled) return false;
  if (resolved.thresholdPercent !== undefined && usage.percent >= resolved.thresholdPercent) {
    return true;
  }
  if (resolved.thresholdTokens !== undefined && usage.tokens >= resolved.thresholdTokens) {
    return true;
  }
  return false;
}

/** Format a token count compactly: 150000 → "150K", 1_500_000 → "1.5M". */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(tokens);
}

/**
 * Human-readable label for the auto-compaction setting (used in menus).
 * Examples:
 *   "开启 · 阈值 80%（默认）· 超时 10 分钟"
 *   "开启 · 阈值 70% 或 150K tokens · 超时 15 分钟"
 *   "关闭"
 */
export function describeAutoCompactSetting(settings: TeamSettings): string {
  const r = resolveAutoCompact(settings);
  if (!r.enabled) return "关闭";

  const parts: string[] = [];
  if (r.thresholdPercent !== undefined) {
    parts.push(`${r.thresholdPercent}%${r.percentIsDefaultFallback ? "（默认）" : ""}`);
  }
  if (r.thresholdTokens !== undefined) {
    parts.push(`${formatTokens(r.thresholdTokens)} tokens`);
  }
  const thresholdText = parts.length > 0 ? parts.join(" 或 ") : "无";
  return `开启 · 阈值 ${thresholdText} · 超时 ${r.timeoutMinutes} 分钟`;
}
