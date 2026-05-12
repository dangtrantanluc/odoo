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

  // Capture network requests so we can find the API Gapo itself uses
  // for member listing.
  const apiCalls: Array<{ url: string; method: string; status: number; respSize: number }> = [];
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!url.includes("gapowork") && !url.includes("gapo")) return;
    if (!/\.(json|api)|\/api\//i.test(url) && !url.includes("/v1/")) return;
    try {
      const body = await resp.body().catch(() => Buffer.alloc(0));
      apiCalls.push({ url, method: resp.request().method(), status: resp.status(), respSize: body.length });
    } catch { /* ignore */ }
  });

  // Try several candidate URLs that might list org members
  const candidates = [
    "https://www.gapowork.vn/members",
    "https://www.gapowork.vn/organization/members",
    "https://www.gapowork.vn/admin/members",
    "https://www.gapowork.vn/admin/users",
    "https://www.gapowork.vn/workspace/members",
    "https://www.gapowork.vn/o/members",
    "https://www.gapowork.vn/people",
  ];

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(3000);
      const finalUrl = page.url();
      const hasMembers = await page.evaluate(`
        (function() {
          const candidates = document.querySelectorAll('[class*="member"], [class*="Member"], [class*="user-card"], [class*="UserCard"]');
          return candidates.length;
        })()
      `);
      console.log(`${url}\n  → ${finalUrl}\n  member-like elements: ${hasMembers}`);
    } catch (e: any) {
      console.log(`${url}\n  ERROR: ${e.message?.slice(0, 80)}`);
    }
  }

  // Try clicking sidebar "Bluebolt — Thành viên" item if present
  console.log("\n=== Try sidebar 'Thành viên' item ===");
  await page.goto("https://www.gapowork.vn/messenger/0", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const memberLinks = await page.evaluate(`
    (function() {
      const links = Array.from(document.querySelectorAll('a, button'));
      return links
        .filter(el => /thành viên|members|nhân viên/i.test(el.textContent || ''))
        .slice(0, 10)
        .map(el => ({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 50),
          href: el.getAttribute('href') || '',
        }));
    })()
  `);
  console.log("Links containing 'thành viên':");
  console.log(JSON.stringify(memberLinks, null, 2));

  console.log("\n=== Network API calls captured (last 20) ===");
  console.table(apiCalls.slice(-20));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
