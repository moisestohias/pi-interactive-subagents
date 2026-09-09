/**
 * Name registry: persistent name → session mapping per spawner session.
 * File format (`subagent-registry.json`) is a compat boundary across pi
 * restarts — do not change the shape.
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
   */
  surface?: string;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

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
    return parsed as NameRegistry;
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
 * Register (or overwrite) a name → session mapping. Atomic (temp + rename)
 * so concurrent readers never see a partial registry.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    const registry = readNameRegistry(artifactDir);
    registry[name] = entry;
    const p = nameRegistryPath(artifactDir);
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
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
