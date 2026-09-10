/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Exit/keep precedence (sole truth: config.json `tabs.keepOpen` × agent.md `auto-exit`):
 *   keepOpen=false + auto-exit=*     → EXIT (session + tab close; global takes precedence)
 *   keepOpen=true  + auto-exit=true  → EXIT (session + tab close)
 *   keepOpen=true  + auto-exit=false → KEEP (session stays interactive, `.done` once, tab left open)
 *
 * The parent encodes this into `PI_SUBAGENT_AUTO_EXIT` (effective exit flag).
 * This child only reads that flag — the legacy `PI_SUBAGENT_KEEP_TAB` wire is
 * removed: it is scrubbed from the launch command, deleted here if inherited
 * from an old shell, and never consulted. Only config.json (via the parent)
 * decides keep-open.
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their agent loop ends (see the `agent_end` handler);
 * kept-open sessions stay interactive after finishing and signal completion
 * once via `.done`.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingAnswer`), and the parent
 * replies with subagent_message — which lands as the subagent's next turn.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { renameSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import {
  shouldMarkUserTookOver as shouldMarkUserTookOverFn,
  runningChildrenCount as runningChildrenCountFn,
  shouldAutoExitOnAgentEnd as shouldAutoExitOnAgentEndFn,
  findLatestAssistantError as findLatestAssistantErrorFn,
  parseDeniedTools as parseDeniedToolsFn,
} from "./subagent-done-pure.ts";

export {
  shouldMarkUserTookOver,
  runningChildrenCount,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  parseDeniedTools,
} from "./subagent-done-pure.ts";
export type { SubagentErrorInfo } from "./subagent-done-pure.ts";

/**
 * Atomic JSON sidecar write (C3/H3): tmp file + rename so parent polls never
 * observe a partway-flushed payload. The parent's rename-claim would
 * otherwise grab a truncated file, fail JSON.parse, and delete a real
 * signal as "corrupt" while the child's remaining bytes go to the renamed
 * inode (lost). Used for `.ask`, `.exit`, and `.done` alike.
 */
function writeSidecarJsonAtomic(target: string, data: unknown): void {
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(data), "utf8");
  renameSync(tmp, target);
}

/**
 * Atomic `.ask` signal write (C3): tmp file + rename so parent polls never
 * observe a partway-flushed payload. Exported for tests.
 */
export function writeAskSignalAtomic(sessionFile: string, data: unknown): void {
  writeSidecarJsonAtomic(`${sessionFile}.ask`, data);
}

/**
 * Atomic completion-signal write (H3): `.exit` (error) or `.done` (keep-open
 * clean finish). Same tmp+rename protocol as `.ask`. Exported for tests.
 */
export function writeCompletionSidecarAtomic(
  sessionFile: string,
  kind: "exit" | "done",
  data: unknown,
): void {
  writeSidecarJsonAtomic(`${sessionFile}.${kind}`, data);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Legacy wire cleanup: PI_SUBAGENT_KEEP_TAB is removed. If an old shell,
  // dotfile, or parent still exports it, drop it — only config.json (encoded
  // by the parent into PI_SUBAGENT_AUTO_EXIT) is truth.
  if ("PI_SUBAGENT_KEEP_TAB" in process.env) {
    delete process.env.PI_SUBAGENT_KEEP_TAB;
  }
  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  // Effective exit flag from the parent: true ⇔ should close (session + tab).
  // Parent computes: exit ⇔ (!tabs.keepOpen || agent auto-exit).
  // False ⇔ keep-open run (tabs.keepOpen=true + auto-exit=false): stay
  // interactive after finishing and report the first clean finish once via
  // a `.done` sidecar so the parent is still notified. Errors use the same
  // `.exit` sidecar as the auto-exit path.
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  let completionSignaled = false;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Set when ask_question is called; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Cleared when the reply
  // lands — on `input` (covers a reply steered into the current run) and on
  // `agent_start` (covers a reply that starts a fresh turn after parking).
  let awaitingAnswer = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedToolsFn(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_end would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOverFn(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    // A new turn is starting — any pending ask_question has now been answered
    // (or superseded), so let auto-exit resume normally when this turn ends.
    awaitingAnswer = false;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    // Never shut down while this session still has work in flight:
    //  - awaitingAnswer: an ask_question is pending the orchestrator's reply.
    //  - runningChildrenCount(): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCountFn() > 0;
    const finishedTurn =
      !awaitingAnswer &&
      !hasPendingChildren &&
      shouldAutoExitOnAgentEndFn(userTookOver, messages);
    const shouldExit = finishedTurn && autoExit;

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      const errorInfo = findLatestAssistantErrorFn(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeCompletionSidecarAtomic(sessionFile, "exit", {
            type: "error",
            errorMessage: errorInfo.errorMessage,
            stopReason: errorInfo.stopReason,
          });
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    // Keep-open run (!autoExit ⇔ keepOpen=true + auto-exit=false): stay open and
    // tell the parent this turn finished (once — later manual turns belong to
    // whoever drives the tab now).
    if (!autoExit && finishedTurn && !completionSignaled) {
      completionSignaled = true;
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      const errorInfo = findLatestAssistantErrorFn(messages);
      if (sessionFile) {
        try {
          if (errorInfo) {
            writeCompletionSidecarAtomic(sessionFile, "exit", {
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            });
          } else {
            writeCompletionSidecarAtomic(sessionFile, "done", { type: "done" });
          }
        } catch {
          // Best effort — the watcher falls back to the session file.
        }
      }
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      "Your session stays open while you wait — the answer arrives as your next message, then you continue. " +
      "Ask exactly one question per call; make separate calls for unrelated questions.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "After asking, stop and wait — the reply will arrive as your next message.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // Keep the session open: suppress auto-exit for this turn and park in the
      // "waiting" phase. The parent's watcher picks up the `.ask` signal and
      // notifies the orchestrator, who replies via subagent_message.
      awaitingAnswer = true;
      recorder.askQuestion();
      const askData = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      // Atomic write (C3): tmp + rename so a 1s parent poll never reads a
      // partway-flushed `.ask` and deletes it as "malformed".
      writeAskSignalAtomic(sessionFile, askData);

      return {
        content: [
          {
            type: "text",
            text:
              "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

}
