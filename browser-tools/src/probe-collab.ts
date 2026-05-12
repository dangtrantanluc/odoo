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

  // Open collab chat URL
  const url = "https://www.gapowork.vn/collab/7008534052395853824/chat";
  console.log("Goto:", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  console.log("Final URL:", page.url());
  console.log("Title:", await page.title());

  // Inspect sidebar links — see ALL conversation patterns
  const links = await page.evaluate(`
    (function() {
      const all = document.querySelectorAll('a[href*="/messenger/"], a[href*="/collab/"]');
      return Array.from(all).slice(0, 30).map(a => {
        const href = a.getAttribute('href') || '';
        const txt = (a.textContent || '').trim().slice(0, 40);
        const badge = a.querySelector('[class*="unread"], [class*="Badge"], [class*="badge"]');
        const badgeTxt = badge ? (badge.textContent || '').trim() : '';
        return { href, text: txt, badge: badgeTxt };
      });
    })()
  `) as Array<{href: string; text: string; badge: string}>;

  console.log("\n=== Sidebar links (messenger + collab) ===");
  console.table(links);

  // Inspect chat input
  const inputs = await page.evaluate(`
    (function() {
      const els = document.querySelectorAll('input,textarea,[contenteditable=true]');
      return Array.from(els).filter(el => el.offsetParent !== null).map(el => ({
        tag: el.tagName.toLowerCase(),
        placeholder: el.getAttribute('placeholder') || '',
        role: el.getAttribute('role') || '',
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
      }));
    })()
  `);
  console.log("\n=== Visible inputs ===");
  console.log(JSON.stringify(inputs, null, 2));

  // Check if URL is group chat (multiple members) vs DM
  const headerText = await page.evaluate(`
    (function() {
      const candidates = document.querySelectorAll('header, [class*="Header"], [class*="header"]');
      const out = [];
      for (const el of candidates) {
        const txt = (el.textContent || '').trim();
        if (txt.length > 0 && txt.length < 200) out.push(txt.slice(0, 100));
      }
      return out.slice(0, 5);
    })()
  `);
  console.log("\n=== Header texts ===");
  console.log(headerText);

  await page.screenshot({ path: "/tmp/collab.png", fullPage: true });
  console.log("\nScreenshot: /tmp/collab.png");
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
