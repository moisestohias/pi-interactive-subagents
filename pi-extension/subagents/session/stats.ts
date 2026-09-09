/**
 * Session stats for the result renderer: model, tool count, cumulative
 * tokens/cost, and live context occupancy.
 */
import { readEntries } from "./io.ts";
import type { MessageEntry, SessionEntry } from "./types.ts";

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

export function summarizeSessionStats(sessionFile: string): SessionStats | null {
  let entries: SessionEntry[];
  try {
    entries = readEntries(sessionFile);
  } catch {
    return null;
  }

  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;

    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const total = num(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }

  return stats;
}
