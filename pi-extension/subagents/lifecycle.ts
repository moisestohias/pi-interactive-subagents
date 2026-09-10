/**
 * lifecycle.ts — run/kept/watch orchestration (P1).
 *
 * Single owner of everything that mutates live-run state + starts/stops
 * watchers: `launchSubagent` / `watchSubagent`, kept-tab monitors,
 * reload recovery (`recoverSession`, `resurrectRunningTab`), per-session
 * teardown (`teardownSession`, M1-scoped), artifact GC
 * (`sweepStaleArtifacts`), the `.ask` queue, and per-session UI
 * (widget timers + `sessionCtxs`, H4). Moved verbatim from index.ts —
 * index.ts keeps only registration + `__test__` re-points.
 *
 * Testability: `teardownSession` / `recoverSession` take the store as a
 * param, so a fake `SubagentStore` proves M1 per-session scoping without
 * kitty (M5 acceptance). Watcher/monitor side effects in recovery are
 * injectable (`opts.watchRunning` / `opts.monitorKept`); production passes
 * nothing and gets the real attach.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { dirname, join, basename } from "node:path";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import {
  isKittyAvailable,
  kittySetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeSurface,
  closeSurfaceAsync,
  logCorruptDrop,
  readScreenAsync,
  windowExistsOrNull,
} from "./kitty.ts";
import { getArtifactDir } from "./paths.ts";
import { launchScriptName } from "./names.ts";
import { sessionTimestamp } from "./format.ts";
import { resolveKeepDecision } from "./keep.ts";
import { renderSubagentWidgetLines as renderWidgetLines } from "./widget.ts";
import {
  buildSubagentToolAllowlist,
  buildPiLaunchPlan,
  scriptPreambleFor,
  scriptPathFor,
  withDoneSentinel,
  writeTaskArtifact,
} from "./launch.ts";
import {
  getExtensionConfig,
  getSafeExtensionConfig,
  invalidateExtensionConfigCache,
} from "./config.ts";
import {
  buildClaudeCommand,
  cleanupClaudeSentinel,
  copyClaudeSession,
  createClaudeSentinelFile,
} from "./cli/claude.ts";
import { observeRunningSubagent } from "./status-bridge.ts";
import {
  SubagentStore,
  keptKey,
  clearKeptSurface,
  type RunningEntry,
  type RunningSubagent,
  type KeptTab,
} from "./store.ts";
import {
  notifyResult,
  notifyError,
  notifyKeptTabError,
  notifyQuestion,
  notifyStatus,
} from "./notifications.ts";
import { extractClaudeSummary, piSummaryFromEntries } from "./results.ts";
import {
  getSessionId,
  readEntriesAfter,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  seedSubagentSessionFile,
  summarizeEntriesStats,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  formatStatusAggregate,
  formatTransitionLine,
} from "./status.ts";
import { getSubagentActivityFile } from "./activity.ts";
import {
  getDefaultSessionDirFor,
  resolveSubagentPaths,
  resolveLaunchPolicy,
  loadAgentDefaults,
  canSpawnSubagents,
} from "./agents.ts";
import { claimFile } from "./session/sidecars.ts";
import {
  WIDGET_INTERVAL_KEY,
  STATUS_INTERVAL_KEY,
  getModuleAbortSignal,
  ensureLiveAbortController,
  rotateForFreshImport,
  publishRunningChildrenCount,
  setWidgetInterval,
  clearWidgetInterval,
  setStatusInterval,
  clearStatusInterval,
} from "./runtime.ts";

export type { RunningEntry, RunningSubagent, KeptTab };

/** Live identity singletons (one per module instance; fresh on /reload). */
export const subagentStore = new SubagentStore();
/** All currently running subagents, keyed by id (backed by SubagentStore). */
export const runningSubagents: Map<string, RunningEntry> = subagentStore.running;
/** Kept-open tabs outliving their first result, keyed by artifactDir::name. */
export const keptTabs: Map<string, KeptTab> = subagentStore.kept;
/** Names claimed by mid-launch spawns (parallel-spawn race guard). */
export const reservedNames: Set<string> = subagentStore.reserved;

// P2: import-time rotation + child-side count publisher live here (were
// inline in index.ts). Ordering preserved exactly; runtime.ts owns the keys.
rotateForFreshImport();
publishRunningChildrenCount(() => subagentStore.running.size);

/** Params accepted by `launchSubagent` (structural — handlers own the schema). */
export interface LaunchParams {
  agent: string;
  task: string;
  name?: string;
  model?: string;
  cwd?: string;
}

export interface LaunchCtx {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 * (Moved as-is from index.ts — S13-generalization is explicitly out of
 * scope, so this stays a single-purpose helper, not a generic env parser.)
 */
export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

// Legacy wire removed: `PI_SUBAGENT_KEEP_TAB` is no longer set, read, or
// propagated anywhere. `tabs.keepOpen` in config.json is the sole source of
// truth (reloaded on pi's /reload). Any value lingering in the shell env
// (dotfiles, old exports) is scrubbed at launch and ignored in the child.
if ("PI_SUBAGENT_KEEP_TAB" in process.env) {
  delete process.env.PI_SUBAGENT_KEEP_TAB;
}

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  /** True when the tab was left open (config `tabs.keepOpen` + `auto-exit: false`) instead of closed. */
  surfaceKept?: boolean;
}

/**
 * Pure gate for completion fan-out (M3): cancelled runs (the watcher was
 * aborted on session shutdown/reload) must not steer a "Subagent
 * cancelled." notification into a dead session, and a throwing
 * `sendMessage` during teardown must never escape as an unhandled
 * rejection. Exported via `__test__` for unit tests.
 */
export function shouldNotifyResult(result: Pick<SubagentResult, "error">): boolean {
  return result.error !== "cancelled";
}

/**
 * Close a finished subagent's tab unless this specific run was kept open.
 * T1b/S5: `keepSurface` is required — every caller passes the run's own
 * decision explicitly (zero legacy omitted-arg callers). No silent fallback
 * to global config that would mask keep/exit bugs. Shared keep decision
 * for the close pair (M11 single-home).
 */
