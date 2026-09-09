/**
 * Steer notification fan-out (R5). Sole owners of the
 * `sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` envelope.
 * Callers pass data only — envelope + customType live here.
 */
import { formatElapsed } from "./format.ts";
import type { SessionStats } from "./session.ts";

export interface MinimalPi {
  sendMessage(
    msg: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
    opts: { triggerTurn: boolean; deliverAs: string },
  ): void;
}

export interface SubagentResultLike {
  name: string;
  task?: string;
  agent?: string;
  summary: string;
  sessionFile?: string;
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  errorMessage?: string;
  stats?: SessionStats;
  surfaceKept?: boolean;
}

export function resolveResultPresentation(
  result: Pick<SubagentResultLike, "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage">,
  name: string,
): string {
  const sessionRef = `\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;

  if (result.errorMessage) {
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

export function keptTabSuffix(surfaceKept?: boolean): string {
  return surfaceKept ? "\n\n(Kitty tab left open — close it yourself when done.)" : "";
}

export function notifyResult(pi: MinimalPi, result: SubagentResultLike): void {
  const presentation = resolveResultPresentation(result, result.name) + keptTabSuffix(result.surfaceKept);
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: presentation,
      display: true,
      details: {
        name: result.name,
        task: result.task,
        agent: result.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
        ...(result.stats ? { stats: result.stats } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

export function notifyError(pi: MinimalPi, name: string, task: string, error: unknown): void {
  const message = (error as any)?.message ?? String(error);
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: `Sub-agent "${name}" error: ${message}`,
      display: true,
      details: { name, task, error: message },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

export function notifyKeptTabError(pi: MinimalPi, name: string, errorMessage: string): void {
  pi.sendMessage(
    {
      customType: "subagent_result",
      content:
        `Sub-agent "${name}" failed in its kept tab ` +
        `(provider/agent error — auto-retry exhausted).\n\nError: ${errorMessage}`,
      display: true,
      details: { name, errorMessage },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

export function notifyQuestion(
  pi: MinimalPi,
  opts: { name: string; agent?: string; sessionId?: string | null; elapsedSec: number; question: string },
): void {
  const replyHint = `\n\nReply with subagent_message({ name: "${opts.name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;
  pi.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${opts.name}" asks (${formatElapsed(opts.elapsedSec)}):\n\n${opts.question}${replyHint}`,
      display: true,
      details: {
        name: opts.name,
        agent: opts.agent,
        question: opts.question,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

export function notifyStatus(
  pi: MinimalPi,
  opts: { content: string; visibleLines: string[]; overflow: number },
): void {
  pi.sendMessage(
    {
      customType: "subagent_status",
      content: opts.content,
      display: true,
      details: { lines: opts.visibleLines, overflow: opts.overflow },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}
