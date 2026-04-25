import { Page } from "playwright";
import { config } from "./config";
import { withPage } from "./browser";

/**
 * Gapo Work UI automation. Selectors are isolated here so the rest of
 * the plugin doesn't churn when Gapo redesigns. Every action:
 *   1. navigates to the right view
 *   2. interacts via test-id-friendly selectors with text fallbacks
 *   3. waits for confirmation (toast / DOM update)
 *
 * IMPORTANT — selectors are placeholders pending real Gapo DOM
 * inspection. Run `pnpm auth` once with a real account, open DevTools
 * on the relevant page, and update SEL_* below. The handlers below
 * surface clear errors when a selector misses so we know exactly which
 * one rotted.
 */

const SEL = {
  // Sidebar search input (top-left typically).
  GLOBAL_SEARCH: '[data-testid="global-search"], input[placeholder*="Tìm"], input[placeholder*="Search"]',
  SEARCH_RESULT_USER: '[data-testid="search-result-user"], a[href*="/u/"]',

  // Open chat with the selected user.
  CHAT_INPUT: '[data-testid="chat-input"], div[contenteditable="true"][role="textbox"]',
  CHAT_SEND_BUTTON: '[data-testid="chat-send"], button[aria-label*="Send"], button[aria-label*="Gửi"]',

  // Message list in a thread.
  MESSAGE_ROW: '[data-testid="message-row"], [data-message-id]',
  MESSAGE_ID_ATTR: "data-message-id",
  MESSAGE_BODY: '[data-testid="message-body"], .message-body, .msg-text',
  MESSAGE_AUTHOR: '[data-testid="message-author"], .msg-author',
  MESSAGE_TIME: '[data-testid="message-time"], time',

  // User profile / status.
  USER_PRESENCE: '[data-testid="presence-indicator"], .presence-online, .presence-offline',
};

export type FoundUser = {
  externalId: string;
  name: string;
  profileUrl: string;
};

export type ThreadMessage = {
  messageId: string;
  body: string;
  authorName: string | null;
  sentAt: string | null;
};

class SelectorMissError extends Error {
  constructor(public selector: string, public stage: string) {
    super(`Gapo selector miss at "${stage}": ${selector}`);
  }
}

async function gotoBase(page: Page): Promise<void> {
  if (!page.url().startsWith(config.gapo.baseUrl)) {
    await page.goto(config.gapo.baseUrl, { waitUntil: "domcontentloaded" });
  }
}

/**
 * Search Gapo for a user by name/keyword. Returns up to 10 matches.
 * Used as fallback when bb-pm has no `channel_identity` row for someone.
 */
export async function gapoFindUser(query: string): Promise<FoundUser[]> {
  if (!query.trim()) return [];
  return withPage(async (page) => {
    await gotoBase(page);
    const search = page.locator(SEL.GLOBAL_SEARCH).first();
    await search.waitFor({ timeout: 8000 }).catch(() => {
      throw new SelectorMissError(SEL.GLOBAL_SEARCH, "global search input");
    });
    await search.fill("");
    await search.type(query, { delay: 30 });
    // Give Gapo's search a moment to debounce + render results.
    await page.waitForTimeout(800);

    const results = page.locator(SEL.SEARCH_RESULT_USER);
    const count = await results.count();
    const out: FoundUser[] = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = results.nth(i);
      const name = (await el.innerText().catch(() => "")).trim();
      const href = (await el.getAttribute("href")) ?? "";
      const externalId = href.split("/").pop() ?? "";
      if (externalId) {
        out.push({ externalId, name, profileUrl: new URL(href, config.gapo.baseUrl).toString() });
      }
    }
    return out;
  });
}

/**
 * Send a DM to a user identified by Gapo external id (the path segment
 * after /u/). Returns the message id Gapo assigns so we can dedupe and
 * upsert into bb-pm `channel_identity` for next-time bot API delivery.
 */
export async function gapoSendDm(externalId: string, text: string): Promise<{ messageId: string | null }> {
  if (!externalId.trim()) throw new Error("externalId required");
  if (!text.trim()) throw new Error("text required");

  return withPage(async (page) => {
    const dmUrl = new URL(`/u/${externalId}`, config.gapo.baseUrl).toString();
    await page.goto(dmUrl, { waitUntil: "domcontentloaded" });

    const input = page.locator(SEL.CHAT_INPUT).first();
    await input.waitFor({ timeout: 8000 }).catch(() => {
      throw new SelectorMissError(SEL.CHAT_INPUT, "chat input");
    });

    await input.click();
    await input.type(text, { delay: 12 });

    const sendBtn = page.locator(SEL.CHAT_SEND_BUTTON).first();
    if ((await sendBtn.count()) > 0) {
      await sendBtn.click();
    } else {
      await input.press("Enter");
    }

    // Wait for the just-sent row to appear in the thread.
    const lastMsg = page.locator(SEL.MESSAGE_ROW).last();
    await lastMsg.waitFor({ timeout: 5000 }).catch(() => null);
    const messageId = (await lastMsg.getAttribute(SEL.MESSAGE_ID_ATTR).catch(() => null)) ?? null;
    return { messageId };
  });
}

/**
 * Read messages in a thread. Used to detect replies for follow-ups so
 * we can flip status REPLIED in bb-pm. `sinceMessageId` lets us only
 * pull new ones — Gapo's UI loads in chunks so we don't accidentally
 * harvest the whole history.
 */
export async function gapoReadThread(
  externalId: string,
  sinceMessageId?: string,
): Promise<ThreadMessage[]> {
  return withPage(async (page) => {
    const dmUrl = new URL(`/u/${externalId}`, config.gapo.baseUrl).toString();
    await page.goto(dmUrl, { waitUntil: "domcontentloaded" });
    await page.locator(SEL.MESSAGE_ROW).first().waitFor({ timeout: 8000 }).catch(() => {
      throw new SelectorMissError(SEL.MESSAGE_ROW, "message row");
    });

    const rows = page.locator(SEL.MESSAGE_ROW);
    const total = await rows.count();
    const out: ThreadMessage[] = [];
    for (let i = 0; i < total; i++) {
      const el = rows.nth(i);
      const messageId = (await el.getAttribute(SEL.MESSAGE_ID_ATTR)) ?? `idx-${i}`;
      if (sinceMessageId && messageId === sinceMessageId) {
        out.length = 0; // restart accumulation from after the marker
        continue;
      }
      const body = (await el.locator(SEL.MESSAGE_BODY).first().innerText().catch(() => "")).trim();
      const authorName =
        (await el.locator(SEL.MESSAGE_AUTHOR).first().innerText().catch(() => "")) || null;
      const sentAt =
        (await el.locator(SEL.MESSAGE_TIME).first().getAttribute("datetime").catch(() => null)) ?? null;
      out.push({ messageId, body, authorName, sentAt });
    }
    return out;
  });
}

/**
 * Best-effort presence check. Returns "online" / "offline" / "unknown"
 * based on the presence pill near the user's avatar.
 */
export async function gapoGetUserStatus(externalId: string): Promise<{ status: "online" | "offline" | "unknown" }> {
  return withPage(async (page) => {
    const profileUrl = new URL(`/u/${externalId}`, config.gapo.baseUrl).toString();
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    const pres = page.locator(SEL.USER_PRESENCE).first();
    if ((await pres.count()) === 0) return { status: "unknown" as const };
    const cls = (await pres.getAttribute("class")) ?? "";
    if (/online/i.test(cls)) return { status: "online" as const };
    if (/offline/i.test(cls)) return { status: "offline" as const };
    return { status: "unknown" as const };
  });
}
