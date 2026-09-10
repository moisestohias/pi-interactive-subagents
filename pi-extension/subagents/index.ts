/**
 * index.ts — thin extension wiring (P1 completion).
 *
 * Registration only: `registerTool`×3, `registerCommand`, three
 * `registerMessageRenderer`s, and `session_start`/`shutdown` delegation to
 * `lifecycle.ts`. All policy lives in its home module:
 *
 * - tool executes → `handlers/` (`spawn.ts`, `message.ts`, `list.ts`),
 *   pure gates → `handlers/validators.ts`
 * - run/kept/watch orchestration → `lifecycle.ts`
 * - process-global keys → `runtime.ts`
 * - presentation → `renderers.ts`, summaries → `results.ts`
 * - sidecar primitives → `session/sidecars.ts`
 *
 * Fire-and-forget throughout — never add polling loops, sleep-waits, or
 * log-tailing to "check" on a subagent; the harness delivers results.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { slugifyName } from "./names.ts";
import { borderLine } from "./widget.ts";
import { getShellReadyDelayMs } from "./lifecycle.ts";
import {
  shouldKeepSurface,
  shouldKeepSurfaceFor,
  shouldKeepForAgent,
  resolveKeepDecision,
} from "./keep.ts";
import { renderRunningWidgetLines } from "./lifecycle.ts";
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
import {
  formatElapsed,
  formatTokens,
  contextWindowFor,
  formatContextUsage,
  formatUsageSegments,
} from "./format.ts";
import {
  widgetIcon,
  formatWidgetRightLabel,
} from "./widget.ts";
import {
  DEFAULT_SUBAGENT_TOOLS,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  buildCdPrefix,
  buildEnvPrefix,
  scriptPreambleFor,
} from "./launch.ts";
import { resolveResultPresentation } from "./notifications.ts";
import { observeRunningSubagent } from "./status-bridge.ts";
import {
  resolveRunningByName,
  uniqueRunningName,
  reservedNames,
  subagentStore,
  deliverPendingQuestion,
  recoverPendingQuestions,
  findKeptTab,
  keptTabs,
  runningSubagents,
  shouldNotifyResult,
  restoreAskClaimNoClobber,
  decideResurrectAction,
  sessionCtxs,
  startWidgetRefresh,
  startStatusRefresh,
  timersActiveForTest,
  handleSessionStart,
  handleSessionShutdown,
  setLatestPi,
} from "./lifecycle.ts";
import { keptKey } from "./store.ts";
import {
  steerSubagent,
  steerSubagentAsync,
  handleSubagentSteer,
  resolveResumeLaunchBehavior,
  executeMessage,
  SubagentMessageParams,
} from "./handlers/message.ts";
import { executeSpawn, SubagentParams } from "./handlers/spawn.ts";
import { executeList, handleSubagentCommand } from "./handlers/list.ts";
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

// ── Agents (canonical in agents.ts). Re-exported here for compat. ──
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

type SubagentSessionMode = SubagentSessionModeT;
type AgentSource = AgentSourceT;
type AgentDefaults = AgentDefaultsT;
type AgentDefinition = AgentDefinitionT;
type ListedAgentDefinition = ListedAgentDefinitionT;

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

export default function subagentsExtension(pi: ExtensionAPI) {
  setLatestPi(pi);
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    handleSessionStart(pi, ctx);
  });

  // Clean up on session shutdown (M1: scoped per-session — never abort the
  // process-global poll controller here; it is reserved for /reload rotation
  // at import. See lifecycle.ts:teardownSession.)
  pi.on("session_shutdown", (_event, _ctx) => {
    handleSessionShutdown(_ctx);
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
        return executeSpawn(pi, params, ctx as any);
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
        return executeList();
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
      parameters: SubagentMessageParams,

      // P3: presentation lives in renderers.ts.
      renderCall: renderSubagentMessageToolCall,

      // P3: presentation lives in renderers.ts.
      renderResult: renderSubagentMessageToolResult,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return executeMessage(pi, params, ctx as any);
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      return handleSubagentCommand(pi, args, ctx as any);
    },
  });

  // P3/T6: presentation lives in renderers.ts (details.summary first, stripping-fallback for old messages).
  pi.registerMessageRenderer("subagent_result", renderSubagentResultMessage);

  pi.registerMessageRenderer("subagent_status", renderSubagentStatusMessage);

  pi.registerMessageRenderer("subagent_question", renderSubagentQuestionMessage);


}
// test
