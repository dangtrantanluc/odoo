/**
 * Manual auth flow. Run once with a real Gapo account:
 *
 *   pnpm auth
 *
 * Launches a HEADED Chromium pointed at Gapo Work's login page, lets you
 * sign in interactively (including 2FA), then saves cookies +
 * localStorage to BROWSER_STORAGE_STATE so subsequent headless runs
 * don't need to log in again.
 *
 * Re-run when the session expires (Gapo rotates cookies; symptoms are
 * 401s on selectors that previously worked).
 */

import { chromium } from "playwright";
import { loadEnv } from "./env";
import { config } from "./config";
import * as path from "node:path";
import * as fs from "node:fs";

loadEnv();

async function main() {
  const browser = await chromium.launch({
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext({
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  await page.goto(config.gapo.baseUrl, { waitUntil: "domcontentloaded" });

  console.log("\n" + "─".repeat(72));
  console.log("Đăng nhập Gapo Work trong cửa sổ Chromium vừa mở.");
  console.log("Sau khi vào được trang chủ (đọc được tin nhắn), QUAY LẠI terminal");
  console.log("và bấm ENTER để lưu storage state.");
  console.log("─".repeat(72) + "\n");

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  const target = config.browser.storageStatePath;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await context.storageState({ path: target });
  console.log(`✔ Saved storage state → ${target}`);

  await browser.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
