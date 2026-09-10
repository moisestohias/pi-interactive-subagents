/**
 * Result extraction (T4). Single home for the completion wording that was
 * triplicated across `watchSubagent` (pi + claude branches) and the resume
 * `.then` — same 4-way fallback with the intentional launch-vs-resume wording
 * distinction preserved via the `label` param.
 *
 * Shape per review D6: sync wording/extraction from already-read inputs (so
 * the single-read completion path in `watchSubagent` stays single-read, and
 * the resume C4 `result.summary` fallback stays at the call site) plus one
 * async `extractClaudeSummary` taking an injectable screen-reader (mirroring
 * `steerSubagent`'s injected `send` seam — unit-testable without kitty).
 * Sentinel cleanup reuses `cli/claude.ts:cleanupClaudeSentinel` at the call
 * sites (no new cleanup fn). Pure — no kitty/store imports.
 */
import { findLastAssistantMessage, type SessionEntry } from "./session.ts";

export type ResultLabel = "launch" | "resume" | "claude";

export interface SummaryOutcome {
  errorMessage?: string;
  exitCode: number;
}

/**
 * The 4-way fallback: last assistant message wins, then provider/agent
 * error, then non-zero exit, then the quiet-exit default. `label` selects
 * the intentional wording family (launch `Sub-agent…` vs resume
 * `Resumed session…` vs claude `Claude Code…`).
 */
export function summaryFallback(opts: {
  entriesSummary?: string | null;
  errorMessage?: string;
  exitCode: number;
  label: ResultLabel;
}): string {
  if (opts.entriesSummary) return opts.entriesSummary;
  if (opts.errorMessage) return `Subagent error: ${opts.errorMessage}`;
  if (opts.exitCode !== 0) {
    if (opts.label === "resume") return `Resumed session exited with code ${opts.exitCode}`;
    if (opts.label === "claude") return `Claude Code exited with code ${opts.exitCode}`;
    return `Sub-agent exited with code ${opts.exitCode}`;
  }
  if (opts.label === "resume") return "Resumed session exited without new output";
  if (opts.label === "claude") return "Claude Code exited without output";
  return "Sub-agent exited without output";
}

/**
 * Pi summary from already-read entries (callers own the single file read —
 * `watchSubagent` reads once for summary + stats; the resume `.then` reads
 * once from its baseline; C4 read-failure handling stays at the call sites).
 */
export function piSummaryFromEntries(
  entries: SessionEntry[],
  outcome: SummaryOutcome,
  label: "launch" | "resume",
): string {
  return summaryFallback({
    entriesSummary: findLastAssistantMessage(entries),
    errorMessage: outcome.errorMessage,
    exitCode: outcome.exitCode,
    label,
  });
}

/**
 * Claude summary from already-read inputs. `sentinelText` is the trimmed
 * sentinel content (null when absent/unreadable); `readScreen` is injected
 * (defaults are wired at the call site so this module stays kitty-free).
 */
export async function extractClaudeSummary(opts: {
  sentinelText: string | null;
  surface: string;
  exitCode: number;
  readScreen: (surface: string, lines: number) => Promise<string>;
}): Promise<string> {
  if (opts.sentinelText) return opts.sentinelText;
  try {
    const screen = (await opts.readScreen(opts.surface, 200))
      .replace(/__SUBAGENT_DONE_\d+__/, "")
      .trimEnd();
    if (screen) return screen;
  } catch {
    // Fall through to the quiet-exit default below.
  }
  return summaryFallback({ entriesSummary: null, exitCode: opts.exitCode, label: "claude" });
}
