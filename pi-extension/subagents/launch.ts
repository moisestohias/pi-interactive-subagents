/**
 * Launch command builders. Single home for the pi / claude command shapes
 * previously built inline in both launchSubagent and the resume branch (R2+R11).
 *
 * All builders are pure string assembly — quoting via shellEscape stays
 * byte-identical to the historical inline code. Side effects (mkdir/writeFile
 * for artifact handoff + sysprompt files) are isolated in small helpers so
 * they can be snapshot-tested.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { shellEscape } from "./kitty.ts";
import { getSubagentsDir } from "./paths.ts";
import { slugifyName } from "./names.ts";
import { getToolExtensionPath, type SubagentLoadoutShim } from "./launch-types.ts";
import type { SubagentLoadout } from "./session.ts";

// ── Small pure helpers ──────────────────────────────────────────────────────

/** `cd '<dir>' && ` prefix, or "" when no cwd. */
export function buildCdPrefix(cwd: string | null | undefined): string {
  return cwd ? `cd ${shellEscape(cwd)} && ` : "";
}

/** Legacy-wire scrub prefix (config.json is the sole truth for keepOpen). */
export const SCRUB_PREFIX = "unset PI_SUBAGENT_KEEP_TAB; ";

/** `__SUBAGENT_DONE_` terminal sentinel suffix. */
export function withDoneSentinel(command: string): string {
  return `${command}; echo '__SUBAGENT_DONE_'$?'__'`;
}

export interface EnvPrefixOpts {
  agentDir?: string | null;
  spawnable?: string[] | null;
  agent?: string | null;
  name: string;
  sessionFile: string;
  childId: string;
  activityFile: string;
  surface: string;
  autoExit: boolean;
  extra?: string[];
}

/**
 * Build the `KEY='v' KEY='v' ` env prefix. Key order matches the historical
 * launch path so snapshot tests stay stable; resume uses the same order.
 */
export function buildEnvPrefix(opts: EnvPrefixOpts): string {
  const parts: string[] = [];
  if (opts.agentDir) parts.push(`PI_CODING_AGENT_DIR=${shellEscape(opts.agentDir)}`);
  if (opts.spawnable && opts.spawnable.length > 0) {
    parts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(opts.spawnable.join(","))}`);
  }
  if (opts.agent) parts.push(`PI_SUBAGENT_AGENT=${shellEscape(opts.agent)}`);
  parts.push(`PI_SUBAGENT_NAME=${shellEscape(opts.name)}`);
  if (opts.autoExit) parts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  parts.push(`PI_SUBAGENT_SESSION=${shellEscape(opts.sessionFile)}`);
  parts.push(`PI_SUBAGENT_ID=${shellEscape(opts.childId)}`);
  parts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(opts.activityFile)}`);
  parts.push(`PI_SUBAGENT_SURFACE=${shellEscape(opts.surface)}`);
  if (opts.extra) parts.push(...opts.extra);
  return parts.join(" ") + " ";
}

/**
 * Strip control characters from a preamble field. Preamble lines are `# …`
 * comments inside a `bash`-executed script file — an interior newline in an
 * interpolated value (LLM-controlled `name`, or `cwd`-derived paths) would
 * escape the comment and execute as shell (C1). Collapsing to spaces keeps
 * every field on its own comment line. The sink (`sendLongCommand` in
 * kitty.ts) re-validates each preamble line defensively.
 */
export function sanitizePreambleField(value: string | undefined): string | undefined {
  if (value == null) return value;
  return String(value).replace(/[\r\n]+/g, " ");
}

/** `# …` preamble lines for launch/resume scripts (one format, one place). */
export function scriptPreambleFor(
  kind: "launch" | "resume" | "claude-launch",
  meta: { name: string; sessionFile?: string; surface: string; resumeMsgFile?: string },
): string {
  const name = sanitizePreambleField(meta.name) ?? "";
  const sessionFile = sanitizePreambleField(meta.sessionFile);
  const surface = sanitizePreambleField(meta.surface) ?? "";
  const resumeMsgFile = sanitizePreambleField(meta.resumeMsgFile);
  const lines = [
    `# Subagent ${kind} script for ${name}`,
    `# Generated: ${new Date().toISOString()}`,
  ];
  if (sessionFile) lines.push(`# Session: ${sessionFile}`);
  lines.push(`# Surface: ${surface}`);
  if (resumeMsgFile) lines.push(`# Resume message file: ${resumeMsgFile}`);
  return lines.join("\n");
}

/** Stable artifact script path: `<artifactDir>/subagent-scripts/<file>`. */
export function scriptPathFor(artifactDir: string, file: string): string {
  return join(artifactDir, "subagent-scripts", file);
}

// ── Sandbox (model / identity / default-deny tools) ─────────────────────────
// Canonical implementation lives here; index.ts delegates (was applySandboxToParts).

export function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = slugifyName(opts.name);
    const spPath = join(opts.artifactDir, `context/${spSafeName}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  if (loadout.toolAllowlist) {
    parts.push("--no-extensions");
    parts.push("--tools", shellEscape(loadout.toolAllowlist));

    const extPaths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      const extPath = getToolExtensionPath(tool);
      if (extPath && existsSync(extPath)) extPaths.add(extPath);
    }
    for (const extPath of extPaths) {
      parts.push("-e", shellEscape(extPath));
    }
  }
}

// ── Tool allowlist ──────────────────────────────────────────────────────────

export const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;
export const DEFAULT_SUBAGENT_TOOLS = ["read", "write", "edit", "bash"] as const;

export function buildSubagentToolAllowlist(
  effectiveTools?: string,
  opts?: { grantSpawning?: boolean; spawningTools?: readonly string[] },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;
  const spawningTools = opts?.spawningTools ?? ["subagent", "subagent_message", "subagents_list"];

  const base = requested.length > 0 ? requested : [...DEFAULT_SUBAGENT_TOOLS];

  const allow = new Set(base);
  if (grantSpawning) {
    for (const tool of spawningTools) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

// ── Prompt args ─────────────────────────────────────────────────────────────

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

/** Write the artifact-backed task file; returns the `@path` task arg. */
export function writeTaskArtifact(
  artifactDir: string,
  name: string,
  fullTask: string,
  timestamp?: string,
): string {
  const ts = timestamp ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const artifactName = `context/${slugifyName(name)}-${ts}.md`;
  const artifactPath = join(artifactDir, artifactName);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, fullTask, "utf8");
  return `@${artifactPath}`;
}

/** Write a resume message file; returns its path. */
export function writeResumeMessageFile(artifactDir: string, name: string, message: string): string {
  const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(
    artifactDir,
    "subagent-resume",
    `${slugifyName(name) || "resume"}-${msgTimestamp}.md`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, message, "utf8");
  return file;
}

// ── CLI backends (R11 seam) ─────────────────────────────────────────────────

export interface PiCommandOpts {
  sessionFile: string;
  loadout: SubagentLoadout;
  artifactDir: string;
  name: string;
  promptArgs: string[];
}

export function buildPiParts(opts: PiCommandOpts): string[] {
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(opts.sessionFile));
  const subagentDonePath = join(getSubagentsDir(), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));
  applySandboxToParts(parts, opts.loadout, { artifactDir: opts.artifactDir, name: opts.name });
  for (const promptArg of opts.promptArgs) {
    parts.push(shellEscape(promptArg));
  }
  return parts;
}

// NOTE: Claude command assembly lives in cli/claude.ts:buildClaudeCommand
// (single home, wired by index.ts). Do not add a second builder here.

// Re-export type shim helper for tests that stub tool paths.
export type { SubagentLoadoutShim };
