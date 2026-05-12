import { chromium, BrowserContext, Page } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function findAndSend(context: BrowserContext, query: string, text: string, runLabel: string) {
  const t0 = Date.now();
  const phases: Record<string, number> = { _start: t0 };
  const tick = (k: string) => phases[k] = Date.now();

  const page: Page = await context.newPage();
  tick("page_ready");

  await page.goto("https://www.gapowork.vn/messenger/1777432856955", { waitUntil: "domcontentloaded" });
  tick("messenger_loaded");

  await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
  tick("hydrated");

  await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
  await page.locator('input[placeholder*="Gapowork"]').first().waitFor({ timeout: 8000 });
  tick("org_search_open");

  const orgInput = page.locator('input[placeholder*="Gapowork"]').first();
  await orgInput.type(query, { delay: 50 });
  await page.locator('.search-user-item').filter({ hasText: query }).first().waitFor({ timeout: 10000 });
  tick("results_ready");

  const result = page.locator('.search-user-item').filter({ hasText: query }).first();
  await result.locator('button').last().click();
  await page.waitForFunction(
    `window.location.pathname.startsWith("/messenger/") && window.location.pathname !== "/messenger/1777432856955"`,
    { timeout: 15000 },
  );
  tick("url_changed");

  const chatInput = page.locator('[role=textbox][contenteditable=true].public-DraftEditor-content').first();
  await chatInput.waitFor({ timeout: 30000 });
  tick("target_input_ready");

  await chatInput.click();
  await chatInput.type(text, { delay: 25 });
  await chatInput.press("Enter");
  await page.waitForFunction(
    `Array.from(document.querySelectorAll('*')).some(el => (el.textContent || '').includes('${text}'))`,
    { timeout: 10000 },
  );
  tick("sent_confirmed");

  await page.close();
  tick("done");

  const total = phases.done - t0;
  console.log(`\n=== ${runLabel} (total ${total} ms) ===`);
  const order = ["page_ready", "messenger_loaded", "hydrated", "org_search_open", "results_ready", "url_changed", "target_input_ready", "sent_confirmed", "done"];
  let prev = t0;
  for (const k of order) {
    const ms = phases[k] - prev;
    console.log(`  ${k.padEnd(20)} +${ms}ms`);
    prev = phases[k];
  }
  return total;
}

async function main() {
  const t0 = Date.now();
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  console.log(`Browser ready in ${Date.now() - t0}ms\n`);

  const t1 = await findAndSend(context, "Lực", `bench warm-1 ${Date.now() % 100000}`, "RUN 1 cold-page");
  const t2 = await findAndSend(context, "Lực", `bench warm-2 ${Date.now() % 100000}`, "RUN 2 warm-context");
  const t3 = await findAndSend(context, "Lực", `bench warm-3 ${Date.now() % 100000}`, "RUN 3 warm-context");

  await browser.close();
  console.log(`\n=== TOTALS ===`);
  console.log(`Cold-page run:    ${t1} ms`);
  console.log(`Warm run 2:       ${t2} ms`);
  console.log(`Warm run 3:       ${t3} ms`);
  console.log(`Improvement:      ${Math.round((1 - t3/t1) * 100)}% faster after warm-up`);
}

main().catch(e => { console.error(e); process.exit(1); });
