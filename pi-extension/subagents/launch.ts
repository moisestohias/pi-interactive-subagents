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
import { slugifyName, contextArtifactName, launchScriptName, resumeScriptName } from "./names.ts";
import { timestampTag } from "./format.ts";
import { getToolExtensionPath } from "./agents.ts";
import type { SubagentLoadout } from "./session.ts";
/** @deprecated Removed shim (S6): `launch-types.ts` deleted — import `agents.ts` directly. Kept as a type alias so older imports keep compiling. */
export type SubagentLoadoutShim = unknown;

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
 * Build the `KEY='v' KEY='v' ` env prefix. Single order shared by launch
 * and resume (T2/T3 unification): AGENT before NAME, SURFACE last,
 * AUTO_EXIT after NAME (first-class `autoExit`, never via `extra`).
 *
 * PI_SUBAGENT_* contract (M4) — writer → reader → compat:
 * - PI_CODING_AGENT_DIR … plan (launch: resolved local-or-global; resume:
 *   loadout snapshot, else current env) → agents.ts:getAgentConfigDir()
 *   (child resolves same agents/extensions) → additive; absent = default dir.
 * - PI_SUBAGENT_ALLOWED … plan (launch: pinned list only when spawning is
 *   granted for a list; resume: loadout.spawnable replay) →
 *   agents.ts:getSubagentAllowlist() (nested-spawn gate) → additive;
 *   absent = unrestricted (only reachable with `subagent_agents: true`).
 * - PI_SUBAGENT_AGENT … plan (launch: params.agent; resume: loadout replay)
 *   → subagent-done.ts (self-spawn guard) → informational; absent = none.
 * - PI_SUBAGENT_NAME … plan (unique per spawner session) → subagent-done.ts
 *   (preamble/comments) + resume addressing → compat: never reuse a live name.
 * - PI_SUBAGENT_AUTO_EXIT=1 … plan iff the run is autonomous (launch:
 *   effectiveAutoExit; resume: always) → subagent-done.ts (auto-exit path)
 *   → additive; absent = keep-open eligible.
 * - PI_SUBAGENT_SESSION/ID/ACTIVITY_FILE … plan → subagent-done.ts
 *   (sidecar addressing) → compat: paths, never reused across runs.
 * - PI_SUBAGENT_SURFACE … plan (launch + resume unified) → write-only
 *   today (M10: no reader; kept for parity/debugging) → additive.
 * - Legacy PI_SUBAGENT_KEEP_TAB … never set; scrubbed via SCRUB_PREFIX
 *   (config.json `tabs.keepOpen` is the sole truth) → removed wire.
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
    const spTimestamp = timestampTag();
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
  // T1b: default spawning set lives with the gate definition in agents.ts
  // (single home) so the index wrapper's injection can't drift.
  const spawningTools = opts?.spawningTools ?? SPAWNING_TOOLS;

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
  const ts = timestamp ?? timestampTag();
  // S4: filename via names.ts (single home; slugify never returns "").
  const artifactName = `context/${contextArtifactName(name, ts)}`;
  const artifactPath = join(artifactDir, artifactName);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, fullTask, "utf8");
  return `@${artifactPath}`;
}