function shouldCloseSurface(keepSurface: boolean): boolean {
  return !keepSurface;
}

export function maybeCloseSurface(surface: string, keepSurface: boolean): void {
  if (!shouldCloseSurface(keepSurface)) return;
  closeSurface(surface);
}

/** Async `maybeCloseSurface` (M11): adopted on completion paths. */
export async function maybeCloseSurfaceAsync(surface: string, keepSurface: boolean): Promise<void> {
  if (!shouldCloseSurface(keepSurface)) return;
  await closeSurfaceAsync(surface);
}

export function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require kitty tabs. ${kittySetupHint()}`,
      },
    ],
    details: { error: "kitty not available" },
  };
}

/**
 * @deprecated Use muxUnavailableResult. Kept for compat.
 * (Lows: the trivial alias body is collapsed — the name remains.)
 */
export function kittyUnavailableResult() {
  return muxUnavailableResult();
}

// S1: `session_start` keeps the invalid-config startup warning via
// `warnOnInvalidConfig()` + `invalidateExtensionConfigCache()` (no dead
// triple cache — every call site already reads `getExtensionConfig()` fresh).
export function warnOnInvalidConfig(): void {
  try {
    getExtensionConfig(true);
  } catch (err) {
    try {
      console.error(`[subagents] invalid config, using defaults until fixed: ${(err as Error)?.message ?? err}`);
    } catch {}
    invalidateExtensionConfigCache();
  }
}

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;
/**
 * ExtensionContexts per spawner session, keyed by artifact dir (H4). The
 * module-global `latestCtx` is last-writer-wins across sessions sharing one
 * process; the widget must render into every live session's UI, not just
 * the most recent one. Entries are added on `session_start` and removed on
 * `session_shutdown`.
 */
export const sessionCtxs = new Map<string, ExtensionContext>();

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

// T1b: RunningSubagent→WidgetRow adapter (real logic: map + `status.enabled`
// inject). Renamed to avoid shadowing `widget.ts:renderSubagentWidgetLines`
// (acceptance: no local `function` shadows a home-module export). `__test__`
// keeps the old key, re-pointed at this adapter (no test changes).
export function renderRunningWidgetLines(agents: RunningEntry[], width: number): string[] {
  const now = Date.now();
  const rows = agents.map((agent) => ({
    name: agent.name,
    agent: agent.agent,
    startTime: agent.startTime ?? now,
    cli: agent.cli,
    snapshot: classifyStatus(agent.statusState!, now),
  }));
  return renderWidgetLines(rows, width, { statusEnabled: getSafeExtensionConfig().status.enabled });
}

export function updateWidget() {
  // H4: render into every live session's UI (not just latestCtx).
  const ctxs =
    sessionCtxs.size > 0 ? [...sessionCtxs.values()] : latestCtx ? [latestCtx] : [];
  const live = ctxs.filter((c) => (c as ExtensionContext | null)?.hasUI);
  if (live.length === 0) return;

  if (runningSubagents.size === 0) {
    for (const c of live) {
      try {
        c.ui.setWidget("subagent-status", undefined);
      } catch {}
    }
    if (widgetInterval) {
      clearWidgetInterval(widgetInterval);
      widgetInterval = null;
    }
    return;
  }

  for (const c of live) {
    try {
      c.ui.setWidget(
        "subagent-status",
        (_tui: any, _theme: any) => {
          return {
            invalidate() {},
            render(width: number) {
              return renderRunningWidgetLines(Array.from(runningSubagents.values()), width);
            },
          };
        },
        { placement: "aboveEditor" },
      );
    } catch {}
  }
}

/** Test seam (H4): whether the shared widget/status timers are armed. */
export function timersActiveForTest(): { widget: boolean; status: boolean } {
  return { widget: widgetInterval !== null, status: statusInterval !== null };
}

export function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  setWidgetInterval(widgetInterval);
}

export function startStatusRefresh(pi: ExtensionAPI) {
  // M4: timer paths degrade to last-good config (never throw per tick).
  if (!getSafeExtensionConfig().status.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearStatusInterval(statusInterval);
        statusInterval = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState!, now);
      if (nextState.currentKind !== running.statusState!.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const lineLimit = getSafeExtensionConfig().status.lineLimit;
      const capped = capStatusLines(transitionLines, lineLimit);
      notifyStatus(pi as any, {
        content: formatStatusAggregate(transitionLines, lineLimit),
        visibleLines: capped.visibleLines,
        overflow: capped.overflow,
      });
    }
  }, 1000);

  setStatusInterval(statusInterval);
}

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session (running + reserved + registry). Single home: the store
 * (this wrapper only preserves the index-side name for `__test__` compat).
 */
export function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  return subagentStore.uniqueName(base, registryNames);
}

export function resolveRunningByName(name: string):
  | { running: RunningEntry }
  | { error: string } {
  return subagentStore.resolveRunningByName(name);
}

// T1b/S5: `keptTabAlive` wrapper deleted — the N3 default
// (`windowExistsOrNull(s) !== false`, unknown ⇒ alive) lives in
// `store.ts:findKept`. This adapter only preserves the index-side cast.
export function findKeptTab(
  artifactDir: string,
  name: string,
  exists?: (surface: string) => boolean,
): KeptTab | null {
  // Canonical prune+clear lives in store.ts (single implementation).
  return exists === undefined
    ? subagentStore.findKept(artifactDir, name)
    : subagentStore.findKept(artifactDir, name, exists);
}

/**
 * Watch a kept tab until it closes: relay later `ask_question` signals live
 * (the spawn watcher already exited on the first `.done`) and report a later
 * agent-loop error via `.exit`. The first result was already delivered — a
 * clean close afterwards is silent. Aborted on session shutdown / tab death.
 */
export async function monitorKeptTab(kept: KeptTab, piInstance: ExtensionAPI): Promise<void> {
  try {
    const result = await pollForExit(
      kept.surface,
      AbortSignal.any([kept.abort.signal, getModuleAbortSignal()]),
      {
        interval: 2000,
        sessionFile: kept.sessionFile,
        // M9: the first result was already delivered — a second `.done`
        // (e.g. child-side `/reload` reset `completionSignaled`) must not
        // end supervision of the still-live tab. `.exit` still reports.
        ignoreDone: true,
        onTick() {
          deliverPendingQuestion(
            { name: kept.name, agent: kept.agent, sessionFile: kept.sessionFile, startTime: kept.startTime },
            piInstance,
          );
        },
      },
    );
    if (result.reason === "error" && !result.tabClosed) {
      // H1 interplay: a kept tab closed after its first result is a normal
      // silent close (the result was already delivered) — only genuine
      // agent-loop errors (`.exit`) notify.
      try {
        notifyKeptTabError(piInstance as any, kept.name, result.errorMessage ?? "unknown");
      } catch {
        // Best effort — the error is also visible in the kept tab itself.
      }
    }
    // Clean close afterwards is silent: the first result was already delivered.
  } catch {
    // Aborts (shutdown/reload) and poll failures end the monitor quietly.
  } finally {
    subagentStore.untrackKept(kept.parentArtifactDir, kept.name);
    clearKeptSurface(kept.parentArtifactDir, kept.name, kept);
  }
}

/** Register a kept tab and start its monitor (no-op if already tracked). */
export function trackKeptTab(
  store: SubagentStore,
  parentArtifactDir: string,
  params: { name: string; agent?: string; surface: string; sessionFile: string; sessionId: string | null; startTime?: number },
  piInstance: ExtensionAPI,
): void {
  const kept = store.trackKept(parentArtifactDir, params);
  void monitorKeptTab(kept as unknown as KeptTab, piInstance);
}

/**
 * Pure tri-state decision for reload recovery (H5), unit-testable without
 * kitty. `tracked`: a watcher/monitor already owns the session (never
 * double-watch). `kept`: a kept monitor owns it. `alive`: tab liveness —
 * `false` (positively gone) prunes the dead surface so resume-by-name
 * works; `null` (control-plane unknown, N3) watches rather than orphaning
 * a possibly-live tab. Exported via `__test__`.
 */
export function decideResurrectAction(state: {
  tracked: boolean;
  kept: boolean;
  alive: boolean | null;
}): "watch" | "prune" | "skip" {
  if (state.tracked || state.kept) return "skip";
  if (state.alive === false) return "prune";
  return "watch";
}
/**
 * Reserved sidecar/claim filename suffixes (compat-3 protocol registry).
 * These suffixes next to session files / inside artifact dirs are the
 * parent↔child protocol — never use them for anything else, and never
 * invent a new one without adding it here:
 * - `.exit` — child error signal (JSON `{type:"error",…}`), rename-claimed.
 * - `.done` — keep-tab clean-finish signal (presence = signal), rename-claimed.
 * - `.ask` — child question payload (JSON), rename-claimed.
 * - `.loadout.json` — spawn loadout snapshot for resume replay.
 * - `.transcript` — Claude transcript path pointer (Claude backend only).
 * - `.consuming-*` — transient rename-claim (pid+random); stale ones are
 *   swept by `sweepStaleArtifacts`.
 * - `.pending-*` — parked question payloads (M2 no-clobber queue).
 * - `.tmp-*` — transient writer temp files (registry + atomic sidecars).
 * - `.corrupt-retry` — compat-1 torn-`.ask` retry marker.
 * - `.corrupt-<ts>` — M6 corrupt-registry backups (never swept: evidence).
 */
export const STALE_CLAIM_MAX_AGE_MS = 5 * 60 * 1000;
export const STAGED_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SWEPT_STAGING_DIRS = ["context", "subagent-scripts", "subagent-resume", "subagent-activity"];

/**
 * Best-effort artifact GC on `session_start` (L7 + compat-3).
 * Launch/resume mint per-run files (sysprompt copies, launch/resume
 * scripts, activity files) that were never cleaned — unbounded growth per
 * run — and crashed processes leave `.consuming-*`/`.tmp-*` claim files
 * behind. Sweeps, under the spawner's artifact dir only:
 * - stale claim/tmp files older than 5 min (a live claim lives only
 *   milliseconds; the grace keeps the sweep from racing a concurrent tick
 *   during reload). M6 `.corrupt-*` backups are evidence — never swept.
 * - staged files older than 7 days in the known staging subdirs.
 * Never touches: the registry, session transcripts (they live outside the
 * artifact dir), or live sidecars (`.ask`/`.done`/`.exit`/loadouts —
 * owned by recovery, which runs separately).
 */
export function sweepStaleArtifacts(artifactDir: string): void {
  let removed = 0;
  const now = Date.now();
  const stagingRoots = new Set(SWEPT_STAGING_DIRS.map((d) => join(artifactDir, d)));
  const walk = (dir: string, underStaging: boolean) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, underStaging || stagingRoots.has(full));
        continue;
      }
      if (!entry.isFile()) continue;
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const age = now - mtime;
      const isClaimTmp =
        entry.name.includes(".consuming-") ||
        entry.name.includes(".tmp-");
      if (isClaimTmp && !entry.name.includes(".corrupt-") && age > STALE_CLAIM_MAX_AGE_MS) {
        try {
          unlinkSync(full);
          removed++;
        } catch {}
      } else if (underStaging && age > STAGED_FILE_MAX_AGE_MS) {
        try {
          unlinkSync(full);
          removed++;
        } catch {}
      }
    }
  };
  try {
    walk(artifactDir, false);
  } catch {}
  if (removed > 0) {
    try {
      console.error(`[pi-subagents] swept ${removed} stale artifact file(s) under ${artifactDir}`);
    } catch {}
  }
}

/**
 * Re-watch a still-live run orphaned by `/reload` (H5). The previous module
 * instance's watcher died with the import-time abort-controller rotation
 * while the kitty tab kept running; without a new watcher its result would
 * never be delivered, its widget row would stay gone, and the tab would leak
 * unsupervised. The resurrected run reuses the persisted `surface` +
 * `sessionFile` (with stale-sidecar hygiene inherited from `pollForExit`: a
 * pre-reload `.done`/`.exit` completes it immediately — which is correct,
 * that signal was the result the dead watcher never delivered).
 * `watch` injects the watcher attach (tests pass a recorder; production
 * gets the real fan-out).
 */
export function resurrectRunningTab(
  store: SubagentStore,
  artifactDir: string,
  regName: string,
  entry: { sessionFile: string; sessionId?: string | null; surface: string },
  piInstance: ExtensionAPI,
  watch?: (running: RunningEntry, abort: AbortController) => void,
  exists?: (surface: string) => boolean | null,
): boolean {
  const sessionPath = entry.sessionFile;
  if (!sessionPath || !existsSync(sessionPath)) return false;
  // Liveness: positively-gone tabs get their dead surface pruned (so
  // resume-by-name works); unknown control-plane keeps the watch (N3).
  // Already-tracked sessions are never double-watched.
  // `exists` injects the probe (tests pass fakes; production probes kitty).
  let alive: boolean | null;
  try {
    alive = (exists ?? windowExistsOrNull)(entry.surface);
  } catch {
    alive = null;
  }
  const action = decideResurrectAction({
    tracked: !!store.findRunningBySessionFile(sessionPath),
    kept: store.kept.has(keptKey(artifactDir, regName)),
    alive,
  });
  if (action === "skip") return false;
  if (action === "prune") {
    try {
      registerName(artifactDir, regName, {
        sessionFile: sessionPath,
        sessionId: entry.sessionId ?? null,
      });
    } catch {}
    return false;
  }
  let agent: string | undefined;
  try {
    agent = readSubagentLoadout(sessionPath)?.agent ?? undefined;
  } catch {
    agent = undefined;
  }
  const id = Math.random().toString(16).slice(2, 10);
  const now = Date.now();
  const activityFile = getSubagentActivityFile(artifactDir, id);
  try {
    mkdirSync(dirname(activityFile), { recursive: true });
  } catch {}
  const running: RunningEntry = {
    id,
    name: regName,
    task: `(resumed after reload: ${regName})`,
    agent,
    surface: entry.surface,
    startTime: now,
    sessionFile: sessionPath,
    activityFile,
    parentArtifactDir: artifactDir,
    keepSurface: false,
    autoExit: true,
    interactive: false,
    statusState: createStatusState({ source: "pi", startTimeMs: now }),
  };
  store.running.set(id, running);
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  startWidgetRefresh();
  startStatusRefresh(piInstance);
  const attach = watch ?? ((r: RunningEntry, abort: AbortController) => {
    watchSubagent(r, abort.signal, piInstance)
      .then((result) => {
        updateWidget();
        registerName(artifactDir, regName, {
          sessionFile: sessionPath,
          sessionId: result.sessionId ?? entry.sessionId ?? null,
          ...(result.surfaceKept ? { surface: r.surface } : {}),
        });
        if (result.surfaceKept) {
          trackKeptTab(
            store,
            artifactDir,
            {
              name: regName,
              agent: r.agent,
              surface: r.surface,
              sessionFile: sessionPath,
              sessionId: result.sessionId ?? null,
              startTime: r.startTime,
            },
            piInstance,
          );
        }
        // M3: a watcher aborted by a later shutdown/reload must not steer
        // into a dead session; teardown races never reject unhandled.
        if (shouldNotifyResult(result)) {
          try {
            notifyResult(piInstance as any, {
              name: regName,
              task: r.task ?? "",
              agent: r.agent,
              summary: result.summary,
              sessionFile: sessionPath,
              sessionId: result.sessionId,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              errorMessage: result.errorMessage,
              surfaceKept: result.surfaceKept,
            });
          } catch {}
        }
      })
      .catch((err) => {
        updateWidget();
        try {
          notifyError(piInstance as any, regName, r.task ?? "", err);
        } catch {}
      });
  });
  attach(running, watcherAbort);
  return true;
}

/**
 * Launch a subagent: creates the kitty tab, builds the command, and
 * sends it. Returns a RunningEntry — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
export async function launchSubagent(
  params: LaunchParams,
  ctx: LaunchCtx,
  options?: { surface?: string },
): Promise<RunningEntry> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  // S8: one policy call (was `resolveEffectiveInteractive` + `resolveLaunchBehavior`).
  const launchPolicy = resolveLaunchPolicy(agentDefs);
  const effectiveInteractive = launchPolicy.interactive;
  const launchBehavior = launchPolicy;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  // Default to the parent session's working dir so the child shell starts
  // where the parent runs (explicit `cwd` param / agent `cwd:` still wins).
  const targetCwdForSession = effectiveCwd ?? ctx.cwd ?? process.cwd();
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  // S3: distinct session-filename shape (23 chars + `Z`), not an artifact tag.
  const timestamp = sessionTimestamp();
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  let surface: string;
  try {
    surface = options?.surface ?? createSurface(params.name);
  } catch (err) {
    throw err;
  }
  // C2: any throw after this point must not leak the tab. Only close surfaces
  // we created here (pre-created parallel surfaces belong to the caller).
  const closeLeakedSurface = () => {
    if (surfacePreCreated) return;
    try {
      if (isKittyAvailable()) closeSurface(surface);
    } catch {}
  };
  try {
    if (!surfacePreCreated) {
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
    }

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  // The subagent_agents gate grants the spawning toolset: `true` means any
  // discoverable agent (PI_SUBAGENT_ALLOWED left unset = unrestricted), a list
  // pins the child to exactly those agents (enforced via PI_SUBAGENT_ALLOWED).
  // Missing or `false` grants nothing.
  const grantSpawning = canSpawnSubagents(agentDefs);
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  // Per-run exit/keep decision (config.json × agent frontmatter, canonical in keep.ts).
  const agentAutoExit = agentDefs?.autoExit ?? false;
  const { keepSurface, effectiveAutoExit } = resolveKeepDecision({
    keepOpen: getExtensionConfig().tabs.keepOpen === true,
    autoExit: agentAutoExit,
  });
  // ── Claude Code CLI path (command via cli/claude.ts canonical builder) ──
  if (agentDefs?.cli === "claude") {
    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    const { command: claudeBase, sentinelFile } = buildClaudeCommand({
      id,
      task: params.task,
      model: effectiveModel ?? null,
      systemPrompt: agentDefs.body ?? null,
      cwd: targetCwdForSession ?? null,
    });
    // L8: pre-create the sentinel mode 0600 (predictable /tmp name).
    createClaudeSentinelFile(sentinelFile);
    const command = withDoneSentinel(claudeBase);

    const launchScriptBase = launchScriptName(params.name, id);
    const launchScriptFile = scriptPathFor(artifactDir, launchScriptBase);

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      cwd: targetCwdForSession ?? null,
      // T2: both backends via scriptPreambleFor (single home, sink-covered).
      scriptPreamble: scriptPreambleFor("claude-launch", {
        name: params.name,
        surface,
      }),
    });

    const running: RunningEntry = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      parentArtifactDir: artifactDir,
      cli: "claude",
      sentinelFile,
      keepSurface,
      autoExit: effectiveAutoExit,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    return running;
  }

  // ── Pi CLI path (single plan pipeline — T2) ──

  // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
  // else the propagated global dir. Captured once so the launch env and the
  // resume snapshot agree.
  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;

  // Default-deny model: every child launches with --no-extensions and an
  // explicit --tools list (the `tools` header when present, else the
  // read/write/edit/bash baseline). Only the extensions backing the listed
  // tools are loaded back in, so a child never inherits the parent's full
  // toolset or global extensions by accident.
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, { grantSpawning });

  // Snapshot the fully-resolved sandbox beside the session file so a later
  // `subagent_message({ name })` resume can replay the exact same
  // restriction instead of relaunching pi with all global extensions + tools.
  const loadout: SubagentLoadout = {
    agent: params.agent ?? null,
    toolAllowlist,
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    // Lists round-trip for resume; `true` (unrestricted) and missing/`false`
    // (no spawning) both persist as null — the tool allowlist above already
    // records whether spawning was granted, so resume stays exact.
    spawnable: Array.isArray(agentDefs?.subagentAgents) ? agentDefs.subagentAgents : null,
    autoExit: agentDefs?.autoExit ?? false,
    cwd: targetCwdForSession ?? null,
    agentDir: resolvedAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  // S3/S4: artifact write via the single helper (names.ts filename, format.ts tag).
  const taskArg =
    launchBehavior.taskDelivery === "direct"
      ? fullTask
      : writeTaskArtifact(artifactDir, params.name, fullTask);

  // T2: one assembly (env order AGENT-before-NAME per the M4 table; same
  // sandbox replay, quoting, scrub, cd, sentinel the resume plan uses).
  const { command, scriptFile: launchScriptFile } = buildPiLaunchPlan({
    sessionFile: subagentSessionFile,
    loadout,
    artifactDir,
    name: params.name,
    surface,
    taskArg,
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    childId: id,
    activityFile,
    autoExit: effectiveAutoExit,
    targetCwd: targetCwdForSession,
  });
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    cwd: targetCwdForSession ?? null,
    scriptPreamble: scriptPreambleFor("launch", {
      name: params.name,
      sessionFile: subagentSessionFile,
      surface,
    }),
  });

  const running: RunningEntry = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    parentArtifactDir: artifactDir,
    keepSurface,
    autoExit: effectiveAutoExit,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

    runningSubagents.set(id, running);
    return running;
  } catch (err) {
    closeLeakedSurface();
    throw err;
  }
}

export async function watchSubagent(
  running: RunningEntry,
  signal: AbortSignal,
  piInstance?: ExtensionAPI | null,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      onTick() {
        observeRunningSubagent(running);
        deliverPendingQuestion(running, piInstance);
      },
    });

    const elapsed = Math.floor((Date.now() - (startTime ?? Date.now())) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction (wording in results.ts).
      let sentinelText: string | null = null;
      if (running.sentinelFile) {
        try {
          const raw = readFileSync(running.sentinelFile, "utf-8").trim();
          sentinelText = raw ? raw : null;
        } catch {}
      }
      // N7: async scrape (sync execFileSync would block the extension host).
      const summary = await extractClaudeSummary({
        sentinelText,
        surface,
        exitCode: result.exitCode,
        readScreen: readScreenAsync,
      });

      // Copy Claude session transcript, then clean the predictable /tmp
      // sentinel pair via the existing helper (D6: no new cleanup fn) — in
      // `finally` so a close failure can't leak them (N8).
      let sessionId: string | null = null;
      try {
        if (running.sentinelFile) {
          sessionId = copyClaudeSession(running.sentinelFile);
        }
        await maybeCloseSurfaceAsync(surface, running.keepSurface === true);
        runningSubagents.delete(running.id);
        return { name, task: task ?? "", summary, exitCode: result.exitCode, elapsed, surfaceKept: running.keepSurface === true, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
      } finally {
        if (running.sentinelFile) cleanupClaudeSentinel(running.sentinelFile);
      }
    }

    // Pi subagent result extraction — Missing #2: a single read via
    // `readEntriesAfter` feeds both the summary and the stats (previously a
    // full parse here plus a second full read+parse in
    // `summarizeSessionStats`, i.e. two sync multi-MB JSON parses per
    // completion on the extension host). Wording in results.ts (T4).
    let summary: string;
    let stats: SessionStats | null = null;
    if (existsSync(sessionFile)) {
      const read = readEntriesAfter(sessionFile, 0);
      stats = summarizeEntriesStats(read.entries);
      summary = piSummaryFromEntries(read.entries, { errorMessage: result.errorMessage, exitCode: result.exitCode }, "launch");
    } else {
      summary = piSummaryFromEntries([], { errorMessage: result.errorMessage, exitCode: result.exitCode }, "launch");
    }

    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    await maybeCloseSurfaceAsync(surface, running.keepSurface === true);
    runningSubagents.delete(running.id);

    return {
      name,
      task: task ?? "",
      summary,
      sessionFile,
      surfaceKept: running.keepSurface === true,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    try {
      // Aborts mean this session is going away (shutdown/reload) — always
      // clean up. Genuine errors honor this run's keep decision for inspection.
      if (signal.aborted) closeSurface(surface);
      else maybeCloseSurface(surface, running.keepSurface === true);
    } catch {}
    // N8: never leak claude sentinel/.transcript (predictable /tmp names) —
    // success path cleans via cleanupClaudeSentinel in `finally`; aborts and
    // pre-watch errors clean here through the same helper (D6).
    if (running.sentinelFile) cleanupClaudeSentinel(running.sentinelFile);
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task: task ?? "",
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - (startTime ?? Date.now())) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task: task ?? "",
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - (startTime ?? Date.now())) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Shared launch-side orchestration (P1): run `start`, register the watcher
 * inputs, arm supervision, and attach the fire-and-forget watch. Both the
 * spawn execute (`handlers/spawn.ts`) and the resume execute
 * (`handlers/message.ts`) share this shape; their completion fan-out
 * differs (summary source, registry sessionId, notify payload) and stays in
 * the handlers as `hooks`. Order preserved exactly: start → afterStart →
 * abort-assign → widget/status refresh → watch-attach; completions run
 * `updateWidget()` first, then the hook (same as the inline code did).
 */
export interface WatchHooks {
  onResult: (running: RunningEntry, result: SubagentResult) => void;
  onError: (running: RunningEntry, err: unknown) => void;
}

export async function launchAndWatch(opts: {
  start: () => Promise<RunningEntry>;
  afterStart?: (running: RunningEntry) => void;
  hooks: WatchHooks;
  pi: ExtensionAPI;
}): Promise<RunningEntry> {
  const running = await opts.start();
  // Create a separate AbortController for the watcher
  // (the tool's signal completes when we return)
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  opts.afterStart?.(running);

  // Start widget refresh and status supervision when the first agent launches
  startWidgetRefresh();
  startStatusRefresh(opts.pi);

  // Fire-and-forget: start watching in background (thread spawner's pi
  // so ask_question delivery goes to the right session, not latestPi).
  watchSubagent(running, watcherAbort.signal, opts.pi)
    .then((result) => {
      updateWidget(); // reflect removal from Map immediately
      opts.hooks.onResult(running, result);
    })
    .catch((err) => {
      updateWidget();
      opts.hooks.onError(running, err);
    });
  return running;
}

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
export type QuestionCarrier = Pick<RunningEntry, "name" | "agent" | "sessionFile" | "startTime">;

/**
 * Re-deliver any orphaned `.ask` files left by watchers that died with their
 * parent process (pi exit / `/reload` aborts every watcher). Without this, a
 * question asked while the parent was reloading is lost forever: the live
 * tick that would have picked it up is gone, and no new watcher starts for
 * the old run. Runs on every `session_start` for this spawner session's own
 * registry; delivery consumes the file so a racing live watcher can't double-fire.
 */
export function recoverPendingQuestions(piInstance: ExtensionAPI, artifactDir: string): void {
  let registry;
  try {
    registry = readNameRegistry(artifactDir);
  } catch {
    return;
  }
  for (const [name, entry] of Object.entries(registry)) {
    const sessionFile = (entry as { sessionFile?: unknown }).sessionFile;
    if (typeof sessionFile !== "string" || !sessionFile) continue;
    let askExists = false;
    try {
      askExists = existsSync(`${sessionFile}.ask`);
    } catch {
      continue;
    }
    if (!askExists) continue;
    let agent: string | undefined;
    try {
      agent = readSubagentLoadout(sessionFile)?.agent ?? undefined;
    } catch {
      agent = undefined;
    }
    // L3: recovered questions report real elapsed from the `.ask` file
    // mtime (the question's actual age), not `Date.now()` ("asks (0s)").
    let startTime = Date.now();
    try {
      startTime = Math.min(startTime, statSync(`${sessionFile}.ask`).mtimeMs);
    } catch {}
    deliverPendingQuestion({ name, agent, sessionFile, startTime }, piInstance);
  }
}

/**
 * Promote the oldest queued `.pending-*` question to `.ask` when no live
 * `.ask` exists (M2). The no-clobber restore below parks an undelivered
 * payload here instead of overwriting a newer question; the next tick
 * drains it. Best-effort, never throws.
 */
export function promotePendingAskFile(sessionFile: string): void {
  const askFile = `${sessionFile}.ask`;
  try {
    if (existsSync(askFile)) return;
    const dir = dirname(askFile);
    const base = basename(askFile);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const pending = entries.filter((f) => f.startsWith(`${base}.pending-`)).sort();
    if (pending.length === 0) return;
    try {
      renameSync(join(dir, pending[0]), askFile);
    } catch {}
  } catch {}
}

/**
 * Restore a claimed `.ask` payload without clobbering a newer question
 * (M2). Returns `"restored"` when the claim is back at `.ask` (retry next
 * tick) or `"kept-newer"` when a fresh `.ask` arrived while the claim was
 * held — the held payload is parked as `.pending-*` for the next tick
 * instead of overwriting the newer question (previously Q2 was lost
 * silently). Never throws.
 */
export function restoreAskClaimNoClobber(claim: string, askFile: string): "restored" | "kept-newer" {
  try {
    if (existsSync(askFile)) {
      const pending = `${askFile}.pending-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
      try {
        renameSync(claim, pending);
      } catch {
        try {
          unlinkSync(claim);
        } catch {}
      }
      return "kept-newer";
    }
    renameSync(claim, askFile);
    return "restored";
  } catch {
    try {
      unlinkSync(claim);
    } catch {}
    return "kept-newer";
  }
}

