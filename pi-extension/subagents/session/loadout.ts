/**
 * Loadout sidecar: resolved sandbox snapshot beside the session file so
 * resume replays the exact restriction instead of relaunching unrestricted.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface SubagentLoadout {
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when unrestricted (legacy). */
  toolAllowlist: string | null;
  /** Model id (without thinking suffix), or null for session default. */
  model: string | null;
  /** Thinking level appended as `model:level`, or null. */
  thinking: string | null;
  /** How identity was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** System-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config from, or null. */
  agentDir: string | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/** Persist a subagent's resolved sandbox loadout beside its session file. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  try {
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
  } catch {
    // Best-effort: missing snapshot means resume refuses, never unrestricted.
  }
}

/**
 * Validate a parsed loadout snapshot (M5). The resume path replays this
 * snapshot as a sandbox (`--no-extensions --tools …`); an unchecked cast
 * lets a hand-crafted / legacy / child-rewritten sidecar null out the
 * allowlist and relaunch with the parent's full toolset. `toolAllowlist`
 * must be a non-empty string — anything else refuses resume (the caller
 * surfaces the existing loadout-refusal instead of escalating).
 */
export function isValidSubagentLoadout(value: unknown): value is SubagentLoadout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const strOrNull = (k: string): boolean => v[k] === null || typeof v[k] === "string";
  if (!(v.agent === null || typeof v.agent === "string")) return false;
  if (typeof v.toolAllowlist !== "string" || v.toolAllowlist.trim() === "") return false;
  if (!strOrNull("model")) return false;
  if (!strOrNull("thinking")) return false;
  if (!(v.systemPromptMode === null || v.systemPromptMode === "append" || v.systemPromptMode === "replace"))
    return false;
  if (!strOrNull("identity")) return false;
  if (!(v.spawnable === null || (Array.isArray(v.spawnable) && v.spawnable.every((s) => typeof s === "string"))))
    return false;
  if (typeof v.autoExit !== "boolean") return false;
  if (!strOrNull("cwd")) return false;
  if (!strOrNull("agentDir")) return false;
  return true;
}

/** Read a subagent's loadout snapshot, or null if absent/unparseable/invalid. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!isValidSubagentLoadout(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
