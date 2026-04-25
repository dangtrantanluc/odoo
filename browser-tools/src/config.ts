import * as path from "node:path";
import * as os from "node:os";

export const config = {
  // Gapo Work URL — the page Playwright lands on after auth.
  gapo: {
    baseUrl: process.env.GAPO_WORK_URL || "https://work.gapo.vn",
  },

  // Browser config. headless=false is useful for debugging selectors;
  // set BROWSER_HEADLESS=0 to watch the bot drive a real Chromium.
  browser: {
    headless: (process.env.BROWSER_HEADLESS ?? "1") !== "0",
    // Persisted cookies + localStorage live here. Re-auth means deleting
    // this file and re-running `pnpm auth`.
    storageStatePath:
      process.env.BROWSER_STORAGE_STATE ||
      path.join(os.homedir(), ".openclaw", "plugins", "browser-tools", "storage-state.json"),
    slowMoMs: Number(process.env.BROWSER_SLOWMO_MS ?? 0),
  },

  // Shared secret with bb-pm-tools for the fallback path. Same shape as
  // GAPO_SEND_TOKEN (`X-Plugin-Token` header).
  auth: {
    pluginToken: process.env.BROWSER_TOOLS_TOKEN || "",
  },

  // Daily DM cap — protects against runaway loops + Gapo flagging the
  // account as a bot. Cooldown still applies upstream in bb-pm-tools.
  limits: {
    maxDmsPerHour: Number(process.env.BROWSER_MAX_DMS_PER_HOUR ?? 30),
  },
} as const;

export function assertConfig(): string[] {
  const missing: string[] = [];
  if (!config.auth.pluginToken) missing.push("BROWSER_TOOLS_TOKEN");
  return missing;
}
