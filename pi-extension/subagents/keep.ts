/**
 * Exit/keep decision. Single source of truth for the
 * config.json `tabs.keepOpen` × agent `auto-exit` precedence:
 *
 *   keepOpen=false + autoExit=*     → EXIT (global takes precedence)
 *   keepOpen=true  + autoExit=true  → EXIT (agent wants to close)
 *   keepOpen=true  + autoExit=false → KEEP (both agree to stay open)
 *
 * keep ⇔ (keepOpen && !autoExit); exit ⇔ !keep.
 */
import type { AgentDefaults } from "./agents.ts";
import { getExtensionConfig } from "./config.ts";

export interface KeepDecision {
  /** True ⇒ leave tab open + pi stays interactive. */
  keepSurface: boolean;
  /** Encoded into PI_SUBAGENT_AUTO_EXIT. Always !keepSurface. */
  effectiveAutoExit: boolean;
}

export function resolveKeepDecision(opts: {
  keepOpen: boolean;
  autoExit: boolean;
}): KeepDecision {
  const keepSurface = opts.keepOpen === true && opts.autoExit !== true;
  return { keepSurface, effectiveAutoExit: !keepSurface };
}

/** Per-agent decision from a loaded agent definition (missing def ⇒ autoExit=false). */
export function resolveKeepForAgent(
  keepOpen: boolean,
  agentDefs: AgentDefaults | null | undefined,
): KeepDecision {
  return resolveKeepDecision({ keepOpen, autoExit: agentDefs?.autoExit ?? false });
}

/** Resume is always autonomous ⇒ always closes (keepSurface=false). */
export function resolveResumeKeepDecision(): KeepDecision {
  return resolveKeepDecision({ keepOpen: false, autoExit: true });
}

/**
 * Config-driven keep lookup (moved from index.ts, behavior intact).
 * Reads `tabs.keepOpen` fresh — shell env is never consulted (the legacy
 * `PI_SUBAGENT_KEEP_TAB` wire is removed; only config.json decides).
 * No production callers (spawners use `resolveKeepDecision` directly with
 * the per-run agent flag); kept for `__test__` compat.
 */
export function shouldKeepSurface(): boolean {
  return getExtensionConfig().tabs.keepOpen === true;
}

/** Per-agent keep decision: only keep when config allows AND the agent opts out of auto-exit. */
export function shouldKeepSurfaceFor(autoExit: boolean): boolean {
  return resolveKeepDecision({ keepOpen: getExtensionConfig().tabs.keepOpen === true, autoExit }).keepSurface;
}

/** Per-agent keep decision from a loaded agent definition (missing def ⇒ autoExit=false). */
export function shouldKeepForAgent(agentDefs: AgentDefaults | null): boolean {
  return resolveKeepForAgent(getExtensionConfig().tabs.keepOpen === true, agentDefs).keepSurface;
}
