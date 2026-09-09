/**
 * Barrel: preserves `import … from "./session.ts"` for existing callers
 * (index.ts, tests) while the implementation lives in `session/` (R8).
 */
export type { SessionEntry, MessageEntry, SeededSubagentSessionMode } from "./session/types.ts";
export {
  readEntries,
  countSessionEntryLines,
  getNewEntries,
  readEntriesAfter,
  findLastAssistantMessage,
} from "./session/io.ts";
export {
  getSessionId,
  resolveSessionFileById,
  resolveSessionFileByIdAsync,
  resetSessionIndexCache,
} from "./session/index-cache.ts";
export type { NameRegistryEntry, NameRegistry } from "./session/registry.ts";
export {
  nameRegistryPath,
  readNameRegistry,
  registerName,
  resolveNameInRegistry,
} from "./session/registry.ts";
export type { SubagentLoadout } from "./session/loadout.ts";
export {
  loadoutSidecarPath,
  writeSubagentLoadout,
  readSubagentLoadout,
} from "./session/loadout.ts";
export { seedSubagentSessionFile } from "./session/seed.ts";
export type { SessionStats } from "./session/stats.ts";
export { summarizeSessionStats } from "./session/stats.ts";
// Deprecated branch helpers (quarantined, re-exported for compat).
export {
  getLeafId,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
} from "./session/legacy-branch.ts";
