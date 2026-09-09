/**
 * Claude CLI backend (R11). Owns everything specific to `cli: "claude"`
 * agents: command parts, sentinel/transcript handling.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { shellEscape } from "../kitty.ts";
import { getSubagentsDir } from "../paths.ts";

export const CLAUDE_SESSIONS_DIR = join(
  // N16: os.homedir() (consistent with agents.ts:getAgentConfigDir); HOME can
  // be unset in launched contexts where homedir() still resolves.
  (() => {
    try {
      return homedir();
    } catch {
      return process.env.HOME ?? "/tmp";
    }
  })(),
  ".pi",
  "agent",
  "sessions",
  "claude-code",
);

export interface ClaudeLaunchOpts {
  id: string;
  task: string;
  model?: string | null;
  systemPrompt?: string | null;
  cwd?: string | null;
  name?: string;
}

/** Build the full shell command (without the DONE sentinel). */
export function buildClaudeCommand(opts: ClaudeLaunchOpts): { command: string; sentinelFile: string } {
  const sentinelFile = `/tmp/pi-claude-${opts.id}-done`;
  const pluginDir = join(getSubagentsDir(), "plugin");

  const cmdParts: string[] = [];
  cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
  cmdParts.push("claude");
  cmdParts.push("--dangerously-skip-permissions");

  if (existsSync(pluginDir)) {
    cmdParts.push("--plugin-dir", shellEscape(pluginDir));
  }
  if (opts.model) {
    cmdParts.push("--model", shellEscape(opts.model));
  }
  if (opts.systemPrompt) {
    cmdParts.push("--append-system-prompt", shellEscape(opts.systemPrompt));
  }
  cmdParts.push(shellEscape(opts.task));

  const cdPrefix = opts.cwd ? `cd ${shellEscape(opts.cwd)} && ` : "";
  return { command: `${cdPrefix}${cmdParts.join(" ")}`, sentinelFile };
}

/** Copy a Claude transcript into the sessions dir. Returns filename or null. */
export function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

export function cleanupClaudeSentinel(sentinelFile: string): void {
  try {
    unlinkSync(sentinelFile);
  } catch {}
  try {
    unlinkSync(sentinelFile + ".transcript");
  } catch {}
}
