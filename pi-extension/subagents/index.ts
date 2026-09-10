import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isKittyAvailable,
  isMuxAvailable,
  kittySetupHint,
  muxSetupHint,
  createSurface,
  sendCommand,
  sendCommandAsync,
  sendLongCommand,
  pollForExit,
  closeSurface,
  closeSurfaceAsync,
  logCorruptDrop,
  shellEscape,
  readScreen,
  readScreenAsync,
  // L4: `windowExists` (lossy boolean wrapper) is deliberately NOT imported
  // — every prune path uses `windowExistsOrNull` so a control-plane hiccup
  // (null) can never prune or report-death a live tab (N3).
  windowExistsOrNull,
} from "./kitty.ts";
// Canonical helpers (R1 split, T1a clean names). Pure policy lives in the home
// module; index.ts imports it directly — no local shadowing wrappers.
import { getSubagentsDir, getArtifactDir } from "./paths.ts";
import { slugifyName } from "./names.ts";
import {
  formatElapsed,
  formatTokens,
  contextWindowFor,
  formatContextUsage,
  formatUsageSegments,
  formatElapsedMMSS,
} from "./format.ts";
import {
  resolveKeepDecision,
  resolveKeepForAgent,
} from "./keep.ts";
import {
  borderLine,
  borderTop,
  borderBottom,
  widgetIcon,
  formatWidgetRightLabel,
  renderSubagentWidgetLines as renderWidgetLines,
} from "./widget.ts";
import {
  DEFAULT_SUBAGENT_TOOLS,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  buildCdPrefix,
  buildEnvPrefix,
  scriptPreambleFor,
  scriptPathFor,
  withDoneSentinel,
} from "./launch.ts";
import {
  resolveResultPresentation,
} from "./notifications.ts";
import { getExtensionConfig, getSafeExtensionConfig, invalidateExtensionConfigCache } from "./config.ts";
import {
  buildClaudeCommand,
  copyClaudeSession,
  createClaudeSentinelFile,
} from "./cli/claude.ts";
import {
  observeRunningSubagent,
} from "./status-bridge.ts";
import {
  SubagentStore,
  keptKey,
  clearKeptSurface,
} from "./store.ts";
import {
  notifyResult,
  notifyError,
  notifyKeptTabError,
  notifyQuestion,
  notifyStatus,
} from "./notifications.ts";
import {
  renderSubagentToolCall,
  renderSubagentToolResult,
  renderSubagentsListToolResult,
  renderSubagentMessageToolCall,
  renderSubagentMessageToolResult,
  renderSubagentResultMessage,
  renderSubagentStatusMessage,
  renderSubagentQuestionMessage,
} from "./renderers.ts";

