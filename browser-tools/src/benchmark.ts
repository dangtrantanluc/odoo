import { chromium, Browser, BrowserContext, Page } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

const TIMINGS: Record<string, number> = {};
const T0 = Date.now();

function tick(label: string, sinceLabel?: string): void {
  const now = Date.now();
  const since = sinceLabel ? TIMINGS[sinceLabel] : T0;
  const ms = now - since;
  TIMINGS[label] = now;
  const sinceTxt = sinceLabel ? `(+${ms}ms after ${sinceLabel})` : `(${ms}ms total)`;
  console.log(`[${(now - T0).toString().padStart(6, " ")}ms] ${label.padEnd(40)} ${sinceTxt}`);
}

async function main() {
  const query = "Lực";
  const text = `bench ${Date.now() % 100000}`;

  tick("0_start");

  const browser: Browser = await chromium.launch({ headless: false });
  tick("1_chromium_launched", "0_start");

  const context: BrowserContext = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  tick("2_context_ready", "1_chromium_launched");

  const page: Page = await context.newPage();
  tick("3_page_ready", "2_context_ready");

  await page.goto("https://www.gapowork.vn/messenger/1777432856955", { waitUntil: "domcontentloaded" });
  tick("4_messenger_root_loaded", "3_page_ready");

  await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
  tick("5_initial_chat_input_visible", "4_messenger_root_loaded");

  // small settle
  await page.waitForTimeout(800);
  tick("6_after_settle_800ms", "5_initial_chat_input_visible");

  await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
  tick("7_org_search_btn_clicked", "6_after_settle_800ms");

  const orgInput = page.locator('input[placeholder*="Gapowork"]').first();
  await orgInput.waitFor({ timeout: 8000 });
  tick("8_org_search_input_visible", "7_org_search_btn_clicked");

  await orgInput.type(query, { delay: 50 });
  tick("9_query_typed", "8_org_search_input_visible");

  // Wait for results — use selector wait instead of fixed timeout
  await page.locator('.search-user-item').filter({ hasText: query }).first().waitFor({ timeout: 10000 });
  tick("10_results_rendered", "9_query_typed");

  const result = page.locator('.search-user-item').filter({ hasText: query }).first();
  const dmButton = result.locator('button').last();
  await dmButton.click();
  tick("11_dm_button_clicked", "10_results_rendered");

  // Wait for URL change to NEW conversation
  await page.waitForFunction(
    `window.location.pathname.startsWith("/messenger/") && window.location.pathname !== "/messenger/1777432856955"`,
    { timeout: 15000 },
  );
  tick("12_url_changed", "11_dm_button_clicked");

  const chatInput = page.locator('[role=textbox][contenteditable=true].public-DraftEditor-content').first();
  await chatInput.waitFor({ timeout: 30000 });
  tick("13_target_chat_input_visible", "12_url_changed");

  await page.waitForTimeout(1000);
  tick("14_settle_1s", "13_target_chat_input_visible");

  await chatInput.click();
  await chatInput.type(text, { delay: 25 });
  tick("15_message_typed", "14_settle_1s");

  await chatInput.press("Enter");
  tick("16_enter_pressed", "15_message_typed");

  // Wait for the message bubble to appear (look for our exact text in DOM)
  await page.waitForFunction(
    `Array.from(document.querySelectorAll('*')).some(el => (el.textContent || '').includes('${text}'))`,
    { timeout: 10000 },
  );
  tick("17_message_visible_in_dom", "16_enter_pressed");

  await browser.close();
  tick("18_browser_closed", "17_message_visible_in_dom");

  // Summary
  console.log("\n=== SUMMARY ===");
  const phases: Array<[string, string, string]> = [
    ["Cold start (launch+context+goto)", "0_start", "4_messenger_root_loaded"],
    ["Initial SPA hydration", "4_messenger_root_loaded", "5_initial_chat_input_visible"],
    ["Open org search modal", "6_after_settle_800ms", "8_org_search_input_visible"],
    ["Type query + render results", "8_org_search_input_visible", "10_results_rendered"],
    ["Click DM + URL change", "10_results_rendered", "12_url_changed"],
    ["New conversation hydration", "12_url_changed", "13_target_chat_input_visible"],
    ["Type + send + confirm", "14_settle_1s", "17_message_visible_in_dom"],
  ];
  for (const [label, from, to] of phases) {
    const ms = TIMINGS[to] - TIMINGS[from];
    console.log(label.padEnd(45) + ms.toString().padStart(6) + " ms");
  }
  console.log("─".repeat(55));
  console.log("TOTAL".padEnd(45) + (TIMINGS["17_message_visible_in_dom"] - T0).toString().padStart(6) + " ms");
}

main().catch(e => { console.error(e); process.exit(1); });
