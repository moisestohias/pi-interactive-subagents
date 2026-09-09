/**
 * Activity → status bridge (R9). The translation that lived inline in
 * index.ts:observeRunningSubagent now lives at the seam, next to
 * observeStatus, so index.ts calls one function.
 */
import type { SubagentActivityState } from "./activity.ts";
import { observeStatus, type StatusObservation, type SubagentStatusState } from "./status.ts";
import type { ActivityReadResult } from "./activity.ts";
import { readSubagentActivityFile } from "./activity.ts";

/** Single label pipeline: activity → label (undefined unless active). */
export function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

/** Translate a present activity snapshot into a StatusObservation. */
export function statusObservationFromActivity(activity: SubagentActivityState): StatusObservation {
  return {
    snapshot: "present",
    updatedAt: activity.updatedAt,
    sequence: activity.sequence,
    phase: activity.phase,
    active: activity.phase === "active",
    activeScope: activity.activeScope,
    activeSince: activity.activeSince,
    waitingSince: activity.waitingSince,
    latestEvent: activity.latestEvent,
    activityLabel: activityLabel(activity),
  };
}

export interface ObservedRunning {
  activity?: SubagentActivityState;
  activityRead: { ok: boolean; reason?: "missing" | "invalid" | "wrong-id"; error?: string };
  statusState: SubagentStatusState;
}

/**
 * Observe a running subagent's activity file and advance its status state.
 * Pure-ish: mutates `running.activity*` / `running.statusState` like the
 * historical inline version, but the mapping lives here and is unit-testable.
 */
export function observeRunningSubagent(
  running: {
    id: string;
    cli?: string;
    activityFile?: string;
    activity?: SubagentActivityState;
    activityRead?: ObservedRunning["activityRead"];
    statusState: SubagentStatusState;
  },
  observedAt = Date.now(),
): void {
  if (running.cli === "claude") return;

  const result: ActivityReadResult = running.activityFile
    ? readSubagentActivityFile(running.activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = result.ok
    ? { ok: true }
    : { ok: false, reason: result.reason, error: result.error };

  if (result.ok) {
    running.activity = result.activity;
    running.statusState = observeStatus(
      running.statusState,
      statusObservationFromActivity(result.activity),
      observedAt,
    );
    return;
  }

  running.statusState = observeStatus(
    running.statusState,
    { snapshot: result.reason, snapshotError: result.error },
    observedAt,
  );
}