export function deliverPendingQuestion(running: QuestionCarrier, piInstance?: ExtensionAPI | null): boolean {
  // Drain any previously parked question first (M2 queue).
  promotePendingAskFile(running.sessionFile);
  const askFile = `${running.sessionFile}.ask`;
  const retryMarker = `${askFile}.corrupt-retry`;
  // Atomic claim (C3/M4): rename before read so concurrent ticks
  // (1s poll, 2s kept-tab poll, session_start recovery) can't double-fire.
  // ENOENT means another consumer won the race. Single home: sidecars.ts.
  const claim = claimFile(askFile);
  if (!claim) return false;
  let payload: any = null;
  try {
    payload = JSON.parse(readFileSync(claim, "utf-8"));
  } catch {
    // Compat-1: pre-C3 children write `.ask` non-atomically, so a partial
    // flush from an old child parses as corrupt once. Retain-then-retry
    // once (no-clobber) instead of deleting a real signal; drop only on the
    // second consecutive failure. The pending queue cannot entomb it: a
    // parked payload is promoted and re-attempted next tick, where the
    // marker forces the drop.
    try {
      if (existsSync(retryMarker)) {
        unlinkSync(claim);
        unlinkSync(retryMarker);
        // Missing #4: the final drop is logged + counted — a torn `.ask`
        // that never parses is a lost child question, never silent.
        logCorruptDrop("ask-claim", askFile, "torn-json-second-failure");
      } else {
        writeFileSync(retryMarker, String(Date.now()), "utf8");
        restoreAskClaimNoClobber(claim, askFile);
      }
    } catch {
      try {
        unlinkSync(claim);
      } catch {}
    }
    return false;
  }
  if (!payload?.question) {
    try {
      unlinkSync(claim);
    } catch {}
    // Missing #4: well-formed JSON without a question is not a real
    // signal — but dropping it silently would hide a child-side contract
    // break, so it is logged + counted too.
    logCorruptDrop("ask-claim", askFile, "missing-question-field");
    return false;
  }

  // Use the spawner's own pi instance (threaded from the spawn call site).
  // The module-global latestPi can point at a different session (multi-session
  // process, /reload) — results already use the closure pi, questions must too.
  // Envelope lives in notifications.ts (single sendMessage owner).
  const target = piInstance ?? latestPi;
  if (!target) {
    // No session to notify — restore the claim for retry (never clobber).
    restoreAskClaimNoClobber(claim, askFile);
    return false;
  }

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - (running.startTime ?? Date.now())) / 1000);

  try {
    notifyQuestion(target as any, {
      name,
      agent: running.agent,
      sessionId,
      elapsedSec: elapsed,
      question: payload.question,
    });
    // A clean delivery retires any retry marker from an earlier torn read.
    try {
      unlinkSync(retryMarker);
    } catch {}
  } catch {
    // Keep for retry: park the claim (never overwrite a newer `.ask`).
    restoreAskClaimNoClobber(claim, askFile);
    return false;
  }
  try {
    unlinkSync(claim);
  } catch {}
  return true;
}

