/**
 * Safe bash extension for subagents. Best-effort guardrail, NOT a sandbox.
 *
 * Loaded into a child pi process via `--extension` ONLY when an agent's
 * `tools` frontmatter literally lists `safe_bash` (see getToolExtensionPath).
 * The default baseline grants pi's native `bash` unwrapped — listing `bash`
 * does not give you this wrapper. Do not present safe_bash as enforced unless
 * the agent definition lists it.
 *
 * Blocking is regex-based over the raw command string: it catches the common
 * accidents but is bypassable by a determined actor (`python3 -c '…'`,
 * novel flag spellings, etc.). Never rely on it as a security boundary.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DANGEROUS_PATTERNS = [
	/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
	// rm with end-of-flags or parent traversal reaching root
	/\brm\b[^;|&`$]*--\s+\//,
	/\brm\b[^;|&`$]*\/tmp\/\.\.\//,
	/\bsudo\b/,
	// sudo via env prefix
	/\benv\b[^;|&`$]*\bsudo\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
	/>\s*\/dev\/[sh]d[a-z]/,
	/\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
	// L1 dispositions (pinned, intentional overblocks — the wrapper favors
	// false positives on footguns over misses; narrow only with a test):
	// `chmod 777 /tmp/x` matches the pattern above even though /tmp is
	// world-writable by design; read-only `dd if=…` matches `dd\s+if=`
	// below even for pure reads. Both stay blocked.
	/\bchown\s+(-[a-zA-Z]+\s+)?root/,
	/\bcurl\s.*\|\s*(ba)?sh/,
	/\bwget\s.*\|\s*(ba)?sh/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\binit\s+0\b/,
	/\bkill\s+-9\s+1\b/,
	/\bkillall\b/,
];

/** Verbs that must not appear inside $() / `` / ${} expansions. */
const BLOCKED_IN_SUBSTITUTION = [
	/\brm\s+[^;]*-[a-zA-Z]*[rf]/,
	/\bsudo\b/,
	/\breboot\b/,
	/\bshutdown\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
];

function hasBlockedSubstitution(command: string): boolean {
	const stripped = command.replace(/\\\n/g, " ");
	// $() , ``, ${} — crude nesting-agnostic scan: check each expansion body.
	// L1: `${…}` bodies are scanned too (`${sudo}`, `${IFS}` tricks) — the
	// old comment claimed this while the code only collected $() and
	// backticks. Still best-effort: nested/braced expansions can dodge a
	// regex scan, so this stays a guardrail, not a sandbox.
	const bodies: string[] = [];
	const dollarParen = stripped.match(/\$\(([^)]*)\)/g) ?? [];
	for (const m of dollarParen) bodies.push(m);
	const backtick = stripped.match(/`([^`]*)`/g) ?? [];
	for (const m of backtick) bodies.push(m);
	const dollarBrace = stripped.match(/\$\{([^}]*)\}/g) ?? [];
	for (const m of dollarBrace) bodies.push(m);
	for (const body of bodies) {
		for (const pattern of BLOCKED_IN_SUBSTITUTION) {
			if (pattern.test(body)) return true;
		}
	}
	return false;
}

export function isDangerous(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ");
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(normalized)) {
			return `Command blocked by safe_bash: matches dangerous pattern ${pattern}`;
		}
	}
	if (hasBlockedSubstitution(command)) {
		return `Command blocked by safe_bash: blocked verb inside command substitution`;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "safe_bash",
		label: "Safe Bash",
		description:
			"Execute a bash command. Best-effort block on dangerous commands (rm -rf /, sudo, mkfs, etc.). Not a sandbox — bypassable by determined input.",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds (optional)" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const danger = isDangerous(params.command);
			if (danger) {
				throw new Error(danger);
			}
			// Resolve cwd per call (M9): the process may have moved since the
			// extension loaded, and the tool context carries the live cwd.
			// Pass ctx through (previously dropped).
			const cwd =
				(ctx as unknown as { cwd?: unknown })?.cwd;
			const effectiveCwd =
				typeof cwd === "string" && cwd ? cwd : process.cwd();
			const bashTool = createBashTool(effectiveCwd);
			return (bashTool.execute as (...args: unknown[]) => unknown)(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
	});
}
