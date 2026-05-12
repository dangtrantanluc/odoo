/**
 * Bulk-scrape all Gapo Work organization members.
 *
 * Strategy:
 *   1. Open the org-wide search modal (Tìm kiếm trong tổ chức)
 *   2. Type each common Vietnamese surname + a-z fallback
 *   3. Scrape `.search-user-item` for name + department + position
 *   4. Dedup by name
 *   5. For each unique member, click DM icon → capture conversationId
 *      from URL → close modal → repeat
 *   6. Output JSON ready for bulk insert into bb-pm
 *
 * Output: /tmp/gapo-members.json
 */

import { chromium, Page } from "playwright";
import * as fs from "node:fs";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

interface ScrapedMember {
  name: string;
  workspace: string;
  department: string;
  position: string;
  conversationId: string;
}

const VIETNAMESE_SURNAMES = [
  "Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Vũ", "Đặng", "Bùi", "Đỗ", "Hồ",
  "Ngô", "Dương", "Lý", "Võ", "Trương", "Phan", "Trịnh", "Đinh", "Mai",
  "Châu", "Hà", "Cao", "Lưu", "Lương", "Tô", "Tạ", "Quách", "Đoàn", "Chung",
  "Thái", "Triệu", "Lâm", "Tiên", "Thư", "Trợ", "Khánh", "Huỳnh", "Dani",
  "Kỳ",
];

// Single-letter fallback to catch users whose names don't start with a
// common Vietnamese surname (English names, secretary accounts, etc.).
const FALLBACK = "abcdefghijklmnopqrstuvwxyz".split("");

async function openOrgSearch(page: Page): Promise<void> {
  await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
  await page.locator('input[placeholder*="Gapowork"]').first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
}

async function closeOrgSearch(page: Page): Promise<void> {
  // Close by pressing Escape
  await page.keyboard.press("Escape").catch(() => null);
  await page.waitForTimeout(500);
}

async function searchAndScrape(page: Page, query: string): Promise<Array<{ name: string; workspace: string; department: string; position: string }>> {
  const input = page.locator('input[placeholder*="Gapowork"]').first();
  await input.fill("");
  await input.type(query, { delay: 15 });
  await page.waitForTimeout(1200);

  return await page.evaluate(`
    (function() {
      const items = document.querySelectorAll('.search-user-item');
      return Array.from(items).map(el => {
        const nameEl = el.querySelector('.name, [class*="name"]');
        const name = nameEl ? (nameEl.textContent || '').trim() : '';
        // The 3 inner buttons hold workspace, department, position
        const buttons = Array.from(el.querySelectorAll('button')).filter(b => {
          const t = (b.textContent || '').trim();
          return t.length > 0 && t.length < 50 && !b.querySelector('img');
        });
        const labels = buttons.map(b => (b.textContent || '').trim());
        return {
          name: name.slice(0, 80),
          workspace: labels[0] || '',
          department: labels[1] || '',
          position: labels[2] || '',
        };
      }).filter(x => x.name);
    })()
  `) as Array<{ name: string; workspace: string; department: string; position: string }>;
}

async function getConversationIdForUser(page: Page, query: string): Promise<string | null> {
  // Open search if not already open (best-effort)
  try {
    const inputCount = await page.locator('input[placeholder*="Gapowork"]').count();
    if (inputCount === 0) {
      await openOrgSearch(page);
    }
  } catch {}

  const input = page.locator('input[placeholder*="Gapowork"]').first();
  await input.fill("");
  await input.type(query, { delay: 15 });
  await page.waitForTimeout(1500);

  const result = page.locator('.search-user-item').filter({ hasText: query }).first();
  if ((await result.count()) === 0) return null;

  // Click the DM icon (last button in the item)
  await result.locator('button').last().click();

  // Wait for URL to change to /messenger/<id>
  try {
    await page.waitForFunction(
      `window.location.pathname.startsWith("/messenger/") && window.location.pathname !== "/messenger/0"`,
      { timeout: 10000 },
    );
  } catch {
    return null;
  }

  const url = page.url();
  const match = url.match(/\/messenger\/(\d+)/);
  return match ? match[1] : null;
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // ── PHASE 1: Enumerate all unique members ─────────────────────────
  console.log("=== Phase 1: enumerate members via surname + alphabet search ===");
  await page.goto("https://www.gapowork.vn/messenger/0", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('a[href*="/messenger/"]', { timeout: 30000 });
  await page.waitForTimeout(1500);

  await openOrgSearch(page);

  const allMembers = new Map<string, { name: string; workspace: string; department: string; position: string }>();
  const queries = [...VIETNAMESE_SURNAMES, ...FALLBACK];
  for (const q of queries) {
    try {
      const results = await searchAndScrape(page, q);
      let added = 0;
      for (const r of results) {
        if (!allMembers.has(r.name)) {
          allMembers.set(r.name, r);
          added++;
        }
      }
      if (added > 0) console.log(`  "${q}": +${added} → total ${allMembers.size}`);
    } catch (e: any) {
      console.log(`  "${q}": error ${e.message?.slice(0, 50)}`);
    }
  }
  await closeOrgSearch(page);
  console.log(`\nTotal unique: ${allMembers.size}`);

  // ── PHASE 2: For each member, get conversationId by clicking DM ───
  console.log("\n=== Phase 2: capture conversationId per member ===");
  const out: ScrapedMember[] = [];
  let i = 0;
  for (const [name, info] of allMembers) {
    i++;
    try {
      // Always start from neutral root for clean state
      await page.goto("https://www.gapowork.vn/messenger/0", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      await openOrgSearch(page);

      const cid = await getConversationIdForUser(page, name);
      if (cid) {
        out.push({ ...info, conversationId: cid });
        console.log(`  [${i}/${allMembers.size}] ${name} → cid=${cid} | ${info.department} / ${info.position}`);
      } else {
        console.log(`  [${i}/${allMembers.size}] ${name} → NO CID (search miss or click failed)`);
      }
    } catch (e: any) {
      console.log(`  [${i}/${allMembers.size}] ${name} → error ${e.message?.slice(0, 60)}`);
    }
  }

  // ── Save output ───────────────────────────────────────────────────
  const outFile = "/tmp/gapo-members.json";
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\n✓ Saved ${out.length} members → ${outFile}`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