export interface RecoverOpts {
  /** Liveness probe (defaults to `windowExistsOrNull`; tests inject fakes). */
  exists?: (surface: string) => boolean | null;
  /** Kept-tab monitor attach (defaults to `monitorKeptTab`; tests record). */
  monitorKept?: (kept: KeptTab, pi: ExtensionAPI) => void;
  /** Running-tab watcher attach (defaults to the real fan-out; tests record). */
  watchRunning?: (running: RunningEntry, abort: AbortController) => void;
}

/**
 * Reload recovery (H5): re-deliver orphaned `.ask` files, re-attach kept-tab
 * monitors, and re-watch live runs orphaned by `/reload`. Split from the
 * `session_start` handler so a fake store proves the scoping without kitty
 * (M5 acceptance: ask-recovery + kept reattach covered by unit tests).
 */
export function recoverSession(
  store: SubagentStore,
  artifactDir: string,
  pi: ExtensionAPI,
  opts?: RecoverOpts,
): void {
  // Catch up on questions orphaned by a dead watcher (pi exit / `/reload`
  // while a subagent was parked on ask_question). The live tick is gone;
  // without this the `.ask` file sits unconsumed forever.
  // Also re-attach monitors + steer routing for kept tabs still alive.
  try {
    recoverPendingQuestions(pi, artifactDir);
    try {
      const registry = readNameRegistry(artifactDir);
      for (const [regName, regEntry] of Object.entries(registry)) {
        const sf = (regEntry as { sessionFile?: unknown }).sessionFile;
        const surf = (regEntry as { surface?: unknown }).surface;
        if (typeof sf !== "string" || !sf || typeof surf !== "string" || !surf) continue;
        // H5: entries flagged `running` are live runs for the resurrect
        // pass below, not kept tabs — never attach a kept monitor here
        // (it would swallow their completion result).
        if ((regEntry as { running?: unknown }).running === true) continue;
        if (store.kept.has(keptKey(artifactDir, regName))) continue;
        let alive = false;
        try {
          // S5: N3 probe inline (keptTabAlive wrapper deleted; default lives in store.ts).
          alive = existsSync(sf) && (opts?.exists ?? windowExistsOrNull)(surf) !== false;
        } catch {
          alive = true; // unknown — keep the monitor, don't orphan the tab
        }
        if (!alive) continue;
        let agent: string | undefined;
        try {
          agent = readSubagentLoadout(sf)?.agent ?? undefined;
        } catch {
          agent = undefined;
        }
        const kept = store.trackKept(
          artifactDir,
          { name: regName, agent, surface: surf, sessionFile: sf, sessionId: (regEntry as { sessionId?: string }).sessionId ?? null },
        );
        (opts?.monitorKept ?? ((k: KeptTab, p: ExtensionAPI) => void monitorKeptTab(k, p)))(kept, pi);
      }
    } catch {
      // Best effort — rebuild must never break session startup.
    }
    // H5: re-watch live runs orphaned by `/reload`. The launch path
    // marks running entries (`surface` + `running: true`); the completion
    // handler clears the flag, so anything still flagged is a run whose
    // watcher died with the previous module instance. Without this its
    // result is lost, its widget row is gone, and the tab leaks
    // unsupervised ("subagent vanished after reload").
    try {
      const registry = readNameRegistry(artifactDir);
      for (const [regName, regEntry] of Object.entries(registry)) {
        const rec = regEntry as {
          sessionFile?: unknown;
          sessionId?: unknown;
          surface?: unknown;
          running?: unknown;
        };
        if (rec.running !== true) continue;
        if (typeof rec.sessionFile !== "string" || !rec.sessionFile) continue;
        if (typeof rec.surface !== "string" || !rec.surface) continue;
        try {
          resurrectRunningTab(
            store,
            artifactDir,
            regName,
            {
              sessionFile: rec.sessionFile,
              sessionId: typeof rec.sessionId === "string" ? rec.sessionId : null,
              surface: rec.surface,
            },
            pi,
            opts?.watchRunning,
            opts?.exists,
          );
        } catch {
          // Best effort — rebuild must never break session startup.
        }
      }
    } catch {
      // Best effort — rebuild must never break session startup.
    }
  } catch {
    // Best effort — a failed scan must never break session startup.
  }
}

