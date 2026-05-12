import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const candidates = [
    "https://www.gapowork.vn/messenger",
    "https://www.gapowork.vn/messenger/",
    "https://www.gapowork.vn/messenger/0",
    "https://www.gapowork.vn/messenger/1",
  ];

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(4000);
      const finalUrl = page.url();
      const hasSidebar = (await page.locator('a[href*="/messenger/"]').count()) > 0;
      console.log(`${url}\n  → ${finalUrl}\n  has sidebar: ${hasSidebar}`);
    } catch (e: any) {
      console.log(`${url}\n  ERROR: ${e.message?.slice(0, 80)}`);
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
