/**
 * kitty surface layer — subagents run in kitty tabs.
 *
 * Everything the extension does to a terminal goes through the small API in
 * this file: open a tab, type a command into it, read its screen, close it,
 * and poll for exit. `Surface` is the canonical name for the handle (a kitty
 * window id); historical `mux` aliases are kept for compat.
 *
 * Tabs are identified by kitty window ids (e.g. `18`) — each subagent tab
 * holds a single window, so the window id is a stable handle for `--match`.
 * Addressing is ALWAYS by explicit numeric `id:` match: no command in this
 * file ever targets the active/default window, so outbound traffic can never
 * land in the main session's input area.
 *
 * Requires kitty remote control (`allow_remote_control yes` in kitty.conf;
 * a `listen_on` socket for processes without a controlling tty).
 * See KITTY-TABS-ANALYSIS.md for the full signaling-flow analysis.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { takeSidecar, interpretExitPayload } from "./session/sidecars.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  const cached = commandAvailability.get(command);
  if (cached === true) return true;
  // N2: pass the name as a positional arg (no interpolation into `sh -c`),
  // and only cache positive results so installing kitty later is picked up
  // without restarting pi.
  try {
    execFileSync("sh", ["-c", "command -v -- \"$1\"", "sh", command], { stdio: "ignore" });
    commandAvailability.set(command, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when kitty remote control is reachable over a listen socket.
 *
 * The socket (`KITTY_LISTEN_ON`, from `listen_on` in kitty.conf) is REQUIRED —
 * tty-route control is deliberately not accepted. Without a socket every
 * `kitty @` call talks over the main session's own terminal: kitty delivers
 * command responses as input bytes on that same tty, so pi's TUI and the CLI
 * steal each other's bytes. In practice that means worker screen text
 * (from the 1s `get-text` poll) leaks into the main session's input box and
 * the main session becomes unusably slow. The socket keeps all control
 * traffic off the terminal entirely.
 */
export function isKittyAvailable(): boolean {
  return !!process.env.KITTY_LISTEN_ON && hasCommand("kitty");
}

export function isMuxAvailable(): boolean {
  return isKittyAvailable();
}

/** @deprecated Use isKittyAvailable (kept for compat). */
export const isSurfaceAvailable = isKittyAvailable;

export function kittySetupHint(): string {
  return (
    "Subagents need kitty remote control over a socket (required — tty control corrupts the main session). " +
    "Add to kitty.conf: `allow_remote_control yes` and `listen_on unix:/tmp/kitty-$USER`, then restart kitty."
  );
}

/** @deprecated Use kittySetupHint (kept for compat). */
export function muxSetupHint(): string {
  return kittySetupHint();
}

function requireKitty(): void {
  if (!isKittyAvailable()) {
    throw new Error(`kitty tabs are required for subagents. ${kittySetupHint()}`);
  }
}

// ── Remote-control invocation ──

/**
 * Run `kitty @ …` over the listen socket (`--to`), keeping all control
 * traffic off the main session's terminal (see isKittyAvailable).
 * Password auth (if the user hardened remote control) is picked up
 * automatically from KITTY_RC_PASSWORD / rc-pass — no flags needed.
 * Failures carry the setup hint so a dead/misconfigured socket is actionable.
 */
function kittenSync(args: string[], input?: string): string {
  const toArgs = process.env.KITTY_LISTEN_ON ? ["--to", process.env.KITTY_LISTEN_ON] : [];
  try {
    return execFileSync("kitty", ["@", ...toArgs, ...args], {
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
    });
  } catch (error: any) {
    throw new Error(`${error?.message ?? String(error)} ${kittySetupHint()}`);
  }
}

async function kittenAsync(args: string[], input?: string): Promise<string> {
  const toArgs = process.env.KITTY_LISTEN_ON ? ["--to", process.env.KITTY_LISTEN_ON] : [];
  try {
    const { stdout } = await execFileAsync("kitty", ["@", ...toArgs, ...args], {
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
    });
    return stdout;
  } catch (error: any) {
    throw new Error(`${error?.message ?? String(error)} ${kittySetupHint()}`);
  }
}

