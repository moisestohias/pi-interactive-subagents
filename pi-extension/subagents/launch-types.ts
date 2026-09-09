/**
 * Narrow bridge so launch.ts can resolve tool→extension without importing
 * agents.ts (which imports paths/names only — kept separate to avoid any
 * future cycle if agents.ts ever imports launch helpers).
 *
 * Canonical implementation lives in agents.ts; this re-exports it.
 */
export { getToolExtensionPath } from "./agents.ts";
export type SubagentLoadoutShim = unknown;
