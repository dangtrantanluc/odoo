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

  browser = await chromium.launch({
    headless: config.browser.headless,
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
