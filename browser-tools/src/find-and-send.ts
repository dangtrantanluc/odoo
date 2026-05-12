import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function main() {
  const query = "Lực";
  const text = "hello m làm việc tới đâu rồi";

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  console.log("1) Open messenger root...");
  await page.goto("https://www.gapowork.vn/messenger/1777432856955", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log("2) Click 'Tìm kiếm trong tổ chức'...");
  await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
  await page.waitForTimeout(1500);

  console.log("3) Type query:", query);
  const orgSearchInput = page.locator('input[placeholder*="Gapowork"]').first();
  await orgSearchInput.waitFor({ timeout: 8000 });
  await orgSearchInput.fill("");
  await orgSearchInput.type(query, { delay: 50 });
  await page.waitForTimeout(2500);

  console.log("4) Locate result + click DM-icon button (last button in item)...");
  const result = page.locator('.search-user-item').filter({ hasText: query }).first();
  await result.waitFor({ timeout: 8000 });
  const matchedText = (await result.textContent())?.trim().slice(0, 60);
  console.log("   Matched:", matchedText);

  // The chat icon is the last <button> inside search-user-item, with
  // border-radius:50% styling. Click it to open DM directly.
  const dmButton = result.locator('button').last();
  await dmButton.click();

  console.log("5) Wait for URL → /messenger/<id>...");
  await page.waitForFunction(
    `window.location.pathname.startsWith("/messenger/") && window.location.pathname !== "/messenger/1777432856955"`,
    { timeout: 15000 },
  ).catch(() => null);

  await page.waitForTimeout(2000);
  const url = page.url();
  console.log("   New URL:", url);

  console.log("6) Wait for chat input...");
  const chatInput = page.locator('[role=textbox][contenteditable=true].public-DraftEditor-content').first();
  await chatInput.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log("7) Type message + Enter:", text);
  await chatInput.click();
  await chatInput.type(text, { delay: 25 });
  await page.waitForTimeout(800);
  await chatInput.press("Enter");
  await page.waitForTimeout(3000);

  console.log("8) Verify message in DOM...");
  const found = await page.evaluate(`
    (function() {
      return Array.from(document.querySelectorAll('*')).filter(el => {
        const t = (el.textContent || "").trim();
        return t.includes("hello m làm việc") && t.length < 200;
      }).length;
    })()
  `);
  console.log("   Matches in DOM:", found);

  await page.screenshot({ path: "/tmp/gapo-luc-sent.png", fullPage: true });
  console.log("\nFinal URL:", url);
  console.log("Screenshot: /tmp/gapo-luc-sent.png");

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