/**
 * `session_start` orchestration: context bookkeeping (H4), abort-controller
 * freshness (issue #5), recovery, then artifact GC (after recovery so the
 * sweep can never race a live claim the loops above just created).
 */
export function handleSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): void {
  latestCtx = ctx;
  // S1: refresh via invalidate + startup warning (no dead triple cache).
  invalidateExtensionConfigCache();
  warnOnInvalidConfig();
  // H4: remember this session's UI context for widget fan-out (and forget
  // it on shutdown) instead of rendering only into the latest session.
  try {
    const mgr0 = (ctx as any)?.sessionManager;
    if (mgr0?.getSessionDir && mgr0?.getSessionId) {
      sessionCtxs.set(getArtifactDir(mgr0.getSessionDir(), mgr0.getSessionId()), ctx);
    }
  } catch {}
  // pi runs multiple sessions in one process. A prior session's shutdown
  // aborts the shared module poll-abort controller; install a fresh one so
  // subagents spawned in this session aren't watched against a dead signal.
  // See https://github.com/HazAT/pi-interactive-subagents/issues/5
  ensureLiveAbortController();
  try {
    const mgr = (ctx as any)?.sessionManager;
    if (mgr?.getSessionDir && mgr?.getSessionId) {
      const artifactDir = getArtifactDir(mgr.getSessionDir(), mgr.getSessionId());
      recoverSession(subagentStore, artifactDir, pi);
      // L7/compat-3: best-effort artifact GC (stale claims + old staged
      // files). Runs after recovery so it can never race a live claim
      // the loops above just created; the 5-min claim grace covers the
      // concurrent-tick race during reload.
      try {
        sweepStaleArtifacts(artifactDir);
      } catch {
        // Best effort — GC must never break session startup.
      }
    }
  } catch {
    // Best effort — a failed scan must never break session startup.
  }
}

