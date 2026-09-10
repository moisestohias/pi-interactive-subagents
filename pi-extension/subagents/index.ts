import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join, resolve } from "node:path";
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
} from "node:fs";
import { homedir } from "node:os";
import {
  isKittyAvailable,
  isMuxAvailable,
  kittySetupHint,
  muxSetupHint,
  createSurface,
  sendCommand,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreen,
  readScreenAsync,
  windowExists,
  windowExistsOrNull,
} from "./kitty.ts";
// Canonical helpers (R1 split). index.ts keeps thin wrappers for test compat
// while new code imports these modules directly.
import { getSubagentsDir, getArtifactDir as getArtifactDirCanonical } from "./paths.ts";
import { slugifyName } from "./names.ts";
import {
  formatElapsed as formatElapsedCanonical,
  formatTokens as formatTokensCanonical,
  contextWindowFor as contextWindowForCanonical,
  formatContextUsage as formatContextUsageCanonical,
  formatUsageSegments as formatUsageSegmentsCanonical,
  formatElapsedMMSS as formatElapsedMMSSCanonical,
} from "./format.ts";
import {
  resolveKeepDecision as resolveKeepDecisionCanonical,
  resolveKeepForAgent as resolveKeepForAgentCanonical,
} from "./keep.ts";
import {
  borderLine as borderLineCanonical,
  borderTop as borderTopCanonical,
  borderBottom as borderBottomCanonical,
  widgetIcon as widgetIconCanonical,
  formatWidgetRightLabel as formatWidgetRightLabelCanonical,
  renderSubagentWidgetLines as renderWidgetLinesCanonical,
} from "./widget.ts";
import {
  SUBAGENT_CONTROL_TOOLS as SUBAGENT_CONTROL_TOOLS_CANONICAL,
  DEFAULT_SUBAGENT_TOOLS as DEFAULT_SUBAGENT_TOOLS_CANONICAL,
  buildSubagentToolAllowlist as buildAllowlistCanonical,
  applySandboxToParts as applySandboxCanonical,
  buildPiPromptArgs as buildPiPromptArgsCanonical,
  buildCdPrefix as buildCdPrefixCanonical,
  buildEnvPrefix as buildEnvPrefixCanonical,
  scriptPreambleFor as scriptPreambleForCanonical,
  scriptPathFor as scriptPathForCanonical,
  withDoneSentinel as withDoneSentinelCanonical,
} from "./launch.ts";
import {
  resolveResultPresentation as resolveResultPresentationCanonical,
  keptTabSuffix as keptTabSuffixCanonical,
} from "./notifications.ts";
import { getExtensionConfig, invalidateExtensionConfigCache } from "./config.ts";
import {
  buildClaudeCommand as buildClaudeCommandCanonical,
  copyClaudeSession as copyClaudeSessionCanonical,
} from "./cli/claude.ts";
import {
  activityLabel as activityLabelCanonical,
  observeRunningSubagent as observeRunningCanonical,
} from "./status-bridge.ts";
import {
  SubagentStore as SubagentStoreCanonical,
  keptKey as keptKeyCanonical,
  clearKeptSurface as clearKeptSurfaceCanonical,
} from "./store.ts";
import {
  notifyResult as notifyResultCanonical,
  notifyError as notifyErrorCanonical,
  notifyKeptTabError as notifyKeptTabErrorCanonical,
  notifyQuestion as notifyQuestionCanonical,
  notifyStatus as notifyStatusCanonical,
} from "./notifications.ts";

