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

  // Open messenger so the full UI is loaded
  await page.goto("https://www.gapowork.vn/messenger/1777432856955", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
  await page.waitForTimeout(3000);

  console.log("=== ALL inputs after hydration ===");
  const inputs = await page.evaluate(`
    (function() {
      return Array.from(document.querySelectorAll("input,textarea,[contenteditable=true]"))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || "",
          placeholder: el.getAttribute("placeholder") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          cls: (typeof el.className === "string" ? el.className : "").slice(0, 80),
          rect: (() => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width)}; })(),
        }));
    })()
  `) as any[];
  inputs.forEach((i, idx) => console.log("[" + idx + "]", JSON.stringify(i)));

  // Look for "Tìm kiếm trong tổ chức" element
  console.log("\n=== Org search hint ===");
  const orgSearch = await page.evaluate(`
    (function() {
      return Array.from(document.querySelectorAll("*"))
        .filter(el => {
          const txt = (el.textContent || "").trim();
          const ph = el.getAttribute("placeholder") || "";
          return (txt === "Tìm kiếm trong tổ chức" || ph.includes("tổ chức")) && txt.length < 50;
        })
        .slice(0, 10)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().slice(0, 50),
          placeholder: el.getAttribute("placeholder") || "",
          cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
          role: el.getAttribute("role") || "",
        }));
    })()
  `);
  console.log(orgSearch);

  // Click the org search and see what changes
  console.log("\n=== Clicking org search ===");
  try {
    const orgBtn = page.locator('text=Tìm kiếm trong tổ chức').first();
    await orgBtn.click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    console.log("Inputs after click:");
    const inputsAfter = await page.evaluate(`
      (function() {
        return Array.from(document.querySelectorAll("input,textarea"))
          .filter(el => el.offsetParent !== null)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || "",
            placeholder: el.getAttribute("placeholder") || "",
            ariaLabel: el.getAttribute("aria-label") || "",
            cls: (typeof el.className === "string" ? el.className : "").slice(0, 80),
          }));
      })()
    `) as any[];
    inputsAfter.forEach((i, idx) => console.log("[" + idx + "]", JSON.stringify(i)));

    // Type "Lực" and see what happens
    const focused = page.locator(':focus').first();
    if (await focused.count() > 0) {
      console.log("\n=== Typing 'Lực' into focused input ===");
      await focused.type("Lực", { delay: 50 });
      await page.waitForTimeout(2500);

      // Check results
      const results = await page.evaluate(`
        (function() {
          const links = Array.from(document.querySelectorAll('a[href*="/messenger/"], a[href*="/u/"], [role=link][href*="/messenger/"]'));
          return links.slice(0, 15).map(a => ({
            href: a.getAttribute("href") || "",
            text: (a.textContent || "").trim().slice(0, 80),
          }));
        })()
      `);
      console.log("Result links:", JSON.stringify(results, null, 2));

      // Also check any clickable item with "Lực" in text
      const lucMatch = await page.evaluate(`
        (function() {
          return Array.from(document.querySelectorAll('[role=button], li, [class*="result"], [class*="item"]'))
            .filter(el => {
              const t = (el.textContent || "");
              return t.includes("Lực") && t.length < 200 && el.offsetParent !== null;
            })
            .slice(0, 10)
            .map(el => ({
              tag: el.tagName,
              text: (el.textContent || "").trim().slice(0, 100),
              cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
              role: el.getAttribute("role") || "",
              href: el.getAttribute("href") || el.querySelector("a")?.getAttribute("href") || "",
            }));
        })()
      `);
      console.log("'Lực' matches:", JSON.stringify(lucMatch, null, 2));
    }
  } catch (e: any) {
    console.log("Org search click failed:", e.message);
  }

  await page.screenshot({ path: "/tmp/gapo-search.png", fullPage: true });
  console.log("\nScreenshot: /tmp/gapo-search.png");
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