/**
 * Scoped per-session teardown (M1): abort + drop only the runs owned by the
 * shutting-down session's artifact dir — never the process-global poll
 * controller (reserved for /reload rotation at import; aborting it would
 * cancel other sessions' watchers sharing the process). Takes the store so
 * a fake proves the scoping (M5 acceptance). Pass `null` when the dir is
 * unresolvable for the legacy abort-all fallback (safe, no leak).
 */
export function teardownSession(store: SubagentStore, shuttingDir: string | null): void {
  // H4: forget this session's UI context first so later ticks never
  // render into a dead session.
  try {
    if (shuttingDir) sessionCtxs.delete(shuttingDir);
  } catch {}
  const matchesDir = (dir: string | undefined) =>
    !shuttingDir || !dir || dir === shuttingDir;
  // Fallback when the dir is unresolvable: legacy abort-all (safe, no leak).
  for (const [id, agent] of [...store.running]) {
    if (matchesDir((agent as any).parentArtifactDir)) {
      try {
        agent.abortController?.abort();
      } catch {}
      store.running.delete(id);
    }
  }
  for (const [key, kept] of [...store.kept]) {
    if (!shuttingDir || kept.parentArtifactDir === shuttingDir) {
      try {
        kept.abort.abort();
      } catch {}
      store.kept.delete(key);
    }
  }
  // H4: the widget/status timers are shared across sessions in one
  // process — stand them down only when nothing is left to supervise or
  // render. Unconditionally clearing them here used to blind surviving
  // sessions (dead widget + no stall/recovery steers) when any session
  // exited. Kept-tab monitors are independent async loops, unaffected.
  if (store.running.size === 0) {
    if (widgetInterval) {
      clearWidgetInterval(widgetInterval);
      widgetInterval = null;
    }
    if (statusInterval) {
      clearStatusInterval(statusInterval);
      statusInterval = null;
    }
  }
}

/**
 * `session_shutdown` orchestration: resolve this session's artifact dir and
 * tear down only its runs (M1). Kept for the wiring in index.ts.
 */
export function handleSessionShutdown(ctx: ExtensionContext): void {
  let shuttingDir: string | null = null;
  try {
    const mgr = (ctx as any)?.sessionManager;
    if (mgr?.getSessionDir && mgr?.getSessionId) {
      shuttingDir = getArtifactDir(mgr.getSessionDir(), mgr.getSessionId());
    }
  } catch {}
  teardownSession(subagentStore, shuttingDir);
}

/** Latest pi instance (set by the extension entry; ask-queue fallback only). */
export function setLatestPi(pi: ExtensionAPI | null): void {
  latestPi = pi;
}
