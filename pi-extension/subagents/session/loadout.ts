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

/** Read a subagent's loadout snapshot, or null if absent/unparseable. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SubagentLoadout;
  } catch {
    return null;
  }
}
