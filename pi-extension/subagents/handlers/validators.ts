/**
 * handlers/validators.ts — pure tool-handler policy (Phase 4a, T5).
 *
 * The `subagent` / `subagent_message` executes mix pure gating (testable
 * without kitty, sessions, or registries) with effects (tabs, watchers).
 * This module owns the pure half; the effectful executes in `spawn.ts` /
 * `message.ts` call these and translate failures into tool results.
 *
 * New tests import this home directly (M3 rule — no `__test__` indirection).
 */

/** Self-spawn guard: an agent must never spawn its own profile. */
export function validateSelfSpawn(
  requestedAgent: string | undefined,
  currentAgent: string | undefined,
): { ok: true } | { ok: false; text: string; details: { error: string } } {
  if (requestedAgent && currentAgent && requestedAgent === currentAgent) {
    return {
      ok: false,
      text:
        `You are the ${currentAgent} agent — do not start another ${currentAgent}. ` +
        `You were spawned to do this work yourself. Complete the task directly.`,
      details: { error: "self-spawn blocked" },
    };
  }
  return { ok: true };
}

export interface AllowlistCtx {
  /** This caller's permitted set (`PI_SUBAGENT_ALLOWED`), or null when unrestricted. */
  allowlisted: Set<string> | null;
  /** Every discoverable agent (exactly what `subagents_list` shows). */
  discoverable: string[];
}

/**
 * Strict allowlist gate at every depth (pure half): every spawn must name an
 * agent in the caller's permitted set. The lone exception is a top-level
 * `fork: true` clone, which has no role and inherits the caller's own
 * already-trusted toolset. Without this guard a missing or unknown `agent`
 * silently launches an unrestricted, full-toolset child.
 */
export function validateSpawnParams(
  params: { agent?: string },
  ctx: AllowlistCtx,
): { ok: true; permitted: Set<string> } | { ok: false; text: string; details: { error: string } } {
  const permittedAgents = ctx.allowlisted ? [...ctx.allowlisted] : ctx.discoverable;
  const permittedSet = new Set(permittedAgents);
  const permittedList = permittedAgents.join(", ") || "(none)";

  if (!params.agent) {
    return {
      ok: false,
      text:
        `You must specify which agent to spawn via the "agent" field. ` +
        `Available agents: ${permittedList}.`,
      details: { error: "agent required" },
    };
  }
  if (!permittedSet.has(params.agent)) {
    return {
      ok: false,
      text:
        `You may not spawn the "${params.agent}" agent — it is not ` +
        `${ctx.allowlisted ? "in your allowlist" : "a known agent"}. ` +
        `Available agents: ${permittedList}.`,
      details: {
        error: ctx.allowlisted ? "agent not in allowlist" : "unknown agent",
      },
    };
  }
  return { ok: true, permitted: permittedSet };
}

/**
 * C1 tool-boundary validation (pure half): display `name` lands in `# …`
 * preamble comments of a `bash`-executed script file, and `cwd` feeds
 * `join()`-derived paths in the same comments. Interior newlines would escape
 * the comment and execute as shell — rejected here; the sink in
 * `sendLongCommand` re-validates defensively.
 */
export function validateNameCwd(
  params: { name?: string; cwd?: string },
): { ok: true } | { ok: false; text: string; details: { error: string } } {
  if (params.name != null && /[\r\n\0]/.test(params.name)) {
    return {
      ok: false,
      text: "`name` must not contain newline or control characters.",
      details: { error: "invalid name" },
    };
  }
  if (params.cwd != null && /[\r\n\0]/.test(params.cwd)) {
    return {
      ok: false,
      text: "`cwd` must not contain newline or control characters.",
      details: { error: "invalid cwd" },
    };
  }
  return { ok: true };
}

export type SteerResumeDecision =
  | { kind: "steer" }
  | { kind: "resume" }
  | { kind: "error"; text: string; details: { error: string } };

/**
 * Steer-vs-resume dispatch (pure half of the `subagent_message` head).
 * The rule: a live run steers; "No running subagent" is NOT an error — it
 * falls through to the resume-by-name path; ambiguity IS an error and
 * surfaces instead of steering a random match. The caller matches on
 * `kind`; the resume path performs its own registry/kept/liveness guards.
 */
export function decideSteerResume(
  resolution: { running: unknown } | { error: string },
): SteerResumeDecision {
  if ("running" in resolution) return { kind: "steer" };
  if (!resolution.error.startsWith("No running subagent")) {
    return { kind: "error", text: resolution.error, details: { error: resolution.error } };
  }
  return { kind: "resume" };
}

/**
 * Loadout-refusal wording (pure): resume replays the spawn-time sandbox
 * snapshot; without it a relaunch would load every global extension + the
 * full toolset, so resume refuses rather than escalate (M5).
 */
export function loadoutRefusalText(name: string): string {
  return (
    `Cannot safely resume "${name}": no sandbox snapshot found for this session ` +
    `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
    `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
    `Re-run the task as a fresh subagent instead.`
  );
}

/** Missing-session-file refusal (pure wording, shared by spawn + resume). */
export function missingSessionFileText(name: string, sessionPath: string): string {
  return (
    `Subagent "${name}" is registered but its session file is gone ` +
    `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`
  );
}