import {
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  summarizeSessionStats,
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
  SPAWNING_TOOLS as SPAWNING_TOOLS_CANONICAL,
  BUILTIN_TOOLS as BUILTIN_TOOLS_CANONICAL,
  getAgentConfigDir as getAgentConfigDirCanonical,
  getBundledAgentsDir as getBundledAgentsDirCanonical,
  getFrontmatterValue as getFrontmatterValueCanonical,
  parseOptionalBoolean as parseOptionalBooleanCanonical,
  parseCommaList as parseCommaListCanonical,
  parseSubagentAgents as parseSubagentAgentsCanonical,
  canSpawnSubagents as canSpawnSubagentsCanonical,
  parseSessionMode as parseSessionModeCanonical,
  parseAgentDefinition as parseAgentDefinitionCanonical,
  discoverAgentDefinitions as discoverAgentDefinitionsCanonical,
  resolveSubagentPaths as resolveSubagentPathsCanonical,
  getDefaultSessionDirFor as getDefaultSessionDirCanonical,
  resolveEffectiveSessionMode as resolveEffectiveSessionModeCanonical,
  resolveLaunchBehavior as resolveLaunchBehaviorCanonical,
  resolveEffectiveInteractive as resolveEffectiveInteractiveCanonical,
  loadAgentDefaults as loadAgentDefaultsCanonical,
  getSubagentAllowlist as getSubagentAllowlistCanonical,
  getToolExtensionPath as getToolExtensionPathCanonical,
} from "./agents.ts";
export { registerToolExtension } from "./agents.ts";
import { registerToolExtension as registerToolExtensionCanonical } from "./agents.ts";

type SubagentSessionMode = SubagentSessionModeT;
type AgentSource = AgentSourceT;
type AgentDefaults = AgentDefaultsT;
type AgentDefinition = AgentDefinitionT;
type ListedAgentDefinition = ListedAgentDefinitionT;

const SPAWNING_TOOLS = SPAWNING_TOOLS_CANONICAL;
const BUILTIN_TOOLS = BUILTIN_TOOLS_CANONICAL;

function getAgentConfigDir(): string {
  return getAgentConfigDirCanonical();
}

function getToolExtensionPath(tool: string): string | undefined {
  return getToolExtensionPathCanonical(tool);
}

function getSubagentAllowlistFresh(): Set<string> | null {
  return getSubagentAllowlistCanonical();
}

// N1: no frozen allowlist const — every gate reads fresh via
// getSubagentAllowlistFresh()/getSubagentAllowlistCanonical() (R10).

function getBundledAgentsDir(): string {
  return getBundledAgentsDirCanonical();
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  return getFrontmatterValueCanonical(frontmatter, key);
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return parseOptionalBooleanCanonical(value);
}

function parseCommaList(value: string | undefined): string[] | undefined {
  return parseCommaListCanonical(value);
}

function parseSubagentAgents(value: string | undefined): boolean | string[] | undefined {
  return parseSubagentAgentsCanonical(value);
}

function canSpawnSubagents(agentDefs: AgentDefaults | null | undefined): boolean {
  return canSpawnSubagentsCanonical(agentDefs);
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  return parseSessionModeCanonical(value);
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  return parseAgentDefinitionCanonical(content, fallbackName) as AgentDefinition | null;
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  return discoverAgentDefinitionsCanonical() as ListedAgentDefinition[];
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  return resolveSubagentPathsCanonical(params, agentDefs);
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  return getDefaultSessionDirCanonical(cwd, agentDir);
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return resolveEffectiveSessionModeCanonical(params, agentDefs);
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  return resolveLaunchBehaviorCanonical(params, agentDefs);
}

function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  return resolveEffectiveInteractiveCanonical(_params, agentDefs);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  return loadAgentDefaultsCanonical(agentName);
}

function formatElapsed(seconds: number): string {
  return formatElapsedCanonical(seconds);
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return formatTokensCanonical(n);
}

/**
 * Known context-window sizes by model id substring (canonical table in format.ts).
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  return contextWindowForCanonical(model);
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  return formatContextUsageCanonical(tokens, contextWindow);
}

/**
 * Build the dim usage line for a completed subagent (canonical in format.ts).
 */
function formatUsageSegments(stats: SessionStats): string[] {
  return formatUsageSegmentsCanonical(stats);
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

/** Map a live status kind to a colored single-char icon (canonical in widget.ts). */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  return widgetIconCanonical(kind);
}

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
  return resolveKeepDecisionCanonical({ keepOpen: getExtensionConfig().tabs.keepOpen === true, autoExit }).keepSurface;
}

/** Per-agent keep decision from a loaded agent definition (missing def ⇒ autoExit=false). */
function shouldKeepForAgent(agentDefs: AgentDefaults | null): boolean {
  return resolveKeepForAgentCanonical(getExtensionConfig().tabs.keepOpen === true, agentDefs).keepSurface;
}