/** Write a resume message file; returns its path. */
export function writeResumeMessageFile(
  artifactDir: string,
  name: string,
  message: string,
  msgTimestamp?: string,
): string {
  const ts = msgTimestamp ?? timestampTag();
  // S4: filename via names.ts (single home; slugify never returns "").
  const file = join(artifactDir, "subagent-resume", contextArtifactName(name, ts));
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

// ── Unified plan pipeline (T2/T3) ───────────────────────────────────────────
// One assembly per backend path so launch and resume cannot drift (same
// sandbox replay, same quoting via shellEscape, same env order per the M4
// table above). Guards stay in the handlers (kept double-open refusal,
// stale-sidecar unlink after reservation, loadout refusal, entryCountBefore).
// Stays in launch.ts (defer the P4 split until the file actually doubles).

export interface PiLaunchPlan {
  /** Full shell command with DONE sentinel (typed into the tab). */
  command: string;
  /** Stable artifact script path (exact invocation preserved for debugging). */
  scriptFile: string;
  /** The `KEY='v' … ` env prefix (single order — see buildEnvPrefix). */
  envPrefix: string;
  /** Assembled `pi …` parts (unquoted join feeds `command`). */
  parts: string[];
  /** `cd … && ` prefix (or ""). */
  cdPrefix: string;
}

/**
 * Build the pi-launch command via the single pipeline. `taskArg` is the
 * caller-computed prompt target (direct task or `@artifact` from
 * `writeTaskArtifact`); `autoExit` is the effective decision (not the agent
 * flag). Side effects: sysprompt persistence via `applySandboxToParts`.
 */
export function buildPiLaunchPlan(opts: {
  sessionFile: string;
  loadout: SubagentLoadout;
  artifactDir: string;
  name: string;
  surface: string;
  taskArg: string;
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  childId: string;
  activityFile: string;
  autoExit: boolean;
  targetCwd: string | null;
}): PiLaunchPlan {
  const promptArgs = buildPiPromptArgs({
    effectiveSkills: opts.effectiveSkills,
    taskDelivery: opts.taskDelivery,
    taskArg: opts.taskArg,
  });
  const parts = buildPiParts({
    sessionFile: opts.sessionFile,
    loadout: opts.loadout,
    artifactDir: opts.artifactDir,
    name: opts.name,
    promptArgs,
  });
  const envPrefix = buildEnvPrefix({
    agentDir: opts.loadout.agentDir,
    spawnable: opts.loadout.spawnable,
    agent: opts.loadout.agent,
    name: opts.name,
    sessionFile: opts.sessionFile,
    childId: opts.childId,
    activityFile: opts.activityFile,
    surface: opts.surface,
    autoExit: opts.autoExit,
  });
  const cdPrefix = buildCdPrefix(opts.targetCwd);
  const command = withDoneSentinel(`${SCRUB_PREFIX}${cdPrefix}${envPrefix}${parts.join(" ")}`);
  const scriptFile = scriptPathFor(opts.artifactDir, launchScriptName(opts.name, opts.childId));
  return { command, scriptFile, envPrefix, parts, cdPrefix };
}

export interface PiResumePlan {
  /** Full shell command with DONE sentinel. */
  command: string;
  /** Stable artifact script path. */
  scriptFile: string;
  /** Resume message file (`@${file}` is in `parts` when `message` present). */
  resumeMsgFile?: string;
  /** Assembled `pi …` parts. */
  parts: string[];
  /** The shared env prefix (canonical order, SURFACE included). */
  envPrefix: string;
  /** `cd … && ` prefix (or ""). */
  cdPrefix: string;
}

/**
 * Build the pi-resume command via the single pipeline. Resume is always
 * autonomous (`autoExit: true` first-class, never via `extra`). Side
 * effects: resume-message file + sysprompt persistence (via sandbox replay).
 * `stamp`/`msgTimestamp` are test seams (default: live clock).
 */
export function buildPiResumePlan(opts: {
  sessionPath: string;
  loadout: SubagentLoadout;
  artifactDir: string;
  name: string;
  surface: string;
  id: string;
  activityFile: string;
  message?: string;
  resumeCwd: string | null;
  stamp?: number | string;
  msgTimestamp?: string;
}): PiResumePlan {
  let resumeMsgFile: string | undefined;
  if (opts.message) {
    resumeMsgFile = writeResumeMessageFile(opts.artifactDir, opts.name, opts.message, opts.msgTimestamp);
  }
  // Single-home parts assembly (same builder launch uses — they can't drift).
  const parts = buildPiParts({
    sessionFile: opts.sessionPath,
    loadout: opts.loadout,
    artifactDir: opts.artifactDir,
    name: opts.name,
    promptArgs: resumeMsgFile ? [`@${resumeMsgFile}`] : [],
  });
  const envPrefix = buildEnvPrefix({
    agentDir: opts.loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null,
    spawnable: opts.loadout.spawnable,
    agent: opts.loadout.agent,
    name: opts.name,
    sessionFile: opts.sessionPath,
    childId: opts.id,
    activityFile: opts.activityFile,
    surface: opts.surface,
    autoExit: true,
  });
  const cdPrefix = buildCdPrefix(opts.resumeCwd);
  const command = withDoneSentinel(`${SCRUB_PREFIX}${cdPrefix}${envPrefix}${parts.join(" ")}`);
  const scriptFile = scriptPathFor(opts.artifactDir, resumeScriptName(opts.name, opts.stamp ?? Date.now()));
  return { command, scriptFile, resumeMsgFile, parts, envPrefix, cdPrefix };
}

import { SPAWNING_TOOLS } from "./agents.ts";
