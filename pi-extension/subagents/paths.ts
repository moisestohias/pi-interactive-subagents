/**
 * Shared filesystem paths. Tiny module with no dependencies (except node
 * builtins) so agents.ts / launch.ts / lifecycle.ts can all import it
 * without cycles.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

/** Absolute path to `pi-extension/subagents`. */
export function getSubagentsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Build the internal artifact directory path for a session.
 * Convention: <sessionDir>/artifacts/<session-id>/
 */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}