/** Single-decision helper for new code: returns both keep + auto-exit sides. */
function resolveKeepDecision(opts: { keepOpen: boolean; autoExit: boolean }): { keepSurface: boolean; effectiveAutoExit: boolean } {
  return resolveKeepDecisionCanonical(opts);
}

/**
 * Close a finished subagent's tab unless this specific run was kept open.
 * Pass the run's `keepSurface` decision; when omitted, falls back to the
 * global config (legacy call sites / tests).
 */
function maybeCloseSurface(surface: string, keepSurface?: boolean): void {
  const keep = keepSurface ?? shouldKeepSurface();
  if (keep) return;
  closeSurface(surface);
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

/** @deprecated Use kittySetupHint-backed muxUnavailableResult. Kept for test compat. */
function kittyUnavailableResult() {
  return muxUnavailableResult();
}

/**
 * Build the internal artifact directory path (canonical in paths.ts).
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return getArtifactDirCanonical(sessionDir, sessionId);
}

// Live config accessors (R10): read fresh per call instead of frozen import-time
// globals. Legacy lets kept (unread by new code) for compat — refreshed on
// session_start. Import/refresh never throw (M5): schema errors are logged
// loudly and surface on the next strict getExtensionConfig() call in a tool
// path; the framework hooks keep running on last-good/defaults.
function safeConfigInit(): import("./config.ts").ExtensionConfig {
  try {
    return getExtensionConfig(true);
  } catch (err) {
    try {
      console.error(`[subagents] invalid config, using defaults until fixed: ${(err as Error)?.message ?? err}`);
    } catch {}
    invalidateExtensionConfigCache();
    return { status: { enabled: true, lineLimit: 4 }, tabs: { keepOpen: false } };
  }
}

let extensionConfig = safeConfigInit();
let statusConfig = extensionConfig.status;
let tabsConfig = extensionConfig.tabs;

function refreshConfigCache(): void {
  const next = safeConfigInit();
  extensionConfig = next;
  statusConfig = next.status;
  tabsConfig = next.tabs;
}

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  return formatWidgetRightLabelCanonical(snapshot);
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  name: string,
): string {
  return resolveResultPresentationCanonical(result, name);
}

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
const subagentStore = new SubagentStoreCanonical();
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

function keptKey(artifactDir: string, name: string): string {
  return keptKeyCanonical(artifactDir, name);
}

/** Find a kept tab for this spawner session by name (prunes it if its tab died). */
function keptTabAlive(surface: string): boolean {
  // N3: control-plane unknown (null) reads as alive — never prune/report-dead
  // on a socket hiccup.
  try {
    return windowExistsOrNull(surface) !== false;
  } catch {
    return true;
  }
}

function findKeptTab(
  artifactDir: string,
  name: string,
  exists: (surface: string) => boolean = keptTabAlive,
): KeptTab | null {
  // Canonical prune+clear lives in store.ts (single implementation).
  const found = subagentStore.findKept(artifactDir, name, exists);
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
        onTick() {
          deliverPendingQuestion(
            { name: kept.name, agent: kept.agent, sessionFile: kept.sessionFile, startTime: kept.startTime },
            piInstance,
          );
        },
      },
    );
    if (result.reason === "error") {
      try {
        notifyKeptTabErrorCanonical(piInstance as any, kept.name, result.errorMessage ?? "unknown");
      } catch {
        // Best effort — the error is also visible in the kept tab itself.
      }
    }
    // Clean close afterwards is silent: the first result was already delivered.
  } catch {
    // Aborts (shutdown/reload) and poll failures end the monitor quietly.
  } finally {
    subagentStore.untrackKept(kept.parentArtifactDir, kept.name);
    clearKeptSurfaceCanonical(kept.parentArtifactDir, kept.name, kept);
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

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  return formatElapsedMMSSCanonical(startTime);
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line (canonical in widget.ts).
 */
function borderLine(left: string, right: string, width: number): string {
  return borderLineCanonical(left, right, width);
}

/**
 * Build the bordered top line (canonical in widget.ts).
 */
function borderTop(title: string, info: string, width: number): string {
  return borderTopCanonical(title, info, width);
}

/**
 * Build the bordered bottom line (canonical in widget.ts).
 */
function borderBottom(width: number): string {
  return borderBottomCanonical(width);
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const now = Date.now();
  const rows = agents.map((agent) => ({
    name: agent.name,
    agent: agent.agent,
    startTime: agent.startTime,
    cli: agent.cli,
    snapshot: classifyStatus(agent.statusState, now),
  }));
  return renderWidgetLinesCanonical(rows, width, { statusEnabled: getExtensionConfig().status.enabled });
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
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
// Canonical tool baselines live in launch.ts (single home — N11).
const DEFAULT_SUBAGENT_TOOLS = DEFAULT_SUBAGENT_TOOLS_CANONICAL;
void SUBAGENT_CONTROL_TOOLS_CANONICAL;

/**
 * Build the child --tools allowlist (canonical in launch.ts).
 */
function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean },
): string | null {
  return buildAllowlistCanonical(effectiveTools, { ...opts, spawningTools: SPAWNING_TOOLS });
}

