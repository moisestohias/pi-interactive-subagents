/**
 * Pure helpers for the subagent child extension (extracted from
 * subagent-done.ts — R1). No pi dependency; fully unit-testable.
 */

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 * Reads the process-global published by index.ts; 0 when absent.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Whether the agent loop ending should shut the session down.
 *
 * M8 contract note: `_userTookOver` is currently IGNORED — the decision is
 * purely "latest assistant turn completed normally" (any stopReason except
 * "aborted", including "error" so overloads wake the parent via the
 * `.exit` sidecar). The parameter is kept so existing callers/tests don't
 * break and to reserve the slot for a future takeover-aware policy; do not
 * read it as influencing today's behavior. Manual input is still tracked by
 * the caller (`userTookOver` in subagent-done.ts) but only for diagnostics.
 */
export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message ended with `stopReason: "error"`, return its
 * error info; else null.
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
