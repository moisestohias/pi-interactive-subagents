/**
 * Shared elapsed / token / context-window formatters.
 *
 * Single home for the three clocks that previously lived in different
 * modules (`formatElapsed` + `formatElapsedMMSS` in index.ts,
 * `formatElapsedDuration` in status.ts) plus the token/usage gauge helpers.
 * All functions are pure and side-effect free.
 */
import type { SessionStats } from "./session.ts";

/** Model context-window sizes by id substring. Extend here — not inline. */
export const MODEL_CONTEXT_WINDOWS: Array<{ match: string; window: number }> = [
  { match: "claude", window: 200_000 },
  { match: "gpt-4.1", window: 128_000 },
  { match: "gpt-4o", window: 128_000 },
  { match: "gemini", window: 1_000_000 },
];

/** Compact elapsed for results: "45s", "3m 12s". Input is seconds. Clamped at 0 (N14). */
export function formatElapsed(seconds: number): string {
  const s0 = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (s0 < 60) return `${s0}s`;
  const m = Math.floor(s0 / 60);
  const s = s0 % 60;
  return `${m}m ${s}s`;
}

/** Widget clock: "MM:SS" since startTime (ms epoch). Clamped at 0 (N14). */
export function formatElapsedMMSS(startTime: number, now: number = Date.now()): string {
  const seconds = Number.isFinite(now) && Number.isFinite(startTime)
    ? Math.max(0, Math.floor((now - startTime) / 1000))
    : 0;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Human duration for status snapshots: "45s", "3m", "2h 5m". Input is ms. */
export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}

/**
 * Unified duration entry point. Prefer this for new code; the three wrappers
 * above delegate here conceptually (kept as named exports for call-site
 * readability and test compat).
 */
export function formatDuration(
  value: number,
  style: "short-secs" | "mmss-since" | "human-ms" = "human-ms",
  now?: number,
): string {
  if (style === "short-secs") return formatElapsed(value);
  if (style === "mmss-since") return formatElapsedMMSS(value, now);
  return formatElapsedDuration(value);
}

/** Compact token count: 850, 3.2k, 45k. */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window size by model id substring, used for the context-usage
 * gauge. Unknown models fall back to undefined (window-less "Nk ctx" label).
 */
export function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (m.includes(entry.match)) return entry.window;
  }
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
export function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent: "↑in ↓out R… W… $cost".
 * `theme.fg` is applied by the caller; this returns plain segments.
 */
export function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}
