import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function main() {
  const browser = await chromium.launch({
    headless: false,  // headed in Xvfb — looks like real browser
  });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  console.log("Goto messenger /...");
  await page.goto("https://www.gapowork.vn/messenger/1777432856955", {
    waitUntil: "domcontentloaded",
  });

  // Wait for SPA to hydrate __next div
  try {
    await page.waitForFunction(
      `document.querySelector("#__next") && document.querySelector("#__next").children.length > 0`,
      { timeout: 30000 },
    );
    console.log("__next hydrated.");
  } catch {
    console.log("__next still empty after 30s. Probably bot-detected.");
  }

  await page.waitForTimeout(5000);
  console.log("URL:", page.url());

  const inputsHtml = await page.evaluate(`
    (function() {
      const els = document.querySelectorAll("input,textarea,[contenteditable=true],[role=textbox]");
      return Array.from(els).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        ce: el.getAttribute("contenteditable") || "",
        role: el.getAttribute("role") || "",
        testid: el.getAttribute("data-testid") || "",
        cls: (typeof el.className === "string" ? el.className : "").slice(0, 80),
        visible: el.offsetParent !== null,
      }));
    })()
  `) as any[];
  console.log("\n=== ALL inputs ===");
  inputsHtml.forEach((i, idx) => console.log("[" + idx + "]", JSON.stringify(i)));

  await page.screenshot({ path: "/tmp/gapo-msg.png", fullPage: true });
  console.log("\nScreenshot: /tmp/gapo-msg.png");
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