/**
 * Guard the `--match id:` selector: only plain numeric window ids are
 * accepted, so a surface handle can never smuggle match syntax (regex,
 * boolean operators) into a command that would then address the wrong window.
 */
function matchFor(surface: string): string {
  if (!/^\d+$/.test(surface)) {
    throw new Error(`Invalid kitty surface id: ${JSON.stringify(surface)}`);
  }
  return `id:${surface}`;
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Surface primitives ──

/**
 * Open a new tab for a subagent and return its window id (e.g. `18`).
 * `--dont-take-focus` keeps keyboard focus in the main session, so tab
 * creation never interrupts the orchestrator. The tab starts a plain shell;
 * the caller types the launch script via sendCommand, exactly like before.
 */
export function createSurface(name: string): string {
  requireKitty();

  const args = ["launch", "--type=tab", "--dont-take-focus"];
  const title = name?.trim();
  if (title) {
    args.push("--tab-title", title);
  }

  let out: string;
  try {
    out = kittenSync(args);
  } catch (error: any) {
    throw new Error(`Failed to open kitty tab for subagent: ${error?.message ?? String(error)}`);
  }
  const id = out.trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`Unexpected kitty launch output: ${id}`);
  }
  return id;
}

/**
 * @deprecated Splits are not used (tabs-first). Use createSurface.
 * Kept for API compatibility; direction/fromSurface are ignored.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void direction;
  void fromSurface;
  return createSurface(name);
}

/**
 * True when a window with this id still exists (parsed from `kitty @ ls`:
 * OS windows → tabs → windows). Used to turn kitty's silent send success
 * into an honest error: steering a closed tab reports failure instead of
 * pretending the message was delivered.
 */
/**
 * True when a window with this id still exists. Returns null when the
 * control plane itself failed (dead socket, corrupt `ls` JSON) — callers
 * must NOT treat that as "tab gone" (N3): pruning or reporting death on a
 * socket hiccup loses live sessions.
 */
export function windowExistsOrNull(surface: string): boolean | null {
  if (!/^\d+$/.test(surface)) return false;
  try {
    const out = kittenSync(["ls"]);
    const osWindows = JSON.parse(out);
    if (!Array.isArray(osWindows)) return null;
    for (const osWindow of osWindows) {
      const tabs = (osWindow as any)?.tabs;
      if (!Array.isArray(tabs)) continue;
      for (const tab of tabs) {
        const windows = (tab as any)?.windows;
        if (!Array.isArray(windows)) continue;
        for (const window of windows) {
          if (String((window as any)?.id) === surface) return true;
        }
      }
    }
    return false;
  } catch {
    return null;
  }
}

export function windowExists(surface: string): boolean {
  // Legacy boolean wrapper: control-plane failure reads as false.
  // Prefer windowExistsOrNull in prune paths (kept-tab GC must not prune on
  // a socket hiccup).
  return windowExistsOrNull(surface) === true;
}

/**
 * Send a command string to a subagent tab and execute it.
 * Text travels via `--stdin` (no argv escaping issues) addressed to the
 * tab's window id only — never the active window — then submitted with Enter.
 * Throws when the tab is gone, so callers surface delivery failure instead of
 * silently dropping the message.
 */
/**
 * Shared liveness pre-check for the send pair (M11 single-home): both
 * `sendCommand` and `sendCommandAsync` fail closed identically — positively
 * gone throws an honest error, control-plane unknown throws a retryable
 * one (N4: advisory only, TOCTOU — the tab can die between check and send).
 */
function assertSurfaceAlive(surface: string): void {
  const alive = windowExistsOrNull(surface);
  if (alive === false) {
    throw new Error(`No such subagent tab (window id ${surface}) — it may have been closed.`);
  }
  if (alive === null) {
    throw new Error(
      `Kitty control plane unreachable while sending to tab ${surface} (socket hiccup?) — retry; the tab may still be alive.`,
    );
  }
}

export function sendCommand(surface: string, command: string): void {
  requireKitty();
  const match = matchFor(surface);
  assertSurfaceAlive(surface);
  kittenSync(["send-text", "--match", match, "--stdin"], command);
  kittenSync(["send-key", "--match", match, "enter"]);
}

