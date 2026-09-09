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
