/**
 * runtime.ts — process-global keys + import-time rotation (P2 tail).
 *
 * AGENTS.md rule 4: these `Symbol.for` globals survive `/reload` by design —
 * a module whose *job* is owning them makes accidental cleanup a type error.
 * This module is deliberately free of `agents.ts` imports (cycle risk: agents
 * publishes into the process global; runtime must never import agents).
 *
 * Ordering preserved exactly from the index.ts import-time block it replaces:
 * clear widget interval → clear status interval → abort previous poll
 * controller → install a fresh controller.
 */

export const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
export const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
export const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");
export const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");

export const RuntimeKeys = {
  widgetInterval: WIDGET_INTERVAL_KEY,
  statusInterval: STATUS_INTERVAL_KEY,
  pollAbort: POLL_ABORT_KEY,
  runningChildrenCount: RUNNING_CHILDREN_COUNT_KEY,
} as const;

/**
 * The import-time rotation block (was inline in index.ts): stand down the
 * previous module instance's timers and abort its poll loops, then install a
 * fresh controller for this instance. Called once at import by the owner.
 */
export function rotateForFreshImport(): AbortSignal {
  const g = globalThis as any;
  const prevInterval = g[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    g[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = g[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    g[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = g[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  g[POLL_ABORT_KEY] = new AbortController();
  return (g[POLL_ABORT_KEY] as AbortController).signal;
}

/** This instance's module abort signal (fresh-controller-if-aborted included). */
export function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

/**
 * `session_start` guard (was inline in index.ts): a prior session's shutdown
 * aborts the shared controller, so install a fresh one when it is dead —
 * otherwise subagents spawned in this session are watched against a dead
 * signal. See https://github.com/HazAT/pi-interactive-subagents/issues/5
 */
export function ensureLiveAbortController(): void {
  const g = globalThis as any;
  const prevAbort = g[POLL_ABORT_KEY] as AbortController | undefined;
  if (!prevAbort || prevAbort.signal.aborted) {
    g[POLL_ABORT_KEY] = new AbortController();
  }
}

export function setWidgetInterval(
  handle: ReturnType<typeof setInterval> | null,
): void {
  (globalThis as any)[WIDGET_INTERVAL_KEY] = handle;
}

export function clearWidgetInterval(handle: ReturnType<typeof setInterval> | null): void {
  if (handle) clearInterval(handle);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
}

export function setStatusInterval(
  handle: ReturnType<typeof setInterval> | null,
): void {
  (globalThis as any)[STATUS_INTERVAL_KEY] = handle;
}

export function clearStatusInterval(handle: ReturnType<typeof setInterval> | null): void {
  if (handle) clearInterval(handle);
  (globalThis as any)[STATUS_INTERVAL_KEY] = null;
}

/**
 * Publish the live running-children count for the child side
 * (`subagent-done.ts` reads it; absent ⇒ zero). The writer used to live in
 * index.ts while the reader lives in `subagent-done-pure.ts` — both now go
 * through this key.
 */
export function publishRunningChildrenCount(count: () => number): void {
  (globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = count;
}

/** Read the published count (mirrors the `subagent-done-pure.ts` reader). */
export function runningChildrenCount(): number {
  try {
    const fn = (globalThis as any)[RUNNING_CHILDREN_COUNT_KEY];
    return typeof fn === "function" ? fn() : 0;
  } catch {
    return 0;
  }
}