/**
 * Async `sendCommand` (M11): same pre-checks and errors, but the three
 * control-plane round-trips yield to the event loop instead of blocking the
 * extension host. Adopted on the steer + completion paths; startup and
 * tests keep the sync version (deterministic, no sleep injection).
 */
export async function sendCommandAsync(surface: string, command: string): Promise<void> {
  requireKitty();
  const match = matchFor(surface);
  // Same shared pre-check as the sync version (TOCTOU, see N4).
  assertSurfaceAlive(surface);
  await kittenAsync(["send-text", "--match", match, "--stdin"], command);
  await kittenAsync(["send-key", "--match", match, "enter"]);
}

/**
 * Send a long command to a tab by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * tab width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
/**
 * Sink-side preamble guard (C1). Every preamble line must remain a `# …`
 * comment once written to the `bash`-executed script file: an interpolated
 * value carrying `\\n` (e.g. the inline Claude preamble, which bypasses
 * `scriptPreambleFor`) would otherwise escape the comment and execute.
 * Lines that are not comments are neutralized with a `# ` prefix so the
 * script stays syntactically inert. Exported for tests.
 */
export function sanitizeScriptPreamble(preamble: string): string {
  return preamble
    .split("\n")
    .map((line) => line.replace(/\r/g, ""))
    .map((line) => (line.trim() === "" || line.startsWith("#") ? line : `# ${line}`))
    .join("\n");
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; cwd?: string | null },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(sanitizeScriptPreamble(options.scriptPreamble).trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  // Start the script from the subagent cwd so the `bash` process itself (and
  // hence pi) inherits the parent session dir even before the script's inner
  // `cd ... &&` runs (fresh kitty tabs start in `~`).
  const invoke = `bash ${shellEscape(scriptPath)}`;
  const outer = options?.cwd ? `cd ${shellEscape(options.cwd)} && ${invoke}` : invoke;
  sendCommand(surface, outer);
  return scriptPath;
}

/**
 * Pick the cheapest `get-text` extent that still covers `lines` of history:
 * the visible screen for small reads (e.g. the 1s sentinel poll), full
 * screen+scrollback only for deep reads (e.g. the 200-line fallback).
 */
function extentFor(lines: number): string {
  return lines > 100 ? "all" : "screen";
}

/**
 * Read the last `lines` of a tab's output (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireKitty();
  const match = matchFor(surface);
  const out = kittenSync(["get-text", "--match", match, "--extent", extentFor(lines)]);
  return out.split("\n").slice(-Math.max(1, lines)).join("\n");
}

/**
 * Read the last `lines` of a tab's output (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireKitty();
  const match = matchFor(surface);
  const out = await kittenAsync(["get-text", "--match", match, "--extent", extentFor(lines)]);
  return out.split("\n").slice(-Math.max(1, lines)).join("\n");
}

/**
 * Close a subagent tab (via its window — each subagent tab holds exactly one
 * window, so the tab goes away with it).
 */
export function closeSurface(surface: string): void {
  requireKitty();
  const match = matchFor(surface);
  kittenSync(["close-window", "--match", match]);
}

/** Async `closeSurface` (M11): adopted on completion paths. */
export async function closeSurfaceAsync(surface: string): Promise<void> {
  requireKitty();
  const match = matchFor(surface);
  await kittenAsync(["close-window", "--match", match]);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
  /**
   * True when the error is specifically tab death (H1 liveness probe): the
   * window is positively gone with no sidecar. Lets the kept-tab monitor
   * tell "closed after its first result" (silent) from a real agent-loop
   * error (reported). Unset on all other results.
   */
  tabClosed?: boolean;
}

/**
 * Decode an `.exit` sidecar payload for the poll loop. Thin delegation to
 * the single home (`session/sidecars.ts:interpretExitPayload`, rule 1) —
 * kept under this name only because `__pollForExitTest__` (and
 * `test/test.ts` through it) pins the key. Maps the shared result onto
 * `PollResult` (`tabClosed` is set by the H1 liveness probe, never here).
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  const decoded = interpretExitPayload(data);
  return { reason: decoded.reason, exitCode: decoded.exitCode, ...(decoded.errorMessage ? { errorMessage: decoded.errorMessage } : {}) };
}

/**
 * Corrupt-drop observability (Missing #4). Every "drop as corrupt" path
 * across the sidecar protocol logs here with a stable prefix AND bumps a
 * per-kind counter, so torn-signal bugs are debuggable in the field instead
 * of vanishing silently. Counts are exposed to tests via
 * `corruptDropCountsForTest`; production can read them the same way.
 */