/**
 * Apply a loadout snapshot's sandbox (canonical in launch.ts).
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  return applySandboxCanonical(parts, loadout, opts);
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  return buildPiPromptArgsCanonical(params);
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  return activityLabelCanonical(activity);
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  return observeRunningCanonical(running as any, observedAt);
}

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
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
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

function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
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

  const steer = steerSubagent(running, message, send);
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
  if (!getExtensionConfig().status.enabled || statusInterval) return;

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
      const lineLimit = getExtensionConfig().status.lineLimit;
      const capped = capStatusLines(transitionLines, lineLimit);
      notifyStatusCanonical(pi as any, {
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
  renderSubagentWidgetLines,
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
  buildCdPrefix: buildCdPrefixCanonical,
  buildEnvPrefix: buildEnvPrefixCanonical,
  scriptPreambleFor: scriptPreambleForCanonical,
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
};

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
  const { keepSurface, effectiveAutoExit } = resolveKeepDecisionCanonical({
    keepOpen: getExtensionConfig().tabs.keepOpen === true,
    autoExit: agentAutoExit,
  });
  // ── Claude Code CLI path (command via cli/claude.ts canonical builder) ──
  if (agentDefs?.cli === "claude") {
    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    const { command: claudeBase, sentinelFile } = buildClaudeCommandCanonical({
      id,
      task: params.task,
      model: effectiveModel ?? null,
      systemPrompt: agentDefs.body ?? null,
      cwd: targetCwdForSession ?? null,
    });
    const command = withDoneSentinelCanonical(claudeBase);

    const launchScriptName = `${slugifyName(params.name)}-${id}.sh`;
    const launchScriptFile = scriptPathForCanonical(artifactDir, launchScriptName);

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
  const cdPrefix = buildCdPrefixCanonical(targetCwdForSession);

  // Scrub the removed legacy wire: a user shell that still exports
  // PI_SUBAGENT_KEEP_TAB (dotfiles / old sessions) would otherwise leak it
  // into the child via shell inheritance. config.json stays the sole truth.
  const scrubPrefix = "unset PI_SUBAGENT_KEEP_TAB; ";
  const piCommand = scrubPrefix + cdPrefix + envPrefix + parts.join(" ");
  const command = withDoneSentinelCanonical(piCommand);
  const launchScriptName = `${slugifyName(params.name)}-${id}.sh`;
  const launchScriptFile = scriptPathForCanonical(artifactDir, launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    cwd: targetCwdForSession ?? null,
    scriptPreamble: scriptPreambleForCanonical("launch", {
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

function copyClaudeSession(sentinelFile: string): string | null {
  return copyClaudeSessionCanonical(sentinelFile);
}

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
    deliverPendingQuestion({ name, agent, sessionFile, startTime: Date.now() }, piInstance);
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

function deliverPendingQuestion(running: QuestionCarrier, piInstance?: ExtensionAPI | null): boolean {
  const askFile = `${running.sessionFile}.ask`;
  const claim = claimAskFile(askFile);
  if (!claim) return false;
  let payload: any = null;
  try {
    payload = JSON.parse(readFileSync(claim, "utf-8"));
  } catch {
    // Truly corrupt (writer is atomic since C3, so not a partial flush) —
    // drop the claim and move on.
    try {
      unlinkSync(claim);
    } catch {}
    return false;
  }
  if (!payload?.question) {
    try {
      unlinkSync(claim);
    } catch {}
    return false;
  }

  // Use the spawner's own pi instance (threaded from the spawn call site).
  // The module-global latestPi can point at a different session (multi-session
  // process, /reload) — results already use the closure pi, questions must too.
  // Envelope lives in notifications.ts (single sendMessage owner).
  const target = piInstance ?? latestPi;
  if (!target) {
    // No session to notify — restore the claim for retry.
    try {
      renameSync(claim, askFile);
    } catch {}
    return false;
  }

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);

  try {
    notifyQuestionCanonical(target as any, {
      name,
      agent: running.agent,
      sessionId,
      elapsedSec: elapsed,
      question: payload.question,
    });
  } catch {
    // Keep for retry: move the claim back so the next tick can re-claim it.
    try {
      renameSync(claim, askFile);
    } catch {}
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

      maybeCloseSurface(surface, running.keepSurface);
      runningSubagents.delete(running.id);

      return { name, task, summary, exitCode: result.exitCode, elapsed, surfaceKept: running.keepSurface === true, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
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

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    maybeCloseSurface(surface, running.keepSurface);
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
      else maybeCloseSurface(surface, running.keepSurface);
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
    refreshConfigCache();
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
            if (keptTabs.has(keptKey(artifactDir, regName))) continue;
            let alive = false;
            try {
              alive = existsSync(sf) && keptTabAlive(surf);
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
    let shuttingDir: string | null = null;
    try {
      const mgr = (_ctx as any)?.sessionManager;
      if (mgr?.getSessionDir && mgr?.getSessionId) {
        shuttingDir = getArtifactDir(mgr.getSessionDir(), mgr.getSessionId());
      }
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
        const freshAllowlist = getSubagentAllowlistFresh();
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
        registerName(parentArtifactDir, running.name, {
          sessionFile: running.sessionFile,
          sessionId: getSessionId(running.sessionFile),
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

            notifyResultCanonical(pi as any, {
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
          })
          .catch((err) => {
            updateWidget();
            notifyErrorCanonical(pi as any, running.name, running.task, err);
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

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct cosmetic name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
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

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
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

      renderCall(args, theme) {
        const target = args.name ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

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
        for (const r of runningSubagents.values()) {
          if (resolve(r.sessionFile) === resolve(sessionPath)) {
            const err = `Subagent "${requestedName}" is still running as "${r.name}". Your message will steer it; resending as a steer.`;
            releaseResume();
            return handleSubagentSteer({ name: r.name, message: params.message });
          }
        }

        // A kept tab is still ONE live pi process: steer the reply into it
        // (same safe path as steering a running subagent). Only refuse a
        // resume relaunch while the tab is alive — two pi processes must never
        // append to one .jsonl.
        if (entry.surface) {
          const kept = findKeptTab(parentArtifactDir, requestedName);
          if (kept) {
            const steer = steerSubagent(
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

        // Record entry count before resuming so we can extract new messages.
        // Count lines cheaply (no per-line JSON.parse) so resuming a large
        // transcript doesn't block the UI.
        const entryCountBefore = countSessionEntryLines(sessionPath);

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
          {
            let raced: RunningSubagent | null = null;
            for (const r of runningSubagents.values()) {
              try {
                if (resolve(r.sessionFile) === resolve(sessionPath)) { raced = r; break; }
              } catch { /* ignore unresolvable paths */ }
            }
            if (raced) {
              closeResumeSurface();
              releaseResume();
              return handleSubagentSteer({ name: raced.name, message: params.message });
            }
            if (entry.surface) {
              const racedKept = findKeptTab(parentArtifactDir, requestedName);
              if (racedKept) {
                const racedSteer = steerSubagent(
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
        const resumeCdPrefix = buildCdPrefixCanonical(resumeCwd);

        const command = withDoneSentinelCanonical(`unset PI_SUBAGENT_KEEP_TAB; ${resumeCdPrefix}${resumeEnvPrefix}${parts.join(" ")}`);
        const launchScriptFile = scriptPathForCanonical(
          artifactDir,
          `${slugifyName(name) || "resume"}-resume-${Date.now()}.sh`,
        );
          sendLongCommand(surface, command, {
            scriptPath: launchScriptFile,
            cwd: resumeCwd,
            scriptPreamble: scriptPreambleForCanonical("resume", {
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
            notifyResultCanonical(pi as any, {
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
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
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

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
