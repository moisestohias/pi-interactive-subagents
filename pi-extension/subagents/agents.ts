/**
 * Agent definitions: types, frontmatter parsing, discovery, spawn gating,
 * tool→extension mapping, and path resolution.
 *
 * Extracted from index.ts (R1). Single owner of everything derived from
 * `agents/*.md` frontmatter so launch/resume/tools share one implementation.
 */
import { join } from "node:path";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { getSubagentsDir } from "./paths.ts";
import { safePathSegment } from "./names.ts";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * Controls whether this agent may spawn its own subagents. Missing or
   * `false` (the default) means it cannot spawn at all. `true` grants the
   * full subagent spawning toolset with no target restriction (may spawn any
   * discoverable agent). A non-empty list grants the toolset restricted to
   * exactly the listed agents.
   */
  subagentAgents?: boolean | string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "package" | "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * Granted only when frontmatter sets `subagent_agents: true` or a non-empty
 * list. Missing or `false` grants nothing.
 */
export const SPAWNING_TOOLS = ["subagent", "subagent_message", "subagents_list"] as const;

/** Built-in tools pi provides natively — no extension needs to be loaded. */
export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/**
 * Single table for known tool → backing extension file. Runtime-registered
 * tools (via registerToolExtension) extend this; built-ins need no entry.
 * Unknown tools resolve to undefined (caller drops them from `-e`).
 */
export function getToolExtensionMap(subagentsDir: string, agentConfigDir: string): Record<string, string> {
  const extBase = join(agentConfigDir, "extensions");
  return {
    web_search: join(extBase, "web-search", "index.ts"),
    web_fetch: join(extBase, "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(subagentsDir, "tools", "safe-bash.ts"),
  };
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Runtime tool-extension registration ─────────────────────────────────────
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

/** Test hook: clear runtime-registered tool extensions. */
export function __clearToolExtensionsForTest(): void {
  EXTRA_TOOL_EXTENSIONS.clear();
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map.
if (!(globalThis as any).__pi_interactive_subagents) {
  (globalThis as any).__pi_interactive_subagents = { registerToolExtension };
} else {
  (globalThis as any).__pi_interactive_subagents.registerToolExtension = registerToolExtension;
}

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Returns undefined for built-ins and unknown names.
 */
export function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return join(getSubagentsDir(), "index.ts");
  }
  const map = getToolExtensionMap(getSubagentsDir(), getAgentConfigDir());
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool);
}

/** Read PI_SUBAGENT_ALLOWED fresh (not frozen at import) — see config.ts. */
export function getSubagentAllowlist(): Set<string> | null {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

export function getBundledAgentsDir(): string {
  return join(getSubagentsDir(), "../../agents");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  // N12: escape the key (all live callers use constants, but this is exported).
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

export function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
export function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Parse the `subagent_agents` frontmatter gate:
 * missing → undefined (no spawning), `true` → true (spawn any),
 * `false` → false (no spawning), otherwise a comma-separated allowlist.
 */
export function parseSubagentAgents(value: string | undefined): boolean | string[] | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  return parseCommaList(value);
}

/** Whether this agent definition may spawn subagents at all. */
export function canSpawnSubagents(agentDefs: AgentDefaults | null | undefined): boolean {
  const gate = agentDefs?.subagentAgents;
  return gate === true || (Array.isArray(gate) && gate.length > 0);
}

export function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  // N13: tolerate CRLF + trailing-space fences; require the closing fence
  // at line start so `---` inside values/bodies can't truncate parsing.
  // Trailing newline after the fence is optional (empty-body files end at `---`).
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace" ? "replace" : systemPromptMode === "append" ? "append" : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseSubagentAgents(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

export function discoverAgentDefinitions(allowlist?: Set<string> | null): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  const effective = allowlist !== undefined ? allowlist : getSubagentAllowlist();
  const all = [...agents.values()];
  return effective ? all.filter((a) => effective.has(a.name)) : all;
}

export interface ResolvedSubagentPaths {
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
}

export function resolveSubagentPaths(
  params: { cwd?: string },
  agentDefs: AgentDefaults | null,
): ResolvedSubagentPaths {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd ? (rawCwd.startsWith("/") ? rawCwd : join(cwdBase, rawCwd)) : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const sessionDir = join(agentDir, "sessions", safePathSegment(cwd));
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  _params: unknown,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: unknown,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 * Resolution: explicit `interactive` frontmatter, else inverse of `auto-exit`.
 */
export function resolveEffectiveInteractive(
  _params: unknown,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

export function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}
