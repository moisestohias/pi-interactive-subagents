/**
 * JSONL entry I/O. Pure file helpers with no registry/index knowledge.
 */
import { readFileSync } from "node:fs";
import type { MessageEntry, SessionEntry } from "./types.ts";

/**
 * Parse one JSONL line, returning null for blank/malformed lines.
 * Crash-torn files (killed child mid-append) are the norm, not the
 * exception — callers skip-and-continue rather than throwing (C4/M3).
 */
function parseEntryLine(line: string): SessionEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as SessionEntry;
  } catch {
    return null;
  }
}

export function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const out: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const entry = parseEntryLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Count entry lines without per-line JSON.parse (cheap pre-count for resume).
 * Mirrors getNewEntries' blank-line filtering.
 */
export function countSessionEntryLines(sessionFile: string): number {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  return readEntriesAfter(sessionFile, afterLine).entries;
}

/**
 * Single-pass variant: read once, return entries after `afterLine` plus the
 * total count. Prefer this on the resume path (which previously did a
 * counting read + a parsing read back-to-back on large transcripts).
 * Malformed lines are skipped (counted in `total`, excluded from `entries`)
 * so one torn line never converts a clean exit into an error (C4/M3).
 */
export function readEntriesAfter(
  sessionFile: string,
  afterLine: number,
): { entries: SessionEntry[]; total: number; skipped?: number } {
  const raw = readFileSync(sessionFile, "utf8");
  const rawLines = raw.split("\n");
  let total = 0;
  let skipped = 0;
  const parsed: SessionEntry[] = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    total++;
    const entry = parseEntryLine(line);
    if (entry) parsed.push(entry);
    else skipped++;
  }
  return {
    entries: parsed.slice(afterLine),
    total,
    ...(skipped ? { skipped } : {}),
  };
}

/**
 * Find the last assistant message text. Falls back to `errorMessage` when the
 * last turn ended with `stopReason: "error"` and no usable text (auto-retry
 * exhausted on overload / rate limit) so the parent sees the failure instead
 * of a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}
