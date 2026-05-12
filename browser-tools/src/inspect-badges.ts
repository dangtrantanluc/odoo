import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function main() {
  // Connect to existing Chromium via CDP if possible, else launch fresh
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto("https://www.gapowork.vn/messenger/1777432856955", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
  await page.waitForTimeout(3000);

  const sidebarItems = await page.evaluate(`
    (function() {
      const links = document.querySelectorAll('a[href*="/messenger/"]');
      return Array.from(links).map(link => {
        const href = link.getAttribute('href') || '';
        const cid = href.split('/messenger/')[1]?.split(/[?#]/)[0] || '';
        const name = (link.querySelector('.name, [class*="name"]')?.textContent || '').trim().slice(0, 30);
        const badge = link.querySelector('[class*="unread"], [class*="Badge"], [class*="badge"]');
        const badgeText = badge ? (badge.textContent || '').trim() : '';
        return { cid, name, badgeText, hasBadge: !!badge };
      }).filter(x => x.cid);
    })()
  `) as Array<{cid: string; name: string; badgeText: string; hasBadge: boolean}>;

  console.log("=== Sidebar conversations seen by bot's page ===");
  console.table(sidebarItems);

  console.log("\n=== Conversations WITH unread badge ===");
  const unread = sidebarItems.filter(x => x.hasBadge && /^\d+\+?$/.test(x.badgeText));
  console.log(unread.length === 0 ? "NONE" : JSON.stringify(unread, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
