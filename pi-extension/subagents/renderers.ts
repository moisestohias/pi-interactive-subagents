/**
 * Message + tool presentation (P3/T6). Single home for the three
 * `registerMessageRenderer` callbacks (`subagent_result`, `subagent_status`,
 * `subagent_question`) plus the tool `renderCall`/`renderResult` closures.
 *
 * Depends only on notifications (content/summary), format (numbers), and the
 * framework theme/Box primitives — never on store/kitty (no liveness, no
 * terminal IO). Content stays in `notifications.ts`; this file owns layout.
 */
import { Box, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { keyHint } from "@mariozechner/pi-coding-agent";
import {
  contextWindowFor,
  formatContextUsage,
  formatElapsed,
  formatUsageSegments,
} from "./format.ts";
import { summaryForDisplay } from "./notifications.ts";
import type { SessionStats } from "./session.ts";

// ── `subagent` tool ─────────────────────────────────────────────────────────

export function renderSubagentToolCall(args: any, theme: any) {
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
}

export function renderSubagentToolResult(result: any, _opts: any, theme: any) {
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
}

// ── `subagents_list` tool ───────────────────────────────────────────────────

export function renderSubagentsListToolResult(result: any, _opts: any, theme: any) {
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
}

// ── `subagent_message` tool ─────────────────────────────────────────────────

export function renderSubagentMessageToolCall(args: any, theme: any) {
  const target = args.name ?? "(unknown)";
  return new Text(
    "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
    0,
    0,
  );
}

export function renderSubagentMessageToolResult(result: any, _opts: any, theme: any) {
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
}

// ── `subagent_result` message ───────────────────────────────────────────────
// T6: renders from structured `details.summary` (added to `notifyResult`);
// the prose-stripping path survives only for old persisted messages that
// predate the field (see `summaryForDisplay`).

export function renderSubagentResultMessage(message: any, options: any, theme: any) {
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

      // T6: structured summary first, stripping-fallback for old messages.
      const summary = summaryForDisplay(details, rawContent);

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
}

// ── `subagent_status` message ───────────────────────────────────────────────

export function renderSubagentStatusMessage(message: any, options: any, theme: any) {
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
}

// ── `subagent_question` message ─────────────────────────────────────────────

export function renderSubagentQuestionMessage(message: any, options: any, theme: any) {
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
}
