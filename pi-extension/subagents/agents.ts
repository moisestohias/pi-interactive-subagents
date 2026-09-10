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
// M8: the map itself lives on a `Symbol.for` global (like the other
// reload-surviving state) so registrations persist across `/reload`
// re-imports. Previously only the `registerToolExtension` function pointer
// was published while the module-local `Map` reset to empty — the tool's
// `-e` path then silently stopped resolving and children launched with a
// narrower toolset.
const TOOL_EXTENSIONS_KEY = Symbol.for("pi-subagents/tool-extensions");

function extraToolExtensions(): Map<string, string> {
  let map = (globalThis as any)[TOOL_EXTENSIONS_KEY];
  if (!(map instanceof Map)) {
    map = new Map<string, string>();
    (globalThis as any)[TOOL_EXTENSIONS_KEY] = map;
  }
  return map;
}

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = extraToolExtensions().get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  extraToolExtensions().set(name, extensionPath);
}

/** Test hook: clear runtime-registered tool extensions. */
export function __clearToolExtensionsForTest(): void {
  extraToolExtensions().clear();
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
  return extraToolExtensions().get(tool);
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

/**
 * Parse a frontmatter block once into a key→value map (S7). Values are
 * single-line `key: value` pairs; the fence regex in `parseAgentDefinition`
 * already isolates the block, so this is a line scan (no per-key RegExp).
 * Duplicate keys are pathological (the old regex returned the first match);
 * last-wins here is equally safe. Values keep their trimmed text, including
 * "" — the `getFrontmatterValue` wrapper below maps "" back to undefined
 * to preserve the old `(.+)` contract.
 */
export function parseFrontmatterBlock(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key || /\s/.test(key)) continue;
    out.set(key, line.slice(colon + 1).trim());
  }
  return out;
}

/**
 * Thin wrapper over `parseFrontmatterBlock` (kept for test compat).
 * Returns undefined for missing keys AND empty values (matches the old
 * regex, which required `(.+)` after the colon).
 */
export function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  // N12: keys are constants at all live callers, but this is exported —
  // the map lookup needs no escaping at all (one more reason for the map).
  void escapeRegExp;
  const value = parseFrontmatterBlock(frontmatter).get(key);
  return value != null && value !== "" ? value : undefined;
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
  // S7: parse the block once into a Map (O(1) per key, no per-key RegExp).
  const fm = parseFrontmatterBlock(frontmatter);
  const get = (key: string): string | undefined => {
    const value = fm.get(key);
    return value != null && value !== "" ? value : undefined;
  };
  const systemPromptMode = get("system-prompt");

  return {
    name: get("name") ?? fallbackName,
    description: get("description"),
    model: get("model"),
    tools: get("tools"),
    systemPromptMode:
      systemPromptMode === "replace" ? "replace" : systemPromptMode === "append" ? "append" : undefined,
    skills: get("skill") ?? get("skills"),
    thinking: get("thinking"),
    subagentAgents: parseSubagentAgents(get("subagent_agents")),
    autoExit: parseOptionalBoolean(get("auto-exit")),
    interactive: parseOptionalBoolean(get("interactive")),
    sessionMode: parseSessionMode(get("session-mode")),
    cwd: get("cwd"),
    cli: get("cli"),
    body: body || undefined,
    disableModelInvocation:
      get("disable-model-invocation")?.toLowerCase() === "true",
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

/** Single launch-policy decision table (S8): everything the spawner derives from an agent definition. */
export interface LaunchPolicy {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
  interactive: boolean;
}

/**
 * Resolve the full launch policy from an agent definition in one table:
 * `sessionMode` (frontmatter `session-mode`, default `standalone`) drives
 * the seed/task-delivery arms; `interactive` is explicit frontmatter else
 * the inverse of `auto-exit`. Call sites take one call instead of three.
 */
export function resolveLaunchPolicy(agentDefs: AgentDefaults | null): LaunchPolicy {
  const sessionMode = agentDefs?.sessionMode ?? "standalone";
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
    interactive:
      agentDefs?.interactive != null ? agentDefs.interactive : !(agentDefs?.autoExit ?? false),
  };
}

/**
 * @deprecated Use `resolveLaunchPolicy(agentDefs).sessionMode`. Kept for
 * `__test__` compat (`test/test.ts` pins this key — D7).
 */
export function resolveEffectiveSessionMode(
  _params: unknown,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return resolveLaunchPolicy(agentDefs).sessionMode;
}

/**
 * @deprecated Use `resolveLaunchPolicy(agentDefs)` (minus `interactive`).
 * Kept for `__test__` compat (`test/test.ts` pins this key — D7).
 */
export function resolveLaunchBehavior(
  params: unknown,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  void params;
  const { sessionMode, seededSessionMode, inheritsConversationContext, taskDelivery } =
    resolveLaunchPolicy(agentDefs);
  return { sessionMode, seededSessionMode, inheritsConversationContext, taskDelivery };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 * Resolution: explicit `interactive` frontmatter, else inverse of `auto-exit`.
 * @deprecated Use `resolveLaunchPolicy(agentDefs).interactive`. Kept for
 * `__test__` compat (`test/test.ts` pins this key — D7).
 */
export function resolveEffectiveInteractive(
  _params: unknown,
  agentDefs: AgentDefaults | null,
): boolean {
  return resolveLaunchPolicy(agentDefs).interactive;
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
