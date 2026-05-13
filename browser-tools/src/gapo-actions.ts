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

// Gapo Work selectors — verified 2026-04-29 against gapowork.vn live DOM.
// SPA powered by Next.js + Draft.js for chat editor. Bot-detection means
// headless mode fails to hydrate; runtime must launch headed in Xvfb.
const SEL = {
  // Sidebar search input on /messenger pages.
  GLOBAL_SEARCH: 'input.gapo-InputField[placeholder="Tìm kiếm"]',
  SEARCH_RESULT_USER: 'a[href*="/messenger/"], a[href*="/u/"]',

  // Draft.js editor in messenger conversation pane.
  CHAT_INPUT: '[role="textbox"][contenteditable="true"].public-DraftEditor-content',
  CHAT_SEND_BUTTON: 'button[aria-label*="Gửi"], button[aria-label*="Send"]',

  // Message list — Gapo doesn't expose stable testids; lean on Draft.js
  // markup conventions and fall back to time element.
  MESSAGE_ROW: '[data-message-id], [class*="MessageItem"], [class*="message-item"]',
  MESSAGE_ID_ATTR: "data-message-id",
  MESSAGE_BODY: '[class*="MessageBody"], [class*="message-body"]',
  MESSAGE_AUTHOR: '[class*="MessageAuthor"], [class*="message-author"]',
  MESSAGE_TIME: "time",

  // User profile / status — placeholder, refine when needed.
  USER_PRESENCE: '[class*="presence"]',
};

// Gapo addresses recipients via numeric ids. Two URL shapes:
//   - DM 1-1:    /messenger/<conversationId>
//   - Group:     /collab/<collabId>/chat
// Caller can pass either a bare numeric id (we'll guess based on length —
// not ideal) or a prefixed form "dm:<id>" / "collab:<id>" (preferred).
const GAPO_BASE_URL = config.gapo.baseUrl.replace(/\/$/, "");

function buildConversationUrl(idOrPrefixed: string): string {
  if (idOrPrefixed.startsWith("collab:")) {
    return `${GAPO_BASE_URL}/collab/${encodeURIComponent(idOrPrefixed.slice(7))}/chat`;
  }
  if (idOrPrefixed.startsWith("dm:")) {
    return `${GAPO_BASE_URL}/messenger/${encodeURIComponent(idOrPrefixed.slice(3))}`;
  }
  // Bare id — default to DM (back-compat for existing send-dm callers).
  return `${GAPO_BASE_URL}/messenger/${encodeURIComponent(idOrPrefixed)}`;
}

const messengerUrl = (id: string): string => buildConversationUrl(id);

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
  if (!page.url().startsWith(GAPO_BASE_URL)) {
    await page.goto(GAPO_BASE_URL, { waitUntil: "domcontentloaded" });
  }
}

/**
 * Search Gapo for a user by name/keyword via the "Tìm kiếm trong tổ chức"
 * org-wide search modal. Returns up to 10 matches with their display names.
 *
 * Flow (verified 2026-04-29):
 *   1. Open messenger (search modal only available there)
 *   2. Click "Tìm kiếm trong tổ chức" button → modal opens
 *   3. Type query into "Tìm kiếm trên Gapowork" input
 *   4. Wait for `.search-user-item` results to render
 *   5. Scrape name from each (Gapo doesn't expose conversationId here —
 *      caller must click the DM-icon button to get the cid via URL change).
 *
 * The conversation id is NOT available without clicking. Use
 * `gapoFindAndOpenDm` if you need the cid for sending a follow-up.
 */
const MESSENGER_SEED_URL = `${GAPO_BASE_URL}/messenger/1777432856955`;

