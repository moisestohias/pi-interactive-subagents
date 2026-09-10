/**
 * Session-id → file index cache. Performance-critical: naive resolution walks
 * every .jsonl and reads each header (measured ~67s on a 2010-file tree on
 * the extension host's single thread). This builds once per root and
 * validates cheaply (dir listing + stat-only mtime checks) thereafter.
 *
 * QUARANTINED (L5) — do not build new callers on this module. Known traps
 * for the next reader:
 * - `getSessionIndex` calls `indexDir` on EVERY branch (including the
 *   signature-unchanged fast path), so every lookup still walks the whole
 *   tree with sync `readdir`+`stat`. The top-level signature never
 *   short-circuits; treat every call as a full walk.
 * - `lookupSessionIndex` prefix-matches and silently returns the newest
 *   mtime on collision (newest-wins, ambiguity swallowed). Callers needing
 *   exact resolution must check for collisions themselves.
 * Either adopt it properly (early-out on unchanged signature + surface
 * ambiguity instead of newest-wins) or leave it alone. Production callers:
 * none (barrel re-export + tests only).
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Read only the first line without loading the whole file (headers are line 1). */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a);
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/** Canonical session header id (what pi's `--session <id>` resolves against). */
export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

interface SessionIndex {
  idToFile: Map<string, { path: string; mtime: number }>;
  files: Map<string, number>;
  topSig: string;
}
const sessionIndexCache = new Map<string, SessionIndex>();

function topLevelSignature(root: string): string {
  const parts: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      let m = 0;
      try {
        m = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      parts.push(`d:${e.name}:${m}`);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      parts.push(`f:${e.name}`);
    }
  }
  parts.sort();
  return parts.join("|");
}

function indexDir(dir: string, idx: SessionIndex): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      indexDir(full, idx);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const known = idx.files.get(full);
      if (known !== undefined && known === mtime) continue;
      const id = readHeaderId(full);
      idx.files.set(full, mtime);
      if (!id) continue;
      const prev = idx.idToFile.get(id);
      if (!prev || mtime >= prev.mtime) {
        idx.idToFile.set(id, { path: full, mtime });
      }
    }
  }
}

function getSessionIndex(sessionsRoot: string): SessionIndex {
  let idx = sessionIndexCache.get(sessionsRoot);
  const sig = topLevelSignature(sessionsRoot);
  if (!idx) {
    idx = { idToFile: new Map(), files: new Map(), topSig: sig };
    sessionIndexCache.set(sessionsRoot, idx);
    indexDir(sessionsRoot, idx);
  } else if (idx.topSig !== sig) {
    idx.topSig = sig;
    indexDir(sessionsRoot, idx);
  } else {
    indexDir(sessionsRoot, idx);
  }
  return idx;
}

function lookupSessionIndex(
  idx: { idToFile: Map<string, { path: string; mtime: number }> },
  sessionId: string,
): string | null {
  const exact = idx.idToFile.get(sessionId);
  if (exact && existsSync(exact.path)) return exact.path;

  let best: { path: string; mtime: number } | null = null;
  for (const [id, rec] of idx.idToFile) {
    if (!id.startsWith(sessionId)) continue;
    if (!existsSync(rec.path)) continue;
    if (!best || rec.mtime > best.mtime) best = rec;
  }
  return best ? best.path : null;
}

export function resolveSessionFileById(sessionId: string, sessionsRoot: string): string | null {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

/**
 * Async variant: yields to the event loop before the sync scan so the UI can
 * repaint. Heavy work happens once per process (then incrementally).
 */
export async function resolveSessionFileByIdAsync(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  await new Promise<void>((r) => setImmediate(r));
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

/** Test hook: drop the cached index so tests start clean. */
export function resetSessionIndexCache(): void {
  sessionIndexCache.clear();
}