import {
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  readEntriesAfter,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  summarizeEntriesStats,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadExtensionConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = getSubagentsDir();

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent name. " +
        "Has no effect on which agent runs — use `agent` for that.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

// ── Agents (canonical in agents.ts — R1). Re-exported here for test compat. ──
export type {
  SubagentSessionMode,
  AgentDefaults,
  AgentSource,
  AgentDefinition,
  ListedAgentDefinition,
} from "./agents.ts";
import type {
  SubagentSessionMode as SubagentSessionModeT,
  AgentDefaults as AgentDefaultsT,
  AgentSource as AgentSourceT,
  AgentDefinition as AgentDefinitionT,
  ListedAgentDefinition as ListedAgentDefinitionT,
} from "./agents.ts";
import {
  getAgentConfigDir,
  getBundledAgentsDir,
  getFrontmatterValue,
  parseOptionalBoolean,
  parseCommaList,
  parseSubagentAgents,
  canSpawnSubagents,
  parseSessionMode,
  parseAgentDefinition,
  discoverAgentDefinitions,
  resolveSubagentPaths,
  getDefaultSessionDirFor,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  loadAgentDefaults,
  getSubagentAllowlist,
  getToolExtensionPath,
} from "./agents.ts";
export { registerToolExtension } from "./agents.ts";

type SubagentSessionMode = SubagentSessionModeT;
type AgentSource = AgentSourceT;
type AgentDefaults = AgentDefaultsT;
type AgentDefinition = AgentDefinitionT;
type ListedAgentDefinition = ListedAgentDefinitionT;

// T1a: pure-alias wrappers deleted — call sites use the canonical imports above
// under clean names (no `*Canonical` scar tissue). `getSubagentAllowlistFresh`
// is gone too: call sites read `getSubagentAllowlist()` fresh (R10/N1).

// S2: dup ICON_* deleted — canonical source is widget.ts (no local uses remained).

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
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
 * Exit/keep precedence (single source of truth: config.json + agent frontmatter).
 *
 *   keepOpen (config.json, global) × autoExit (agent.md `auto-exit`, per-agent):
 *     keepOpen=false + autoExit=*     → EXIT  (global takes precedence)
 *     keepOpen=true  + autoExit=true  → EXIT  (agent wants to close)
 *     keepOpen=true  + autoExit=false → KEEP  (both agree to stay open)
 *
 * In short: keep ⇔ (keepOpen && !autoExit); exit ⇔ !keep.
 * The parent encodes the exit side into `PI_SUBAGENT_AUTO_EXIT` and remembers
 * the keep side per-run (`RunningSubagent.keepSurface`) for tab closing.
 * Shell env is never consulted for keepOpen.
 */
function shouldKeepSurface(): boolean {
  return getExtensionConfig().tabs.keepOpen === true;
}

/** Per-agent keep decision: only keep when config allows AND the agent opts out of auto-exit. */
function shouldKeepSurfaceFor(autoExit: boolean): boolean {
  return resolveKeepDecision({ keepOpen: getExtensionConfig().tabs.keepOpen === true, autoExit }).keepSurface;
}

/** Per-agent keep decision from a loaded agent definition (missing def ⇒ autoExit=false). */
function shouldKeepForAgent(agentDefs: AgentDefaults | null): boolean {
  return resolveKeepForAgent(getExtensionConfig().tabs.keepOpen === true, agentDefs).keepSurface;
}

// T1a: `resolveKeepDecision` pure-alias wrapper deleted — call sites use the
// canonical import directly (clean name, no `*Canonical` suffix).

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

function maybeCloseSurface(surface: string, keepSurface: boolean): void {
  if (!shouldCloseSurface(keepSurface)) return;
  closeSurface(surface);
}

/** Async `maybeCloseSurface` (M11): adopted on completion paths. */
async function maybeCloseSurfaceAsync(surface: string, keepSurface: boolean): Promise<void> {
  if (!shouldCloseSurface(keepSurface)) return;
  await closeSurfaceAsync(surface);
}

function muxUnavailableResult() {
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
 * @deprecated Use muxUnavailableResult. Kept for test compat.
 * (Lows: the trivial alias body is collapsed — the name remains.)
 */
function kittyUnavailableResult() {
  return muxUnavailableResult();
}

// T1a/S1: `getArtifactDir` wrapper deleted — call sites use the canonical
// import directly. Dead triple cache (`extensionConfig`/`statusConfig`/
// `tabsConfig` + `safeConfigInit`/`refreshConfigCache`) deleted: every call
// site already reads `getExtensionConfig()` fresh (R10). `session_start`
// keeps the invalid-config startup warning via `warnOnInvalidConfig()` below
// + `invalidateExtensionConfigCache()` (S1 adjustment — pure invalidate
// preserves refresh but drops the drift surface).
function warnOnInvalidConfig(): void {
  try {
    getExtensionConfig(true);
  } catch (err) {
    try {
      console.error(`[subagents] invalid config, using defaults until fixed: ${(err as Error)?.message ?? err}`);
    } catch {}
    invalidateExtensionConfigCache();
  }
}

// T1b: `formatWidgetRightLabel` dropping wrapper deleted — call sites (and
// `__test__`) use the canonical with its full 2nd `opts` (cli/statusEnabled)
// so the claude `running…` label is never silently lost.
// T1a: `resolveResultPresentation` wrapper deleted — canonical used directly.

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
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
function shouldNotifyResult(result: Pick<SubagentResult, "error">): boolean {
  return result.error !== "cancelled";
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  /** Spawner session artifact dir owning this run (for per-session shutdown scoping, M1). */
  parentArtifactDir?: string;
  cli?: string;
  sentinelFile?: string;
  /** Per-run keep decision: keepOpen (config) && !autoExit (agent). True ⇒ leave tab open + pi interactive. */
  keepSurface?: boolean;
  /** Effective auto-exit sent to the child via PI_SUBAGENT_AUTO_EXIT (!keepSurface). */
  autoExit?: boolean;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id (backed by SubagentStore — R6). */
const subagentStore = new SubagentStore();
const runningSubagents = subagentStore.running as unknown as Map<string, RunningSubagent>;

/**
 * Kept-open tabs that outlived their first result (config `tabs.keepOpen` +
 * agent `auto-exit:false` → `.done` consumed, pi still interactive in the tab).
 * The spawn watcher is gone, but the session can still `ask_question` later
 * (e.g. after manual follow-ups in the tab) and can still be steered — typing
 * into the live tab addresses the SAME pi process, so unlike resume there is
 * no double-open hazard. Keyed by spawner-artifact-dir + name (names are only
 * unique per spawner session; the process may host several sessions).
 */
interface KeptTab {
  name: string;
  agent?: string;
  surface: string;
  sessionFile: string;
  sessionId: string | null;
  parentArtifactDir: string;
  abort: AbortController;
  /** Original run start (ms epoch) so kept-tab questions report real elapsed (N9). */
  startTime: number;
}
const keptTabs = subagentStore.kept as unknown as Map<string, KeptTab>;

// T1a: `keptKey` pure wrapper deleted — canonical `keptKey` from store.ts used
// directly (clean name, no `*Canonical` suffix).

// T1b/S5: `keptTabAlive` wrapper deleted — the N3 default
// (`windowExistsOrNull(s) !== false`, unknown ⇒ alive) lives in
// `store.ts:findKept`. This adapter only preserves the index-side cast.
function findKeptTab(
  artifactDir: string,
  name: string,
  exists?: (surface: string) => boolean,
): KeptTab | null {
  // Canonical prune+clear lives in store.ts (single implementation).
  const found = exists === undefined
    ? subagentStore.findKept(artifactDir, name)
    : subagentStore.findKept(artifactDir, name, exists);
  return found as unknown as KeptTab | null;
}

/**
 * Watch a kept tab until it closes: relay later `ask_question` signals live
 * (the spawn watcher already exited on the first `.done`) and report a later
 * agent-loop error via `.exit`. The first result was already delivered — a
 * clean close afterwards is silent. Aborted on session shutdown / tab death.
 */
async function monitorKeptTab(kept: KeptTab, piInstance: ExtensionAPI): Promise<void> {
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
function trackKeptTab(
  parentArtifactDir: string,
  params: { name: string; agent?: string; surface: string; sessionFile: string; sessionId: string | null; startTime?: number },
  piInstance: ExtensionAPI,
): void {
  const kept = subagentStore.trackKept(parentArtifactDir, params);
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
function decideResurrectAction(state: {
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
const STALE_CLAIM_MAX_AGE_MS = 5 * 60 * 1000;
const STAGED_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEPT_STAGING_DIRS = ["context", "subagent-scripts", "subagent-resume", "subagent-activity"];

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
function sweepStaleArtifacts(artifactDir: string): void {
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
 */
function resurrectRunningTab(
  artifactDir: string,
  regName: string,
  entry: { sessionFile: string; sessionId?: string | null; surface: string },
  piInstance: ExtensionAPI,
): boolean {
  const sessionPath = entry.sessionFile;
  if (!sessionPath || !existsSync(sessionPath)) return false;
  // Liveness: positively-gone tabs get their dead surface pruned (so
  // resume-by-name works); unknown control-plane keeps the watch (N3).
  // Already-tracked sessions are never double-watched.
  let alive: boolean | null;
  try {
    alive = windowExistsOrNull(entry.surface);
  } catch {
    alive = null;
  }
  const action = decideResurrectAction({
    tracked: !!subagentStore.findRunningBySessionFile(sessionPath),
    kept: subagentStore.kept.has(keptKey(artifactDir, regName)),
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
  const running: RunningSubagent = {
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
  runningSubagents.set(id, running);
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  startWidgetRefresh();
  startStatusRefresh(piInstance);
  watchSubagent(running, watcherAbort.signal, piInstance)
    .then((result) => {
      updateWidget();
      registerName(artifactDir, regName, {
        sessionFile: sessionPath,
        sessionId: result.sessionId ?? entry.sessionId ?? null,
        ...(result.surfaceKept ? { surface: running.surface } : {}),
      });
      if (result.surfaceKept) {
        trackKeptTab(
          artifactDir,
          {
            name: regName,
            agent: running.agent,
            surface: running.surface,
            sessionFile: sessionPath,
            sessionId: result.sessionId ?? null,
            startTime: running.startTime,
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
            task: running.task,
            agent: running.agent,
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
        notifyError(piInstance as any, regName, running.task, err);
      } catch {}
    });
  return true;
}

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

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
const sessionCtxs = new Map<string, ExtensionContext>();

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

// S2: dup ACCENT/RST deleted — canonical source is widget.ts (no local uses remained).
// T1a: `formatElapsedMMSS`/`border*`/`widgetIcon` wrappers deleted — canonicals used directly.

// T1b: RunningSubagent→WidgetRow adapter (real logic: map + `status.enabled`
// inject). Renamed to avoid shadowing `widget.ts:renderSubagentWidgetLines`
// (acceptance: no local `function` shadows a home-module export). `__test__`
// keeps the old key, re-pointed at this adapter (no test changes).
function renderRunningWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const now = Date.now();
  const rows = agents.map((agent) => ({
    name: agent.name,
    agent: agent.agent,
    startTime: agent.startTime,
    cli: agent.cli,
    snapshot: classifyStatus(agent.statusState, now),
  }));
  return renderWidgetLines(rows, width, { statusEnabled: getSafeExtensionConfig().status.enabled });
}

function updateWidget() {
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
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
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

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
// T1b/S12: `buildSubagentToolAllowlist` wrapper deleted — the `spawningTools`
// default now lives in `launch.ts` (imports SPAWNING_TOOLS from agents.ts),
// so the canonical is used directly. `DEFAULT_SUBAGENT_TOOLS` void-alias
// deleted — canonical imported clean. `applySandboxToParts`/`buildPiPromptArgs`
// pure wrappers deleted — canonicals used directly. `activityLabel` dead
// wrapper deleted (no call sites; bridge owns it).

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = subagentStore.reserved as unknown as Set<string>;

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  return subagentStore.uniqueName(base, registryNames);
}

function resolveRunningByName(name: string):
  | { running: RunningSubagent }
  | { error: string } {
  const res = subagentStore.resolveRunningByName(name);
  return res as unknown as { running: RunningSubagent } | { error: string };
}

/**
 * Type a follow-up message into a running subagent's live tab. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
/** Shared steer payload: newlines flattened (typed into a terminal). */
function flattenSteerMessage(message: string): string {
  return message.replace(/\s*\n\s*/g, " ").trim();
}

function steerSubagent(
  running: RunningSubagent,
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
async function steerSubagentAsync(
  running: RunningSubagent,
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

async function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => unknown = sendCommandAsync,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "");
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

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
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

function startStatusRefresh(pi: ExtensionAPI) {
  // M4: timer paths degrade to last-good config (never throw per tick).
  if (!getSafeExtensionConfig().status.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
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

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  shouldKeepSurface,
  shouldKeepSurfaceFor,
  shouldKeepForAgent,
  resolveKeepDecision,
  // T1b: old key intact, re-pointed at the renamed RunningSubagent adapter
  // (no test changes; `test/test.ts` imports only via `__test__`).
  renderSubagentWidgetLines: renderRunningWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  parseSubagentAgents,
  canSpawnSubagents,
  DEFAULT_SUBAGENT_TOOLS,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  buildCdPrefix,
  buildEnvPrefix,
  scriptPreambleFor,
  slugifyName,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  resolveRunningByName,
  uniqueRunningName,
  reservedNames,
  subagentStore,
  steerSubagent,
  handleSubagentSteer,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  deliverPendingQuestion,
  recoverPendingQuestions,
  findKeptTab,
  keptKey,
  keptTabs,
  runningSubagents,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
  shouldNotifyResult,
  restoreAskClaimNoClobber,
  decideResurrectAction,
  steerSubagentAsync,
  sessionCtxs,
  startWidgetRefresh,
  startStatusRefresh,
  timersActiveForTest,
};

/** Test seam (H4): whether the shared widget/status timers are armed. */
function timersActiveForTest(): { widget: boolean; status: boolean } {
  return { widget: widgetInterval !== null, status: statusInterval !== null };
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the kitty tab, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
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

    const launchBehavior = resolveLaunchBehavior(params, agentDefs);

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

    const launchScriptName = `${slugifyName(params.name)}-${id}.sh`;
    const launchScriptFile = scriptPathFor(artifactDir, launchScriptName);

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      cwd: targetCwdForSession ?? null,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running: RunningSubagent = {
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

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

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

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: params.name });

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envParts: string[] = [];

  if (resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resolvedAgentDir)}`);
  }

  // `true` leaves PI_SUBAGENT_ALLOWED unset (child allowlist = unrestricted);
  // a list pins it. Missing/`false` never reach here (no grant).
  if (grantSpawning && Array.isArray(agentDefs?.subagentAgents)) {
    envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(agentDefs.subagentAgents.join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  // Exit/keep encoding (config.json is the sole truth for keepOpen; the legacy
  // PI_SUBAGENT_KEEP_TAB wire is removed and scrubbed — see command prefix below).
  // keepOpen=false forces exit even for `auto-exit: false` agents (global precedence).
  // keepOpen=true delegates to the agent: auto-exit ⇒ close, otherwise stay open + `.done`.
  // effectiveAutoExit ⇔ !keepSurface ⇔ (!keepOpen || agentAutoExit).
  if (effectiveAutoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const artifactName = `context/${slugifyName(params.name)}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // cd into the subagent cwd (parent session dir by default) before starting pi,
  // so the child process cwd matches its session placement.
  const cdPrefix = buildCdPrefix(targetCwdForSession);

  // Scrub the removed legacy wire: a user shell that still exports
  // PI_SUBAGENT_KEEP_TAB (dotfiles / old sessions) would otherwise leak it
  // into the child via shell inheritance. config.json stays the sole truth.
  const scrubPrefix = "unset PI_SUBAGENT_KEEP_TAB; ";
  const piCommand = scrubPrefix + cdPrefix + envPrefix + parts.join(" ");
  const command = withDoneSentinel(piCommand);
  const launchScriptName = `${slugifyName(params.name)}-${id}.sh`;
  const launchScriptFile = scriptPathFor(artifactDir, launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    cwd: targetCwdForSession ?? null,
    scriptPreamble: scriptPreambleFor("launch", {
      name: params.name,
      sessionFile: subagentSessionFile,
      surface,
    }),
  });

  const running: RunningSubagent = {
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

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
// N16: session dir owned by cli/claude.ts (os.homedir-based). No local copy.
// T1a: `copyClaudeSession` wrapper deleted — canonical used directly.

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
type QuestionCarrier = Pick<RunningSubagent, "name" | "agent" | "sessionFile" | "startTime">;

/**
 * Re-deliver any orphaned `.ask` files left by watchers that died with their
 * parent process (pi exit / `/reload` aborts every watcher). Without this, a
 * question asked while the parent was reloading is lost forever: the live
 * tick that would have picked it up is gone, and no new watcher starts for
 * the old run. Runs on every `session_start` for this spawner session's own
 * registry; delivery consumes the file so a racing live watcher can't double-fire.
 */
function recoverPendingQuestions(piInstance: ExtensionAPI, artifactDir: string): void {
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

function claimAskFile(askFile: string): string | null {
  // Atomic claim (C3/M4): rename before read so concurrent ticks
  // (1s poll, 2s kept-tab poll, session_start recovery) can't double-fire.
  // ENOENT means another consumer won the race.
  const claim = `${askFile}.consuming-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    renameSync(askFile, claim);
    return claim;
  } catch {
    return null;
  }
}

/**
 * Promote the oldest queued `.pending-*` question to `.ask` when no live
 * `.ask` exists (M2). The no-clobber restore below parks an undelivered
 * payload here instead of overwriting a newer question; the next tick
 * drains it. Best-effort, never throws.
 */
function promotePendingAskFile(sessionFile: string): void {
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
function restoreAskClaimNoClobber(claim: string, askFile: string): "restored" | "kept-newer" {
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

function deliverPendingQuestion(running: QuestionCarrier, piInstance?: ExtensionAPI | null): boolean {
  // Drain any previously parked question first (M2 queue).
  promotePendingAskFile(running.sessionFile);
  const askFile = `${running.sessionFile}.ask`;
  const retryMarker = `${askFile}.corrupt-retry`;
  const claim = claimAskFile(askFile);
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
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);

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

async function watchSubagent(
  running: RunningSubagent,
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

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        // N7: async scrape (sync execFileSync would block the extension host).
        try {
          summary = (
            await readScreenAsync(surface, 200)
          )
            .replace(/__SUBAGENT_DONE_\d+__/, "")
            .trimEnd();
        } catch {
          summary = "";
        }
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      await maybeCloseSurfaceAsync(surface, running.keepSurface === true);
      runningSubagents.delete(running.id);

      return { name, task, summary, exitCode: result.exitCode, elapsed, surfaceKept: running.keepSurface === true, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    // Pi subagent result extraction — Missing #2: a single read via
    // `readEntriesAfter` feeds both the summary and the stats (previously a
    // full parse here plus a second full read+parse in
    // `summarizeSessionStats`, i.e. two sync multi-MB JSON parses per
    // completion on the extension host).
    let summary: string;
    let stats: SessionStats | null = null;
    if (existsSync(sessionFile)) {
      const read = readEntriesAfter(sessionFile, 0);
      stats = summarizeEntriesStats(read.entries);
      summary =
        findLastAssistantMessage(read.entries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    await maybeCloseSurfaceAsync(surface, running.keepSurface === true);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
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
    // success path unlinks; abort/error must too.
    if (running.sentinelFile) {
      try {
        unlinkSync(running.sentinelFile);
      } catch {}
      try {
        unlinkSync(running.sentinelFile + ".transcript");
      } catch {}
    }
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
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
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
    // Catch up on questions orphaned by a dead watcher (pi exit / `/reload`
    // while a subagent was parked on ask_question). The live tick is gone;
    // without this the `.ask` file sits unconsumed forever.
    // Also re-attach monitors + steer routing for kept tabs still alive.
    try {
      const mgr = (ctx as any)?.sessionManager;
      if (mgr?.getSessionDir && mgr?.getSessionId) {
        const artifactDir = getArtifactDir(mgr.getSessionDir(), mgr.getSessionId());
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
            if (keptTabs.has(keptKey(artifactDir, regName))) continue;
            let alive = false;
            try {
              // S5: N3 probe inline (keptTabAlive wrapper deleted; default lives in store.ts).
              alive = existsSync(sf) && windowExistsOrNull(surf) !== false;
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
            trackKeptTab(
              artifactDir,
              { name: regName, agent, surface: surf, sessionFile: sf, sessionId: (regEntry as { sessionId?: string }).sessionId ?? null },
              pi,
            );
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
                artifactDir,
                regName,
                {
                  sessionFile: rec.sessionFile,
                  sessionId: typeof rec.sessionId === "string" ? rec.sessionId : null,
                  surface: rec.surface,
                },
                pi,
              );
            } catch {
              // Best effort — rebuild must never break session startup.
            }
          }
        } catch {
          // Best effort — rebuild must never break session startup.
        }
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
  });

  // Clean up on session shutdown (M1: scoped per-session — never abort the
  // process-global poll controller here; it is reserved for /reload rotation
  // at import. Aborting it would cancel other sessions' watchers sharing the
  // process. Resolve this session's artifact dir and tear down only its runs.)
  pi.on("session_shutdown", (_event, _ctx) => {
    let shuttingDir: string | null = null;
    try {
      const mgr = (_ctx as any)?.sessionManager;
      if (mgr?.getSessionDir && mgr?.getSessionId) {
        shuttingDir = getArtifactDir(mgr.getSessionDir(), mgr.getSessionId());
      }
    } catch {}
    // H4: forget this session's UI context first so later ticks never
    // render into a dead session.
    try {
      if (shuttingDir) sessionCtxs.delete(shuttingDir);
    } catch {}
    const matchesDir = (dir: string | undefined) =>
      !shuttingDir || !dir || dir === shuttingDir;
    // Fallback when the dir is unresolvable: legacy abort-all (safe, no leak).
    for (const [id, agent] of [...runningSubagents]) {
      if (matchesDir((agent as any).parentArtifactDir)) {
        try {
          agent.abortController?.abort();
        } catch {}
        runningSubagents.delete(id);
      }
    }
    for (const [key, kept] of [...keptTabs]) {
      if (!shuttingDir || kept.parentArtifactDir === shuttingDir) {
        try {
          kept.abort.abort();
        } catch {}
        keptTabs.delete(key);
      }
    }
    // H4: the widget/status timers are shared across sessions in one
    // process — stand them down only when nothing is left to supervise or
    // render. Unconditionally clearing them here used to blind surviving
    // sessions (dead widget + no stall/recovery steers) when any session
    // exited. Kept-tab monitors are independent async loops, unaffected.
    if (runningSubagents.size === 0) {
      if (widgetInterval) {
        clearInterval(widgetInterval);
        widgetInterval = null;
        (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
      }
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
    }
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated kitty tab. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated kitty tab. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a restricted subagent (PI_SUBAGENT_ALLOWED) → only its pinned agents;
        //   • an unrestricted subagent (`subagent_agents: true`, no allowlist env)
        //     or a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows.
        // Every spawn must name an agent in that set. The lone exception is a
        // top-level `fork: true` clone, which has no role and inherits the
        // caller's own already-trusted toolset. Without this guard a missing or
        // unknown `agent` silently launches an unrestricted, full-toolset child.
        const freshAllowlist = getSubagentAllowlist();
        const permittedAgents = freshAllowlist
          ? [...freshAllowlist]
          : discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        if (!params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${freshAllowlist ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: {
              error: freshAllowlist ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        // C1: display `name` lands in `# …` preamble comments of a
        // `bash`-executed script file, and `cwd` feeds `join()`-derived paths
        // that land in the same comments. Interior newlines would escape the
        // comment and execute as shell — reject control characters at the
        // tool boundary (the sink in `sendLongCommand` re-validates
        // defensively, covering resumed/registry names too).
        if (params.name != null && /[\r\n\0]/.test(params.name)) {
          return {
            content: [
              {
                type: "text",
                text: "`name` must not contain newline or control characters.",
              },
            ],
            details: { error: "invalid name" },
          };
        }
        if (params.cwd != null && /[\r\n\0]/.test(params.cwd)) {
          return {
            content: [
              {
                type: "text",
                text: "`cwd` must not contain newline or control characters.",
              },
            ],
            details: { error: "invalid cwd" },
          };
        }

        // Validate prerequisites (need mux + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isKittyAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // M2: names are unique per spawner session (running or finished).
        // Defaulted AND explicit names both go through uniqueRunningName against
        // running + reserved + registry, reserved synchronously (before any
        // await) so parallel spawns can't collide and no spawn ever steals
        // another run's registry handle. An explicit "X" taken becomes "X-2".
        let reservedName: string | null = null;
        {
          const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
          const base = params.name?.trim() || params.agent;
          const unique = uniqueRunningName(base, registryNames);
          if (params.name?.trim() && unique !== params.name.trim()) {
            // Tell the caller about the rename via the acknowledgement details
            // (content stays stable; details carry requested vs assigned).
            (params as any).__requestedName = params.name.trim();
          }
          params.name = unique;
          reservedName = unique;
          reservedNames.add(reservedName);
        }

        // Launch the subagent (creates pane, sends command). Release the name
        // reservation once it registers in runningSubagents (or launch fails) —
        // from then on uniqueRunningName tracks it via the running map.
        let running;
        try {
          running = await launchSubagent(params, ctx);
        } finally {
          if (reservedName) reservedNames.delete(reservedName);
        }

        // Persist name → session so subagent_message({ name }) can resume this
        // subagent after it finishes (and after a pi restart). Done at launch,
        // not completion, so the handle exists even if the parent dies mid-run.
        // H5: persist the live `surface` too (marked `running`), so a
        // `/reload` that orphans this run can re-watch the still-live tab on
        // `session_start` instead of losing its result. The completion
        // handler re-registers without `running` (keeping `surface` only for
        // kept tabs), so the flag cannot go stale.
        registerName(parentArtifactDir, running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
          surface: running.surface,
          running: true,
        });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background (thread spawner's pi
        // so ask_question delivery goes to the right session, not latestPi).
        watchSubagent(running, watcherAbort.signal, pi)
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately

            // Keep the registry truthful about kept tabs (feeds the resume
            // double-open guard); clears any stale surface otherwise.
            registerName(parentArtifactDir, running.name, {
              sessionFile: running.sessionFile,
              sessionId: result.sessionId ?? null,
              ...(result.surfaceKept ? { surface: running.surface } : {}),
            });

            // Kept tab outlives this watcher: keep relaying later
            // ask_question signals and allow steering into the live tab.
            // Without this, questions asked after manual follow-ups in the
            // kept tab sit orphaned until the next /reload recovery.
            if (result.surfaceKept) {
              trackKeptTab(
                parentArtifactDir,
                {
                  name: running.name,
                  agent: running.agent,
                  surface: running.surface,
                  sessionFile: running.sessionFile,
                  sessionId: result.sessionId ?? null,
                  startTime: running.startTime,
                },
                pi,
              );
            }

            if (shouldNotifyResult(result)) {
              try {
                notifyResult(pi as any, {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  summary: result.summary,
                  sessionFile: result.sessionFile,
                  sessionId: result.sessionId,
                  claudeSessionId: result.claudeSessionId,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  errorMessage: result.errorMessage,
                  stats: result.stats,
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
              notifyError(pi as any, running.name, running.task, err);
            } catch {
              // Teardown races sendMessage — never reject unhandled.
            }
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            ...((params as any).__requestedName && (params as any).__requestedName !== params.name
              ? { requestedName: (params as any).__requestedName, renamed: true }
              : {}),
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      // P3: presentation lives in renderers.ts (single home).
      renderCall: renderSubagentToolCall,

      renderResult: renderSubagentToolResult,
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      // P3: presentation lives in renderers.ts.
      renderResult: renderSubagentsListToolResult,
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
        "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
        "if it has finished, your message resumes that session and continues it. " +
        "`name` and `message` are both required. " +
        "Keep steers human-scale (a paragraph or two): the message is typed into the child's terminal, so multi-KB pastes risk terminal line-wrap mangling — put long content in a file and point the subagent at the path instead. " +
        "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
        "`name` and `message` are required. Steering returns immediately; resuming delivers its result later as a steer message. " +
        "Do not poll or fabricate results.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
        }),
        message: Type.String({
          description:
            "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
        }),
      }),

      // P3: presentation lives in renderers.ts.
      renderCall: renderSubagentMessageToolCall,

      // P3: presentation lives in renderers.ts.
      renderResult: renderSubagentMessageToolResult,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
        // M2: resolve via resolveRunningByName so duplicates (e.g. spawned
        // before the dedupe fix) surface an ambiguity error instead of
        // steering a random match.
        {
          const resolved = resolveRunningByName(requestedName);
          if ("running" in resolved) {
            return handleSubagentSteer({ name: resolved.running.name, message: params.message });
          }
          // "No running subagent" is not an error here — fall through to the
          // resume-by-name path below. Ambiguity IS an error: surface it.
          if (!resolved.error.startsWith("No running subagent")) {
            return {
              content: [{ type: "text" as const, text: resolved.error }],
              details: { error: resolved.error },
            };
          }
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
          const err =
            `Subagent "${requestedName}" is registered but its session file is gone ` +
            `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
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
          const live = subagentStore.findRunningBySessionFile(sessionPath) as unknown as RunningSubagent | null;
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
              { surface: kept.surface, name: kept.name } as RunningSubagent,
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
          const err =
            `Cannot safely resume "${requestedName}": no sandbox snapshot found for this session ` +
            `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
            `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
            `Re-run the task as a fresh subagent instead.`;
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
            const raced = subagentStore.findRunningBySessionFile(sessionPath) as unknown as RunningSubagent | null;
            if (raced) {
              closeResumeSurface();
              releaseResume();
              return handleSubagentSteer({ name: raced.name, message: params.message });
            }
            if (entry.surface) {
              const racedKept = findKeptTab(parentArtifactDir, requestedName);
              if (racedKept) {
                const racedSteer = await steerSubagentAsync(
                  { surface: racedKept.surface, name: racedKept.name } as RunningSubagent,
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
        const parts = ["pi", "--session", shellEscape(sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        // Replay the model, identity, and default-deny tool/extension sandbox.
        applySandboxToParts(parts, loadout, { artifactDir, name });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${slugifyName(name) || "resume"}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, message, "utf8");
          parts.push(shellEscape(`@${resumeMsgFile}`));
        }

        // Build env prefix — replay the snapshot's config dir + spawn whitelist
        // so the resumed process resolves the same agents/extensions and keeps
        // the same nested-spawn restriction it originally ran with.
        const resumeEnvParts: string[] = [];
        const resumeAgentDir = loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
        if (resumeAgentDir) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resumeAgentDir)}`);
        }
        if (loadout.spawnable && loadout.spawnable.length > 0) {
          resumeEnvParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`);
        }
        if (loadout.agent) {
          resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        // Resume is always autonomous (autoExit=true) ⇒ always exits, even when
        // tabs.keepOpen is true (keep ⇔ keepOpen && !autoExit ⇔ false here).
        // The legacy PI_SUBAGENT_KEEP_TAB wire is removed; config.json stays truth.
        if (autoExit) {
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
        }
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        // Resume in the subagent's original cwd so its tools (safe_bash, edits)
        // operate where they did before (pre-cwd-default snapshots with null
        // fall back to the current parent session dir).
        const resumeCwd = loadout.cwd ?? (ctx as unknown as { cwd?: string }).cwd ?? null;
        const resumeCdPrefix = buildCdPrefix(resumeCwd);

        const command = withDoneSentinel(`unset PI_SUBAGENT_KEEP_TAB; ${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}`);
        const launchScriptFile = scriptPathFor(
          artifactDir,
          `${slugifyName(name) || "resume"}-resume-${Date.now()}.sh`,
        );
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
        } catch (err) {
          closeResumeSurface();
          releaseResume();
          throw err;
        }

        // Register as a running subagent for widget tracking
        // Resume is always autonomous ⇒ keepSurface=false (always closes).
        const running: RunningSubagent = {
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
              summary =
                findLastAssistantMessage(allEntries) ??
                (result.errorMessage
                  ? `Subagent error: ${result.errorMessage}`
                  : result.exitCode !== 0
                    ? `Resumed session exited with code ${result.exitCode}`
                    : "Resumed session exited without new output");
            } catch {
              // C4: session-file read failure must not discard a good result.
              summary =
                result.summary ||
                (result.errorMessage
                  ? `Subagent error: ${result.errorMessage}`
                  : "Resumed session exited without new output");
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
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // P3/T6: presentation lives in renderers.ts (details.summary first, stripping-fallback for old messages).
  pi.registerMessageRenderer("subagent_result", renderSubagentResultMessage);

  pi.registerMessageRenderer("subagent_status", renderSubagentStatusMessage);

  pi.registerMessageRenderer("subagent_question", renderSubagentQuestionMessage);


}
// test
