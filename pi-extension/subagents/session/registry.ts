/**
 * Name registry: persistent name → session mapping per spawner session.
 * File format (`subagent-registry.json`) is a compat boundary across pi
 * restarts — do not change the shape.
 *
 * Compat-2: the file carries a top-level `version` (currently 1) alongside
 * the name → entry map. Readers tolerate its absence (pre-version writers)
 * and ignore unknown top-level keys; writers carry the `version` marker over
 * across read-modify-write so a newer schema tag survives an older writer.
 * (Unknown non-entry keys are NOT carried — M6 drops malformed entries for
 * good. New marker keys must be allowlisted in `splitRegistryFile`.)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /** Canonical session header id (kept for display/lineage). */
  sessionId: string | null;
  /**
   * Kitty window id of the tab left open by a keep-tab run, if any.
   * Lets resume refuse to double-open a session that is still alive.
   * Since H5, also persisted for *running* runs at launch (with `running`)
   * so `session_start` can re-watch live tabs orphaned by `/reload`.
   */
  surface?: string;
  /**
   * True while the run that owns `surface` is still watched (set at launch,
   * cleared when the completion handler re-registers). Lets recovery tell a
   * live run (re-watch it) from a kept tab (re-attach its monitor). Absent
   * (older writers) with `surface` means kept — the previous behavior.
   */
  running?: boolean;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

/** Schema version written by current writers (compat-2). */
export const NAME_REGISTRY_VERSION = 1;

/** Top-level registry file shape: version marker + name entries. */
interface NameRegistryFile {
  version?: unknown;
  [name: string]: unknown;
}

/** Split a parsed registry file into carried-over top-level keys + entries. */
function splitRegistryFile(parsed: Record<string, unknown>): {
  entries: NameRegistry;
  carried: Record<string, unknown>;
} {
  const entries: NameRegistry = {};
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value && typeof (value as NameRegistryEntry).sessionFile === "string") {
      entries[key] = value as NameRegistryEntry;
    } else if (key === "version") {
      carried[key] = value;
    }
    // Anything else shaped wrong is dropped for good (M6) — see the
    // compat-2 note on the module docblock before allowlisting new keys.
  }
  return { entries, carried };
}

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  try {
    const p = nameRegistryPath(artifactDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Compat-2: `version` and any other top-level marker keys are skipped
    // here (they are not name entries); writers carry them over.
    return splitRegistryFile(parsed as Record<string, unknown>).entries;
  } catch (err) {
    // Absent file returns {} silently above; only corrupt/unreadable logs.
    warnRegistryErrorOnce("read", err);
    return {};
  }
}

let warnedRegistryError = false;

function warnRegistryErrorOnce(where: string, err: unknown): void {
  // N17: disk-full/permission loss of resume handles must not vanish silently,
  // but must never break spawns either — log once, keep going best-effort.
  if (warnedRegistryError) return;
  warnedRegistryError = true;
  try {
    console.error(
      `[subagents] name-registry ${where} failed (resume-by-name may miss runs): ${(err as Error)?.message ?? err}`,
    );
  } catch {}
}

/**
 * Parse registry bytes, salvaging entries with a valid shape (M6). Returns
 * null when nothing is usable (unparseable, or a non-object like `[]`).
 */
function parseRegistryBytes(raw: string): NameRegistry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return splitRegistryFile(parsed as Record<string, unknown>).entries;
}

/**
 * Register (or overwrite) a name → session mapping. Atomic (temp + rename)
 * so concurrent readers never see a partial registry.
 *
 * M6: a corrupt registry is backed up (`subagent-registry.json.corrupt-<ts>`)
 * instead of silently clobbered — one torn write/disk-full/manual edit plus
 * the next spawn used to discard every prior handle permanently. Salvageable
 * entries are merged, never dropped.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    const p = nameRegistryPath(artifactDir);
    let registry: NameRegistry;
    // Compat-2: the `version` marker survives an older writer via
    // read-modify-write carry-over.
    let carried: Record<string, unknown> = {};
    try {
      if (!existsSync(p)) {
        registry = {};
      } else {
        const raw = readFileSync(p, "utf8");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const split = splitRegistryFile(parsed as Record<string, unknown>);
          registry = split.entries;
          carried = split.carried;
        } else {
          // Corrupt: preserve the bytes before overwriting.
          try {
            const backup = `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
            writeFileSync(backup, raw, "utf8");
          } catch {}
          warnRegistryErrorOnce("write", new Error("backed up corrupt registry, starting fresh"));
          registry = {};
          carried = {};
        }
      }
    } catch (err) {
      warnRegistryErrorOnce("write", err);
      registry = {};
      carried = {};
    }
    registry[name] = entry;
    const fileOut: NameRegistryFile = { version: NAME_REGISTRY_VERSION, ...carried, ...registry };
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(fileOut, null, 2), "utf8");
    renameSync(tmp, p);
  } catch (err) {
    // Best-effort only; never breaks the spawn itself.
    warnRegistryErrorOnce("write", err);
  }
}

/** Resolve a name to its registry entry, or null. */
export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  const entry = readNameRegistry(artifactDir)[name];
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}
