/**
 * Extension config access without import-time freezing (R10).
 *
 * index.ts historically did `const tabsConfig = loadExtensionConfig().tabs`
 * once at import, so `tabs.keepOpen` flips required a /reload and tests
 * could only exercise `parse*` helpers. This module keeps the same file
 * format but reads fresh per call (one small JSON read) with a lightweight
 * cache invalidated on session_start.
 */
import { loadExtensionConfig, type ExtensionConfig, type StatusConfig, type TabsConfig } from "./status.ts";

let cached: ExtensionConfig | null = null;

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
      cached = { status: { enabled: true, lineLimit: 4 }, tabs: { keepOpen: false } };
    } else {
      throw err;
    }
  }
  return cached;
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
