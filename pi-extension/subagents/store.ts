/**
 * SubagentStore (R6). Owns the three identity layers that were previously
 * synced by hand in index.ts:
 *   - running: Map<id, RunningSubagent> (live runs)
 *   - kept: Map<artifactDir::name, KeptTab> (kept-open tabs)
 *   - on-disk subagent-registry.json (persistent name → session)
 * plus the `reservedNames` set for parallel-spawn races.
 *
 * Registry file format is unchanged (compat boundary).
 */
import { resolve } from "node:path";
import {
  readNameRegistry,
  registerName,
  type NameRegistry,
} from "./session.ts";
import { windowExistsOrNull } from "./kitty.ts";
import type { SubagentStatusState } from "./status.ts";
import type { SubagentActivityState } from "./activity.ts";

export interface RunningEntry {
  id: string;
  name: string;
  sessionFile: string;
  surface: string;
  /** Human task text (launch params / resume message). */
  task?: string;
  /** Agent profile name, when spawned with one. */
  agent?: string;
  /** Run start (ms epoch). */
  startTime?: number;
  /** Stable artifact script path of the launch/resume command. */
  launchScriptFile?: string;
  /** Per-run liveness file. */
  activityFile?: string;
  /** Latest observed activity snapshot. */
  activity?: SubagentActivityState;
  /** Last activity-file read outcome (observability for stall labels). */
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  /** Watcher abort (the tool's own signal completes on return). */
  abortController?: AbortController;
  /** Spawner session artifact dir owning this run (M1 shutdown scoping). */
  parentArtifactDir?: string;
  /** CLI backend (`"claude"` or unset for pi). */
  cli?: string;
  /** Claude sentinel file (claude path only). */
  sentinelFile?: string;
  /** Per-run keep decision: keepOpen && !autoExit. */
  keepSurface?: boolean;
  /** Effective auto-exit sent via PI_SUBAGENT_AUTO_EXIT (!keepSurface). */
  autoExit?: boolean;
  /** Status-machine state for stall/recovery supervision. */
  statusState?: SubagentStatusState;
  /** User-driven long runs skip stall/recovery steers (widget still updates). */
  interactive?: boolean;
  [key: string]: unknown;
}

/**
 * Canonical live-run shape (M2). The old index-local `RunningSubagent`
 * interface was a duplicate of `RunningEntry` plus casts at every boundary —
 * they are now one interface; `RunningSubagent` stays as an alias so
 * existing imports keep compiling.
 */
export type RunningSubagent = RunningEntry;

export interface KeptTab {
  name: string;
  agent?: string;
  surface: string;
  sessionFile: string;
  sessionId: string | null;
  parentArtifactDir: string;
  abort: AbortController;
  /** Original run start (ms epoch) so kept-tab questions report real elapsed (N9). */
  startTime: number;
}

export function keptKey(artifactDir: string, name: string): string {
  return `${artifactDir}::${name}`;
}

export class SubagentStore {
  readonly running = new Map<string, RunningEntry>();
  readonly kept = new Map<string, KeptTab>();
  readonly reserved = new Set<string>();

  // ── running ──────────────────────────────────────────────────────────────
  addRunning(entry: RunningEntry): void {
    this.running.set(entry.id, entry);
  }

  removeRunning(id: string): void {
    this.running.delete(id);
  }

  findRunningByName(name: string): RunningEntry[] {
    return [...this.running.values()].filter((r) => r.name === name);
  }

