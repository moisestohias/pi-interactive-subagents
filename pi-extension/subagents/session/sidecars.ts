/**
 * session/sidecars.ts — atomic sidecar IO (T8, dependency-free tail).
 *
 * Single home for the "atomic file handoff" protocol (AGENTS.md rule 3):
 * tmp+rename writes, rename-before-read claims. Deliberately depends only on
 * `node:fs` / `node:path` — the child side (`subagent-done.ts`) runs in the
 * child process and must never pull the `session.ts` barrel transitively.
 *
 * Policies preserved per callsite (NOT unified — they are deliberately
 * different; see review D-constraints):
 * - `.exit` wins over `.done`; both claimed via rename, delete-on-read,
 *   fire-once. A corrupt `.exit` is *consumed, not retried* (kitty.ts N5).
 * - `.ask` claims restore-or-park via the caller's M2 queue (lifecycle.ts);
 *   torn `.ask` uses the compat-1 retain-then-retry gate at the callsite.
 * - Registry corrupt handling lives in `session/registry.ts` (M6 backup);
 *   activity writes use `atomicWriteJson` shape but stay in `activity.ts`
 *   (T7-deferred — not moved here).
 *
 * Corrupt-drop observability: this module never drops silently — `takeSidecar`
 * reports corrupts via the injected `onCorrupt` (callers pass kitty's
 * `logCorruptDrop`; tests pass a spy). Missing #4.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SidecarExt = ".ask" | ".done" | ".exit";

export interface TakeSidecarResult {
  /** How the sidecar completed. */
  reason: "done" | "error";
  /** Shell exit code (from sentinel-style payloads). 0 for file-based exits. */
  exitCode: number;
  /** Error message when reason is "error". */
  errorMessage?: string;
  /**
   * True when a corrupt `.exit` was consumed-and-dropped (parent must fall
   * through to `.done`, exactly as the historical kitty.ts path did).
   */
  corruptExitConsumed?: boolean;
}

/**
 * Atomic JSON write: tmp file + rename so concurrent pollers never observe a
 * partway-flushed payload (C3/H3). The parent's rename-claim would otherwise
 * grab a truncated file, fail JSON.parse, and delete a real signal as
 * "corrupt" while the child's remaining bytes go to the renamed inode.
 */
export function atomicWriteJson(target: string, data: unknown): void {
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch {}
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(data), "utf8");
  renameSync(tmp, target);
}

/**
 * Atomic claim (rename-before-read): returns the claim path, or null when
 * absent / already claimed by another consumer (race lost → ENOENT on
 * rename). Shared by `.exit`, `.done`, and `.ask` so each signal fires
 * exactly once even with concurrent consumers (M1/C3).
 */
export function claimFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const claim = `${path}.consuming-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      renameSync(path, claim);
    } catch {
      return null; // another consumer claimed it
    }
    return claim;
  } catch {
    return null;
  }
}

/**
 * Read a claimed file as JSON. Returns `{ ok: true, value }` on success;
 * on corrupt JSON deletes the claim and returns `{ ok: false }` (the
 * consume-don't-retry policy for completion sidecars). Never throws.
 */
export function readJsonClaim<T>(claimPath: string): { ok: true; value: T } | { ok: false } {
  try {
    const value = JSON.parse(readFileSync(claimPath, "utf-8")) as T;
    try {
      rmSync(claimPath, { force: true });
    } catch {}
    return { ok: true, value };
  } catch {
    try {
      rmSync(claimPath, { force: true });
    } catch {}
    return { ok: false };
  }
}

function interpretExitPayload(data: any): TakeSidecarResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

/**
 * Consume a completion sidecar next to the session file, if present.
 * `.exit` (error) wins over `.done` (clean finish on a keep-open run).
 * Returns null when neither exists. Files are claimed via rename and deleted
 * on read so each signal fires once. A corrupt `.exit` is consumed (not
 * retried — N5, otherwise it poisons the poll loop forever) and reported via
 * `onCorrupt`; the call then falls through to `.done`.
 */
export function takeSidecar(
  sessionFile: string,
  opts?: { ignoreDone?: boolean; onCorrupt?: (kind: string, path: string, reason: string) => void },
): TakeSidecarResult | null {
  try {
    const exitFile = `${sessionFile}.exit`;
    if (existsSync(exitFile)) {
      const claim = claimFile(exitFile);
      if (!claim) return null; // another consumer claimed it
      const read = readJsonClaim<any>(claim);
      if (read.ok) return interpretExitPayload(read.value);
      // Corrupt sidecar consumed (not retried): fall through to `.done`.
      try {
        opts?.onCorrupt?.("exit-sidecar", exitFile, "torn-json-consumed");
      } catch {}
      return takeDoneSidecar(sessionFile, opts);
    }
  } catch {}
  return takeDoneSidecar(sessionFile, opts);
}

function takeDoneSidecar(
  sessionFile: string,
  opts?: { ignoreDone?: boolean; onCorrupt?: (kind: string, path: string, reason: string) => void },
): TakeSidecarResult | null {
  void opts?.onCorrupt;
  try {
    // M9: kept-tab monitors pass `ignoreDone` — after the first result the
    // session stays interactive, so a second `.done` must not end supervision.
    if (opts?.ignoreDone) return null;
    const doneFile = `${sessionFile}.done`;
    if (existsSync(doneFile)) {
      // Presence alone is the signal — no parse, so a valid `.done` is
      // never dropped as "corrupt".
      const claim = claimFile(doneFile);
      if (!claim) return null; // another consumer claimed it
      try {
        rmSync(claim, { force: true });
      } catch {}
      return { reason: "done", exitCode: 0 };
    }
  } catch {}
  return null;
}