const corruptDropCounts = new Map<string, number>();

export function logCorruptDrop(kind: string, path: string, reason: string): void {
  try {
    corruptDropCounts.set(kind, (corruptDropCounts.get(kind) ?? 0) + 1);
  } catch {}
  try {
    console.error(`[pi-subagents corrupt-drop] kind=${kind} path=${path} reason=${reason}`);
  } catch {}
}

/** Test seam (Missing #4): snapshot of corrupt-drop counters. */
export function corruptDropCountsForTest(): Record<string, number> {
  return Object.fromEntries(corruptDropCounts.entries());
}

/**
 * Consume a completion sidecar next to the session file, if present.
 * `.exit` (error) wins over `.done` (clean finish on a keep-open run:
 * config `tabs.keepOpen=true` + agent `auto-exit:false`, session left open).
 * Returns null when neither exists. Files are claimed via rename and deleted
 * on read so each signal fires once, even with concurrent consumers (M1).
 * Single home: `session/sidecars.ts:takeSidecar` (T8) — this wrapper only
 * injects the corrupt-drop observer (Missing #4). N5 + M9 policies live there.
 */
function takeCompletionSidecar(sessionFile: string, opts?: { ignoreDone?: boolean }): PollResult | null {
  const taken = takeSidecar(sessionFile, { ...opts, onCorrupt: logCorruptDrop });
  if (!taken) return null;
  return { reason: taken.reason, exitCode: taken.exitCode, ...(taken.errorMessage ? { errorMessage: taken.errorMessage } : {}) };
}

export const __pollForExitTest__ = { interpretExitSidecar, takeCompletionSidecar, corruptDropCountsForTest };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 *
 * H1: a dead tab is detected via the injected `exists` probe (defaults to
 * `windowExistsOrNull`). After `maxReadFailuresBeforeLivenessProbe`
 * consecutive `get-text` failures the tab is probed: `false` (positively
 * gone) returns an error result instead of hanging forever; `null`
 * (control-plane unknown, N3) keeps polling. Callers (`watchSubagent`,
 * `monitorKeptTab`) both benefit without changes.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    exists?: (surface: string) => boolean | null;
    maxReadFailuresBeforeLivenessProbe?: number;
    /**
     * M9: watch `.exit`/sentinel only (leave `.done` files alone). Used by
     * the kept-tab monitor after the first result was delivered.
     */
    ignoreDone?: boolean;
  },
): Promise<PollResult> {
  const start = Date.now();
  const exists = options.exists ?? windowExistsOrNull;
  const probeAfter = options.maxReadFailuresBeforeLivenessProbe ?? 3;
  let readFailures = 0;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: completion sidecars (.exit error / .done clean-but-open).
    if (options.sessionFile) {
      const sidecar = takeCompletionSidecar(options.sessionFile, { ignoreDone: options.ignoreDone });
      if (sidecar) return sidecar;
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      readFailures = 0;
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      readFailures += 1;
      // Surface may have been destroyed — check if a sidecar appeared in the meantime
      if (options.sessionFile) {
        const sidecar = takeCompletionSidecar(options.sessionFile, { ignoreDone: options.ignoreDone });
        if (sidecar) return sidecar;
      }
      // H1: sustained get-text failure with no sidecar means the tab is
      // likely gone (its `; echo DONE` died with the shell). Probe liveness
      // instead of polling forever and leaking the run.
      if (readFailures >= probeAfter) {
        let alive: boolean | null;
        try {
          alive = exists(surface);
        } catch {
          alive = null;
        }
        if (alive === false) {
          return {
            reason: "error",
            exitCode: 1,
            errorMessage: `Subagent tab closed (window id ${surface}) before completion; no result was produced.`,
            tabClosed: true,
          };
        }
        // `null` (control-plane unknown, N3) or `true`: keep polling, but
        // re-arm so a later death is still detected without a hot `ls` loop.
        readFailures = 0;
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
