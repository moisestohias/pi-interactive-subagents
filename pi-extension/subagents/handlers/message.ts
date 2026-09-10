/**
 * handlers/message.ts — `subagent_message` tool execute (T5, Phase 4b).
 *
 * Thin + effectful: steer-vs-resume dispatch via `validators.ts`
 * (`decideSteerResume`: ambiguity→error vs missing→resume-fallthrough),
 * orchestration via `lifecycle.ts` (store, watch, refresh arms). The resume
 * guards stay in the handler (kept-tab double-open refusal, stale-sidecar
 * unlink after reservation, loadout refusal, `entryCountBefore` counting) —
 * only assembly lives in `launch.ts:buildPiResumePlan` (T3).
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { decideSteerResume, loadoutRefusalText, missingSessionFileText } from "./validators.ts";
import {
  findKeptTab,
  getShellReadyDelayMs,
  muxUnavailableResult,
  reservedNames,
  runningSubagents,
  shouldNotifyResult,
  startStatusRefresh,
  startWidgetRefresh,
  subagentStore,
  updateWidget,
  watchSubagent,
  type RunningEntry,
} from "../lifecycle.ts";
import { getArtifactDir } from "../paths.ts";
import {
  getNewEntries,
  getSessionId,
  readEntriesAfter,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
} from "../session.ts";
import { piSummaryFromEntries } from "../results.ts";
import { notifyError, notifyResult } from "../notifications.ts";
import {
  closeSurface,
  createSurface,
  isKittyAvailable,
  sendCommand,
  sendCommandAsync,
  sendLongCommand,
  windowExistsOrNull,
} from "../kitty.ts";
import { getSubagentActivityFile } from "../activity.ts";
import { buildPiResumePlan, scriptPreambleFor } from "../launch.ts";
import { createStatusState, forceStatusAfterInterrupt } from "../status.ts";
import { observeRunningSubagent } from "../status-bridge.ts";

export const SubagentMessageParams = Type.Object({
  name: Type.String({
    description:
      "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
  }),
  message: Type.String({
    description:
      "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
  }),
});

export interface MessageCtx {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd?: string;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
export function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

/**
 * Type a follow-up message into a running subagent's live tab. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
/** Shared steer payload: newlines flattened (typed into a terminal). */
export function flattenSteerMessage(message: string): string {
  return message.replace(/\s*\n\s*/g, " ").trim();
}

