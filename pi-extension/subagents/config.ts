/**
 * Extension config access without import-time freezing (R10).
 *
 * index.ts historically did `const tabsConfig = loadExtensionConfig().tabs`
 * once at import, so `tabs.keepOpen` flips required a /reload and tests
 * could only exercise `parse*` helpers. This module keeps the same file
 * format but reads fresh per call (one small JSON read) with a lightweight
 * cache invalidated on session_start.
 */
import { loadExtensionConfig, DEFAULT_STATUS_LINE_LIMIT, type ExtensionConfig, type StatusConfig, type TabsConfig } from "./status.ts";

let cached: ExtensionConfig | null = null;

function defaultExtensionConfig(): ExtensionConfig {
  return {
    status: { enabled: true, lineLimit: DEFAULT_STATUS_LINE_LIMIT },
    tabs: { keepOpen: false },
  };
}

export function getExtensionConfig(forceReload = false): ExtensionConfig {
  if (cached && !forceReload) return cached;
  try {
    cached = loadExtensionConfig();
  } catch (err) {
    // M5: only fall back when no config file exists at all. Invalid JSON or
    // schema errors must surface (loud, fixable) instead of silently
    // discarding the user's entire status+tabs config.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Missing subagent status config")) {
      cached = defaultExtensionConfig();
    } else {
      throw err;
    }
  }
  return cached;
}

/**
 * Non-throwing config read for render + timer paths (M4). Tool paths keep
 * using `getExtensionConfig()` (loud on schema errors, per rule 5), but the
 * widget render callback and the 1s status timer must degrade to last-good
 * (or defaults) instead of throwing per frame/tick on a bad file.
 */
let lastGood: ExtensionConfig | null = null;

export function getSafeExtensionConfig(): ExtensionConfig {
  try {
    lastGood = getExtensionConfig();
    return lastGood;
  } catch (err) {
    try {
      console.error(
        `[subagents] invalid config, degrading to last-good until fixed: ${(err as Error)?.message ?? err}`,
      );
    } catch {}
    return lastGood ?? defaultExtensionConfig();
  }
}

export function invalidateExtensionConfigCache(): void {
  cached = null;
}

export function getStatusConfig(): StatusConfig {
  return getExtensionConfig().status;
}

export function getTabsConfig(): TabsConfig {
  return getExtensionConfig().tabs;
}

export function isStatusEnabled(): boolean {
  return getStatusConfig().enabled === true;
}

export function isKeepOpenEnabled(): boolean {
  return getTabsConfig().keepOpen === true;
}

export type { ExtensionConfig, StatusConfig, TabsConfig };
