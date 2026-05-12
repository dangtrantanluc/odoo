import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.goto("https://www.gapowork.vn/messenger/1777432856955", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
  await page.waitForTimeout(1500);
  const orgInput = page.locator('input[placeholder*="Gapowork"]').first();
  await orgInput.type("Lực", { delay: 50 });
  await page.waitForTimeout(2500);

  // Hover over search result to reveal hidden buttons
  await page.locator('.search-user-item').first().hover();
  await page.waitForTimeout(1000);

  // Get full HTML of all search-user-item
  const html = await page.evaluate(`
    (function() {
      const items = document.querySelectorAll('.search-user-item');
      return Array.from(items).slice(0, 3).map(el => el.outerHTML.slice(0, 4000));
    })()
  `) as string[];

  for (const h of html) {
    console.log("=== ITEM ===");
    console.log(h);
    console.log("\n");
  }

  await page.screenshot({ path: "/tmp/search-item.png", fullPage: true });
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
