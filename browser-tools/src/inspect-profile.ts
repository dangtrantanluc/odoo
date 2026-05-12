import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";

loadEnv();

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: config.browser.storageStatePath,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.goto("https://www.gapowork.vn/608678190", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);

  console.log("URL:", page.url());

  const buttons = await page.evaluate(`
    (function() {
      return Array.from(document.querySelectorAll("button, a, [role=button]"))
        .filter(el => el.offsetParent !== null)
        .slice(0, 100)
        .map(el => ({
          tag: el.tagName,
          text: (el.textContent || "").trim().slice(0, 50),
          href: el.getAttribute("href") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
        }))
        .filter(b => /tin|nhắn|message|chat/i.test(b.text + b.ariaLabel));
    })()
  `);
  console.log("\n=== Message-related buttons ===");
  console.log(JSON.stringify(buttons, null, 2));

  await page.screenshot({ path: "/tmp/luc-profile.png", fullPage: true });
  console.log("Screenshot: /tmp/luc-profile.png");
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
