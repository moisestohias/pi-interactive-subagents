/**
 * Claude CLI backend (R11). Owns everything specific to `cli: "claude"`
 * agents: command parts, sentinel/transcript handling.
 */
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, fchmodSync } from "node:fs";
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

/**
 * Pre-create the sentinel file with owner-only permissions (L8). The name
 * is predictable in world-writable `/tmp` (~32 bits of entropy), so the
 * file must already exist mode `0600` before the tab starts: the hook's
 * `> sentinel` redirect then preserves those permissions instead of
 * creating a fresh default-mode file. Framing note: the threat here is
 * same-user (the child already runs as the user with bash), so the real
 * exposure this closes is transcript spoofing via a pre-planted sentinel
 * path, not cross-user snooping. Best-effort: never throws (launch must
 * not fail on a /tmp hiccup).
 */
export function createClaudeSentinelFile(sentinelFile: string): void {
  try {
    let fd: number;
    try {
      fd = openSync(sentinelFile, "wx", 0o600);
      closeSync(fd);
    } catch {
      // Already exists (retry/reload) — tighten in place instead.
      try {
        fd = openSync(sentinelFile, "r");
        try {
          fchmodSync(fd, 0o600);
        } finally {
          closeSync(fd);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Directories a Claude transcript is allowed to be copied from (L8).
 * `copyClaudeSession` copies whatever path the sentinel names, so it must
 * refuse paths outside the known Claude transcript locations — otherwise a
 * compromised/tampered sentinel turns the copy into an arbitrary-file read
 * into the sessions dir.
 */
export function claudeTranscriptAllowlist(): string[] {
  let home: string;
  try {
    home = homedir();
  } catch {
    home = process.env.HOME ?? "/tmp";
  }
  return [join(home, ".claude", "projects")];
}

function isTranscriptPathAllowed(transcriptPath: string): boolean {
  const resolved = resolve(transcriptPath);
  return claudeTranscriptAllowlist().some((dir) => resolved === resolve(dir) || resolved.startsWith(resolve(dir) + "/"));
}

/** Copy a Claude transcript into the sessions dir. Returns filename or null. */
export function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    // L8: allowlist — refuse to copy from outside known transcript dirs.
    if (!isTranscriptPathAllowed(transcriptPath)) {
      logClaudeDrop(sentinelFile, transcriptPath);
      return null;
    }
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

function logClaudeDrop(sentinelFile: string, transcriptPath: string): void {
  try {
    console.error(
      `[pi-subagents claude] refused transcript copy outside allowlist (sentinel=${sentinelFile} path=${transcriptPath})`,
    );
  } catch {}
}

export function cleanupClaudeSentinel(sentinelFile: string): void {
  try {
    unlinkSync(sentinelFile);
  } catch {}
  try {
    unlinkSync(sentinelFile + ".transcript");
  } catch {}
}
