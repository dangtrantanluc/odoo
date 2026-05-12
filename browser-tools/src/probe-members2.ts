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

  await page.goto("https://www.gapowork.vn/messenger/0", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  console.log("=== Click 'Bluebolt Thành viên' button ===");
  try {
    await page.locator('button:has-text("Bluebolt"), button:has-text("Thành viên")').first().click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    console.log("URL after click:", page.url());

    const dropdown = await page.evaluate(`
      (function() {
        const links = document.querySelectorAll('a, button, [role="menuitem"]');
        return Array.from(links).slice(0, 20).map(el => ({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 60),
          href: el.getAttribute('href') || '',
        })).filter(x => x.text);
      })()
    `);
    console.log("Visible items after click:");
    console.log(JSON.stringify(dropdown, null, 2));
  } catch (e: any) {
    console.log("Click error:", e.message);
  }

  console.log("\n=== Test org search with each Vietnamese surname (iterate to get all members) ===");
  const surnames = ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Vũ", "Đặng", "Bùi", "Đỗ", "Hồ", "Ngô", "Dương", "Lý", "Võ", "Trương", "Phan"];

  // Open org search modal once
  await page.goto("https://www.gapowork.vn/messenger/0", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
  await page.waitForTimeout(1500);

  const orgInput = page.locator('input[placeholder*="Gapowork"]').first();
  const allMembers = new Map<string, any>();

  for (const surname of surnames) {
    try {
      await orgInput.fill("");
      await orgInput.type(surname, { delay: 20 });
      await page.waitForTimeout(1500);

      const items = await page.evaluate(`
        (function() {
          const els = document.querySelectorAll('.search-user-item');
          return Array.from(els).map(el => {
            const html = el.outerHTML;
            const nameEl = el.querySelector('.name, [class*="name"]');
            const name = nameEl ? (nameEl.textContent || '').trim() : '';
            // Try to extract department + position from spans
            const spans = Array.from(el.querySelectorAll('div'));
            const texts = spans.map(s => (s.textContent || '').trim()).filter(t => t.length > 0 && t.length < 60);
            return { name: name.slice(0, 80), allTexts: texts.slice(0, 8) };
          });
        })()
      `) as Array<{ name: string; allTexts: string[] }>;

      for (const item of items) {
        if (item.name && !allMembers.has(item.name)) {
          allMembers.set(item.name, item);
        }
      }
      console.log(`  ${surname}: +${items.length} → total ${allMembers.size}`);
    } catch (e: any) {
      console.log(`  ${surname}: error ${e.message?.slice(0, 50)}`);
    }
  }

  console.log(`\n=== TOTAL UNIQUE MEMBERS FOUND: ${allMembers.size} ===`);
  for (const [name, item] of allMembers) {
    console.log(`  • ${name} | ${item.allTexts.slice(0, 4).join(' | ')}`);
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