  findRunningBySessionFile(sessionFile: string): RunningEntry | null {
    const target = resolve(sessionFile);
    for (const r of this.running.values()) {
      try {
        if (resolve(r.sessionFile) === target) return r;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  // ── reservations (parallel-spawn race guard) ─────────────────────────────
  reserve(name: string): void {
    this.reserved.add(name);
  }

  release(name: string): void {
    this.reserved.delete(name);
  }

  /** Unique name across running + reserved + registry. */
  uniqueName(base: string, registryNames?: Set<string>): string {
    const taken = new Set([...this.running.values()].map((r) => r.name));
    for (const r of this.reserved) taken.add(r);
    if (registryNames) for (const n of registryNames) taken.add(n);
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  resolveRunningByName(name: string):
    | { running: RunningEntry }
    | { error: string } {
    const requestedName = name.trim();
    if (!requestedName) {
      return { error: "Provide the exact display name of a running subagent." };
    }
    const matches = this.findRunningByName(requestedName);
    if (matches.length === 1) return { running: matches[0] };
    if (matches.length === 0) {
      const names = [...this.running.values()].map((r) => r.name);
      const hint = names.length
        ? ` Currently running: ${[...new Set(names)].join(", ")}.`
        : " No subagents are currently running.";
      return { error: `No running subagent named "${requestedName}".${hint}` };
    }
    const candidates = matches.map((r) => `${r.name} [${r.id}]`).join(", ");
    return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
  }

  // ── kept tabs ────────────────────────────────────────────────────────────
  trackKept(
    parentArtifactDir: string,
    params: { name: string; agent?: string; surface: string; sessionFile: string; sessionId: string | null; startTime?: number },
    onReplace?: (prev: KeptTab) => void,
  ): KeptTab {
    const key = keptKey(parentArtifactDir, params.name);
    const prev = this.kept.get(key);
    if (prev) {
      try {
        prev.abort.abort();
      } catch {}
      onReplace?.(prev);
    }
    const kept: KeptTab = {
      ...params,
      startTime: params.startTime ?? Date.now(),
      parentArtifactDir,
      abort: new AbortController(),
    };
    this.kept.set(key, kept);
    return kept;
  }

  untrackKept(parentArtifactDir: string, name: string): void {
    this.kept.delete(keptKey(parentArtifactDir, name));
  }

  /**
   * Find a kept tab, pruning it (and clearing the stale registry surface)
   * when its window is gone. `exists` is injectable for tests.
   * T1b/S5: defaults to the N3 liveness probe (unknown ⇒ alive) so callers
   * never need the old `keptTabAlive` wrapper in index.ts.
   */
  findKept(
    artifactDir: string,
    name: string,
    exists: (surface: string) => boolean = (s) => windowExistsOrNull(s) !== false,
  ): KeptTab | null {
    const kept = this.kept.get(keptKey(artifactDir, name));
    if (!kept) return null;
    let alive: boolean;
    try {
      alive = exists(kept.surface);
    } catch {
      // N3: control-plane failure is UNKNOWN, not dead — keep the entry so a
      // socket hiccup never prunes a live kept tab (or its registry surface).
      return kept;
    }
    if (!alive) {
      this.kept.delete(keptKey(artifactDir, name));
      try {
        kept.abort.abort();
      } catch {}
      clearKeptSurface(artifactDir, name, kept);
      return null;
    }
    return kept;
  }

  clear(): void {
    this.running.clear();
    for (const kept of this.kept.values()) {
      try {
        kept.abort.abort();
      } catch {}
    }
    this.kept.clear();
    this.reserved.clear();
  }
}

/** Clear a stale `surface` from the registry so a later resume is allowed. */
export function clearKeptSurface(
  artifactDir: string,
  name: string,
  kept: { sessionFile: string; sessionId: string | null },
): void {
  try {
    const reg = readNameRegistry(artifactDir);
    if (reg[name]?.surface) {
      registerName(artifactDir, name, {
        sessionFile: kept.sessionFile,
        sessionId: kept.sessionId,
      });
    }
  } catch {}
}

/** Read this spawner session's registry names (for uniqueName). */
export function readRegistryNames(artifactDir: string): Set<string> {
  try {
    const reg: NameRegistry = readNameRegistry(artifactDir);
    return new Set(Object.keys(reg));
  } catch {
    return new Set();
  }
}
