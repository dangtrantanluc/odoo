import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function main() {
  const conversationId = "1777432856955";
  const text = "Nhơn";

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const url = `https://www.gapowork.vn/messenger/${conversationId}`;
  console.log("Navigating:", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Wait for Draft.js editor
  console.log("Waiting for chat input...");
  const input = page.locator('[role=textbox][contenteditable=true]').first();
  await input.waitFor({ timeout: 30000 });
  console.log("Input ready.");

  await page.waitForTimeout(2000);

  console.log("Clicking + typing:", text);
  await input.click();
  await input.type(text, { delay: 30 });

  await page.waitForTimeout(1000);

  console.log("Pressing Enter to send...");
  await input.press("Enter");

  await page.waitForTimeout(3000);

  console.log("Done. Checking last message in thread...");
  // Try to find the just-sent message
  const lastMsg = await page.evaluate(`
    (function() {
      const all = Array.from(document.querySelectorAll("*")).filter(el => {
        const txt = (el.textContent || "").trim();
        return txt.length > 0 && txt.length < 200 && txt.includes("Nhơn");
      });
      return all.slice(-3).map(el => ({
        tag: el.tagName,
        text: (el.textContent || "").trim().slice(0, 50),
      }));
    })()
  `);
  console.log("Recent matches:", lastMsg);

  await page.screenshot({ path: "/tmp/gapo-after-send.png", fullPage: true });
  console.log("Screenshot: /tmp/gapo-after-send.png");

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
