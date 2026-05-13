import * as fs from "node:fs";
import * as path from "node:path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { config } from "./config";

/**
 * Singleton Playwright browser + context. Lazy-launches on first use,
 * persists cookies via storage state, auto-relaunches if the underlying
 * Chromium dies.
 *
 * Why singleton: Chromium boot is ~2s and the storage state file is the
 * single source of truth for "logged in or not". Re-launching per call
 * would multiply latency 100×.
 */

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function ensureLaunched(): Promise<BrowserContext> {
  if (context && browser?.isConnected()) return context;

  // Clean up zombie state from a previous crash.
  await disconnect().catch(() => {});

  // Headless Chromium gets bot-detected by Gapo (the SPA refuses to
  // hydrate). Production runs headed in an Xvfb display managed by the
  // host. BROWSER_DISPLAY (defaulting to :99) tells Playwright which X
  // display to use; the systemd unit / startup script must keep Xvfb
  // alive on that display.
  //
  // We read process.env directly here rather than `config.browser.headless`
  // because the `config` constant is captured at module load — before the
  // plugin's env loader has a chance to run when imported by the OpenClaw
  // gateway. Reading lazily at launch time makes BROWSER_HEADLESS=0 work
  // regardless of import order.
  const wantHeadless = (process.env.BROWSER_HEADLESS ?? "1") !== "0";
  if (!wantHeadless && process.env.DISPLAY === undefined) {
    process.env.DISPLAY = process.env.BROWSER_DISPLAY ?? ":99";
  }
  browser = await chromium.launch({
    headless: wantHeadless,
    slowMo: config.browser.slowMoMs,
  });

  const storagePath = config.browser.storageStatePath;
  const hasStorage = fs.existsSync(storagePath);
  if (!hasStorage) {
    // Make sure parent dir exists so saveStorageState() later doesn't ENOENT.
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  }

  context = await browser.newContext({
    storageState: hasStorage ? storagePath : undefined,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    viewport: { width: 1280, height: 800 },
    // Match a recent stable Chrome build so the SPA doesn't take a
    // bot-detection branch. Update if Chromium binary version drifts.
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });

  return context;
}

export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await ensureLaunched();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Long-lived page for the message watcher. Unlike `withPage`, the caller
 * owns the lifecycle and decides when to close. Used by the watcher to
 * keep a permanent messenger view open for MutationObserver + polling.
 */
export async function newLongLivedPage(): Promise<Page> {
  const ctx = await ensureLaunched();
  return await ctx.newPage();
}

export async function saveStorageState(): Promise<void> {
  if (!context) return;
  await context.storageState({ path: config.browser.storageStatePath });
}

export async function disconnect(): Promise<void> {
  try {
    await context?.close();
  } catch {
    /* noop */
  }
  try {
    await browser?.close();
  } catch {
    /* noop */
  }
  context = null;
  browser = null;
}

/** True if storage state exists on disk. Doesn't check freshness — Gapo
 * sessions can expire even with cookies present. */
export function hasStoredAuth(): boolean {
  return fs.existsSync(config.browser.storageStatePath);
}

/** Cheap sanity check for a saved Gapo login. A storage file may exist but
 * contain only analytics cookies after the real session expires. */
export function hasLikelyGapoAuth(): boolean {
  if (!hasStoredAuth()) return false;
  try {
    const raw = fs.readFileSync(config.browser.storageStatePath, "utf-8");
    const state = JSON.parse(raw) as {
      cookies?: Array<{ domain?: string; name?: string }>;
      origins?: Array<{ origin?: string; localStorage?: Array<{ name?: string; value?: string }> }>;
    };
    const hasAuthCookie = (state.cookies ?? []).some((cookie) => {
      const domain = cookie.domain ?? "";
      const name = (cookie.name ?? "").toLowerCase();
      if (!domain.includes("gapowork")) return false;
      return !name.startsWith("_ga") && !name.startsWith("_gid") && !name.startsWith("_gat");
    });
    const hasAuthStorage = (state.origins ?? []).some((origin) => {
      if (!(origin.origin ?? "").includes("gapowork")) return false;
      return (origin.localStorage ?? []).some((item) => {
        const name = (item.name ?? "").toLowerCase();
        const value = item.value ?? "";
        return value.length > 20 && ["token", "refresh_token", "user_info", "user_workspace"].includes(name);
      });
    });
    return hasAuthCookie || hasAuthStorage;
  } catch {
    return false;
  }
}