export function steerSubagent(
  running: RunningEntry,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = flattenSteerMessage(message);
  try {
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via kitty tab: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

/** True when the send failed because kitty liveness is unknown (Missing #3). */
function isControlPlaneUnknownError(error: any): boolean {
  return /control plane unreachable|socket hiccup/i.test(error?.message ?? String(error));
}

/**
 * Async steer (M11): same delivery over `sendCommandAsync` so the
 * control-plane round-trips don't block the extension host. Missing #3:
 * one retry after a short delay when the control plane is *unknown*
 * (transient socket hiccup) — steers were the only path with no retry
 * while questions retry next tick by design. Positively-dead tabs fail
 * fast with no retry. Sync `steerSubagent` stays for tests/startup.
 */
export async function steerSubagentAsync(
  running: RunningEntry,
  message: string,
  send: (surface: string, command: string) => unknown = sendCommandAsync,
): Promise<{ ok: true } | { error: string }> {
  const flattened = flattenSteerMessage(message);
  const fail = (error: any) => ({
    error:
      `Failed to deliver message to subagent "${running.name}" via kitty tab: ` +
      `${error?.message ?? String(error)}`,
  });
  try {
    await send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    if (!isControlPlaneUnknownError(error)) return fail(error);
    await new Promise<void>((r) => setTimeout(r, 250));
    try {
      await send(running.surface, flattened);
      return { ok: true };
    } catch (retryError: any) {
      return fail(retryError);
    }
  }
}

export async function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => unknown = sendCommandAsync,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = subagentStore.resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = await steerSubagentAsync(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState!, now);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

export async function executeMessage(
  pi: ExtensionAPI,
  params: typeof SubagentMessageParams.static,
  ctx: MessageCtx,
) {
  const requestedName = params.name?.trim();
  if (!requestedName) {
    const err = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }
  // C1: the resume preamble interpolates this name into `# …`
  // comments of a `bash`-executed script (covered at the sink too).
  if (/[\r\n\0]/.test(requestedName)) {
    const err = "`name` must not contain newline or control characters.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  if (!isKittyAvailable()) {
    return muxUnavailableResult();
  }

  // ── Steer a running subagent ──
  // M2: resolve via the store so duplicates (e.g. spawned before the dedupe
  // fix) surface an ambiguity error instead of steering a random match.
  // Pure dispatch rule (`decideSteerResume`): a live run steers; "No running
  // subagent" falls through to resume-by-name below; ambiguity errors out.
  {
    const resolution = subagentStore.resolveRunningByName(requestedName);
    const decision = decideSteerResume(
      resolution as { running: unknown } | { error: string },
    );
    if (decision.kind === "steer" && "running" in resolution) {
      return handleSubagentSteer({ name: resolution.running.name, message: params.message });
    }
    if (decision.kind === "error") {
      return {
        content: [{ type: "text" as const, text: decision.text }],
        details: { error: decision.details.error },
      };
    }
    // "resume" (no running subagent) falls through to resume-by-name below.
  }

  // ── Resume a finished session by name ──
  const message = params.message;
  const name = requestedName; // identity preservation: the resumed run reclaims its name
  const { autoExit, interactive } = resolveResumeLaunchBehavior();
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  // Resolve the name to its session file via this session's registry.
  const parentArtifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    ctx.sessionManager.getSessionId(),
  );
  const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
  if (!entry) {
    const known = Object.keys(readNameRegistry(parentArtifactDir));
    const err =
      `No subagent named "${requestedName}" in this session. ` +
      (known.length > 0
        ? `Known subagents: ${known.join(", ")}.`
        : "No subagents have been spawned in this session yet.");
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const sessionPath = entry.sessionFile;
  if (!sessionPath || !existsSync(sessionPath)) {
    const err = missingSessionFileText(requestedName, sessionPath);
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  // H6: reserve the resume synchronously (before any `await`) so two
  // concurrent `subagent_message({ name })` calls cannot both pass the
  // guards below and double-open one `.jsonl` with two pi processes.
  // The key lives in its own `resume::` namespace so spawn-time
  // `uniqueRunningName` dedupe (which consults the same set) is
  // unaffected. Missing #5: the reservation precedes the stale
  // `.done`/`.exit` unlink below, making that ordering structural.
  const resumeKey = `resume::${parentArtifactDir}::${requestedName}`;
  if (reservedNames.has(resumeKey)) {
    const err =
      `A resume for subagent "${requestedName}" is already in progress. ` +
      `Retry in a moment, or steer it by name if it is running.`;
    return { content: [{ type: "text" as const, text: err }], details: { error: "resume in progress", name: requestedName } };
  }
  reservedNames.add(resumeKey);
  let resumeReleased = false;
  const releaseResume = () => {
    if (!resumeReleased) {
      resumeReleased = true;
      reservedNames.delete(resumeKey);
    }
  };

  // Guard: never resume a session that is still running — two processes
  // mutating the same .jsonl corrupts it. Steer it by name instead.
  // S11: single-home session-file compare (store owns the try/catch).
  {
    const live = subagentStore.findRunningBySessionFile(sessionPath) as unknown as RunningEntry | null;
    if (live) {
      const err = `Subagent "${requestedName}" is still running as "${live.name}". Your message will steer it; resending as a steer.`;
      releaseResume();
      return handleSubagentSteer({ name: live.name, message: params.message });
    }
  }

  // A kept tab is still ONE live pi process: steer the reply into it
  // (same safe path as steering a running subagent). Only refuse a
  // resume relaunch while the tab is alive — two pi processes must never
  // append to one .jsonl.
  if (entry.surface) {
    const kept = findKeptTab(parentArtifactDir, requestedName);
    if (kept) {
      const steer = await steerSubagentAsync(
        { surface: kept.surface, name: kept.name } as RunningEntry,
        params.message,
      );
      if (!("error" in steer)) {
        releaseResume();
        return {
          content: [{
            type: "text" as const,
            text:
              `Message delivered to "${requestedName}" in its kept tab. It picks this up at its next ` +
              `turn boundary.` ,
          }],
          details: { name: requestedName, status: "steered-kept" },
        };
      }
    }
    if (windowExistsOrNull(entry.surface) !== false) {
      const err =
        `Subagent "${requestedName}" is still open in its kept tab. ` +
        `Type your follow-up directly in that tab, or close the tab and retry.`;
      releaseResume();
      return { content: [{ type: "text" as const, text: err }], details: { error: err } };
    }
  }

  // A new watcher is starting: drop completion sidecars from any earlier
  // run so a stale `.done`/`.exit` can't complete the new run instantly.
  for (const ext of [".done", ".exit"]) {
    try {
      unlinkSync(`${sessionPath}${ext}`);
    } catch {}
  }

  // Reconstruct the sandbox from the snapshot written at spawn time.
  // Without it we cannot safely resume: relaunching bare would load every
  // global extension + the full toolset. Refuse rather than escalate.
  const loadout = readSubagentLoadout(sessionPath);
  if (!loadout) {
    const err = loadoutRefusalText(requestedName);
    releaseResume();
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;

  // Record the new-entries baseline on the parsed-entry basis the
  // completion path slices with (M7): `getNewEntries(f, n)` returns
  // `parsed.slice(n)`, so the baseline must be the parsed length at
  // resume time (`total - skipped`), not a raw line count. A torn line
  // before the resume point would otherwise shift the window by one
  // (missed or stale message in the follow-up summary). Note `total`
  // alone counts torn lines too — only `total - skipped` is exact.
  let entryCountBefore = 0;
  try {
    const base = readEntriesAfter(sessionPath, 0);
    entryCountBefore = base.total - (base.skipped ?? 0);
  } catch {
    entryCountBefore = 0;
  }

  const surface = createSurface(name);
  // C2: resume must not leak its tab if command-building/sending throws.
  const closeResumeSurface = () => {
    try {
      if (isKittyAvailable()) closeSurface(surface);
    } catch {}
  };
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
    // H6 re-check: a concurrent resume may have registered while this
    // call awaited the shell-ready delay. Never double-open one `.jsonl`
    // with two pi processes — steer into the winner instead.
    // S11: single-home compare via the store (try/catch lives there).
    {
      const raced = subagentStore.findRunningBySessionFile(sessionPath) as unknown as RunningEntry | null;
      if (raced) {
        closeResumeSurface();
        releaseResume();
        return handleSubagentSteer({ name: raced.name, message: params.message });
      }
      if (entry.surface) {
        const racedKept = findKeptTab(parentArtifactDir, requestedName);
        if (racedKept) {
          const racedSteer = await steerSubagentAsync(
            { surface: racedKept.surface, name: racedKept.name } as RunningEntry,
            params.message,
          );
          if (!("error" in racedSteer)) {
            closeResumeSurface();
            releaseResume();
            return {
              content: [{
                type: "text" as const,
                text:
                  `Message delivered to "${requestedName}" in its kept tab. It picks this up at its next ` +
                  `turn boundary.`,
              }],
              details: { name: requestedName, status: "steered-kept" },
            };
          }
          // Steer failed (tab died between checks) — fall through and
          // relaunch below; the liveness probes will refuse if alive.
        }
      }
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    // Resume in the subagent's original cwd so its tools (safe_bash, edits)
    // operate where they did before (pre-cwd-default snapshots with null
    // fall back to the current parent session dir).
    const resumeCwd = loadout.cwd ?? (ctx as unknown as { cwd?: string }).cwd ?? null;

    // T3: one assembly (same env order/sandbox/scrub/cd/sentinel as launch;
    // SURFACE now included and AUTO_EXIT in canonical position — reviewed
    // unification, benign: SURFACE is write-only per M10).
    const {
      command,
      scriptFile: launchScriptFile,
      resumeMsgFile,
    } = buildPiResumePlan({
      sessionPath,
      loadout,
      artifactDir,
      name,
      surface,
      id,
      activityFile,
      message: params.message,
      resumeCwd,
    });
    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      cwd: resumeCwd,
      scriptPreamble: scriptPreambleFor("resume", {
        name,
        sessionFile: sessionPath,
        surface,
        resumeMsgFile,
      }),
    });

    // Register as a running subagent for widget tracking
    // Resume is always autonomous ⇒ keepSurface=false (always closes).
    const running: RunningEntry = {
      id,
      name,
      task: message,
      surface,
      startTime,
      sessionFile: sessionPath,
      launchScriptFile,
      activityFile,
      parentArtifactDir: parentArtifactDir,
      keepSurface: false,
      autoExit,
      interactive,
      statusState: createStatusState({
        source: "pi",
        startTimeMs: startTime,
      }),
    };
    runningSubagents.set(id, running);
    // H6: the run is now tracked via the running map (the same guard
    // concurrent resumes check), so the pre-registration reservation ends.
    releaseResume();
    startWidgetRefresh();
    startStatusRefresh(pi);

    // Fire-and-forget watcher
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;

    watchSubagent(running, watcherAbort.signal, pi)
      .then((result) => {
        updateWidget();

        registerName(parentArtifactDir, name, {
          sessionFile: sessionPath,
          sessionId: resumedSessionId,
          ...(result.surfaceKept ? { surface: running.surface } : {}),
        });

        let summary: string;
        try {
          const allEntries = getNewEntries(sessionPath, entryCountBefore);
          summary = piSummaryFromEntries(
            allEntries,
            { errorMessage: result.errorMessage, exitCode: result.exitCode },
            "resume",
          );
        } catch {
          // C4: session-file read failure must not discard a good result.
          summary =
            result.summary ||
            piSummaryFromEntries(
              [],
              { errorMessage: result.errorMessage, exitCode: result.exitCode },
              "resume",
            );
        }
        if (shouldNotifyResult(result)) {
          try {
            notifyResult(pi as any, {
              name,
              task: message,
              summary,
              sessionFile: sessionPath,
              sessionId: resumedSessionId,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              errorMessage: result.errorMessage,
              surfaceKept: result.surfaceKept,
            });
          } catch {
            // Teardown races sendMessage — never reject unhandled.
          }
        }
      })
      .catch((err) => {
        updateWidget();
        try {
          notifyError(pi as any, name, message, err);
        } catch {
          // Teardown races sendMessage — never reject unhandled.
        }
      });

    return {
      content: [{ type: "text", text: `Session "${name}" resumed.` }],
      details: {
        id,
        name,
        sessionId: resumedSessionId,
        sessionFile: sessionPath,
        launchScriptFile,
        status: "started",
      },
    };
  } catch (err) {
    closeResumeSurface();
    releaseResume();
    throw err;
  }
}
