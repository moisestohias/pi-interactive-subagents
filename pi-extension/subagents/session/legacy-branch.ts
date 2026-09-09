/**
 * @deprecated Retired branch/merge helpers. No production callers — kept only
 * so existing tests/imports don't break. Do not use in new code; prefer the
 * name-registry + resume flow. (R8/Q5 quarantine.)
 */
import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionEntry } from "./types.ts";
import { getNewEntries } from "./io.ts";

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const out: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip torn lines (killed child mid-append) — same policy as io.ts.
    }
  }
  return out;
}

/** @deprecated Return the id of the last entry (branch point / leaf). */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/** @deprecated Append a branch_summary entry; returns the new id. */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/** @deprecated Copy a session file to destDir; returns the copy path. */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/** @deprecated Append new entries from source to target; returns appended. */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}