export async function gapoFindUser(query: string): Promise<FoundUser[]> {
  if (!query.trim()) return [];
  return withPage(async (page) => {
    await page.goto(MESSENGER_SEED_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
    await page.waitForTimeout(800);

    await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
    const orgInput = page.locator('input[placeholder*="Gapowork"]').first();
    await orgInput.waitFor({ timeout: 8000 }).catch(() => {
      throw new SelectorMissError("input[placeholder*=Gapowork]", "org search input");
    });

    await orgInput.fill("");
    await orgInput.type(query, { delay: 20 });
    // Gapo typically renders results within ~500ms; allow some headroom.
    await page.locator('.search-user-item').first().waitFor({ timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(400);

    const items = page.locator('.search-user-item');
    const count = await items.count();
    const out: FoundUser[] = [];
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = items.nth(i);
      const fullText = (await el.textContent().catch(() => "") ?? "").trim();
      // search-user-item textContent looks like "Đặng Trần Tấn LựcBlueboltAI..."
      // Best-effort: take only the highlighted name span if present.
      const nameEl = el.locator('.name, [class*="name"]').first();
      const name = (await nameEl.textContent().catch(() => "") ?? "").trim() || fullText.slice(0, 50);
      out.push({
        externalId: "",       // Gapo doesn't expose cid in search results
        name,
        profileUrl: "",       // we'd have to click to get the URL
      });
    }
    return out;
  });
}

/**
 * Search + click the DM icon to open the conversation, return the
 * conversationId from the URL. One-shot helper for "find and message".
 */
export async function gapoFindAndOpenDm(query: string): Promise<{ conversationId: string; name: string } | null> {
  if (!query.trim()) return null;
  return withPage(async (page) => {
    await page.goto(MESSENGER_SEED_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 30000 });
    await page.waitForTimeout(800);

    await page.locator('button:has-text("Tìm kiếm trong tổ chức")').first().click();
    const orgInput = page.locator('input[placeholder*="Gapowork"]').first();
    await orgInput.waitFor({ timeout: 8000 });
    await orgInput.type(query, { delay: 20 });

    const result = page.locator('.search-user-item').filter({ hasText: query }).first();
    await result.waitFor({ timeout: 8000 }).catch(() => null);
    if ((await result.count()) === 0) return null;

    const name = ((await result.locator('.name, [class*="name"]').first().textContent().catch(() => "")) ?? "").trim();

    // Click the round DM-icon button (always the last <button> in the item).
    await result.locator('button').last().click();
    await page.waitForFunction(
      `window.location.pathname.startsWith("/messenger/") && window.location.pathname !== "/messenger/1777432856955"`,
      { timeout: 15000 },
    ).catch(() => null);

    const url = page.url();
    const match = url.match(/\/messenger\/(\d+)/);
    if (!match) return null;
    return { conversationId: match[1], name: name || query };
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
    await page.goto(messengerUrl(externalId), { waitUntil: "domcontentloaded" });

    // If a thread/reply side panel is open from a previous interaction,
    // close it first — otherwise our `.first()` chat-input locator may pick
    // the panel's editor instead of the main composer, sending the reply
    // into a thread reply rather than the main chat.
    await page.keyboard.press("Escape").catch(() => null);
    await page.waitForTimeout(300);

    // Draft.js editor needs the SPA to fully hydrate before it mounts.
    // Up to 30s — Gapo's first paint is slow when the conversation has
    // unread history; subsequent loads are <5s.
    // Use `.last()` because when multiple Draft.js editors exist (rare —
    // happens when a thread panel is half-open), the main composer is
    // typically rendered last in the DOM tree.
    const input = page.locator(SEL.CHAT_INPUT).last();
    await input.waitFor({ timeout: 30000 }).catch(() => {
      throw new SelectorMissError(SEL.CHAT_INPUT, "chat input");
    });

    // Pause briefly so Draft.js focus handlers and websocket subscription
    // are wired up — typing earlier sometimes drops the first chars.
    await page.waitForTimeout(800);

    await input.click();
    await input.type(text, { delay: 25 });

    const sendBtn = page.locator(SEL.CHAT_SEND_BUTTON).first();
    if ((await sendBtn.count()) > 0) {
      await sendBtn.click();
    } else {
      await input.press("Enter");
    }

    // Best-effort capture of the message id; not all Gapo views expose it.
    await page.waitForTimeout(1500);
    const lastMsg = page.locator(SEL.MESSAGE_ROW).last();
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
    await page.goto(messengerUrl(externalId), { waitUntil: "domcontentloaded" });
    await page.locator(SEL.MESSAGE_ROW).first().waitFor({ timeout: 30000 }).catch(() => {
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
    await page.goto(messengerUrl(externalId), { waitUntil: "domcontentloaded" });
    const pres = page.locator(SEL.USER_PRESENCE).first();
    if ((await pres.count()) === 0) return { status: "unknown" as const };
    const cls = (await pres.getAttribute("class")) ?? "";
    if (/online/i.test(cls)) return { status: "online" as const };
    if (/offline/i.test(cls)) return { status: "offline" as const };
    return { status: "unknown" as const };
  });
}
