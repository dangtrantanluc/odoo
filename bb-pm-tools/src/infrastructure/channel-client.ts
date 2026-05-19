import fetch from "node-fetch";
import { config } from "../shared/config";

const CHANNEL_IO_LOG = (process.env.BB_PM_CHANNEL_IO_LOG ?? "true").toLowerCase() !== "false";
const CHANNEL_IO_LOG_MAX_CHARS = Number(process.env.BB_PM_CHANNEL_IO_LOG_MAX_CHARS ?? 2000);

function truncateForChannelLog(value: string, max = CHANNEL_IO_LOG_MAX_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function channelLog(event: string, fields: Record<string, unknown>) {
  if (!CHANNEL_IO_LOG) return;
  const payload = { ts: new Date().toISOString(), event, ...fields };
  try {
    console.log(`[bb-pm-tools/channel-io] ${truncateForChannelLog(JSON.stringify(payload))}`);
  } catch {
    console.log(`[bb-pm-tools/channel-io] ${event}`);
  }
}

/**
 * Strip markdown markers Gapo Work không render được. LLM hay sinh `**bold**`,
 * `__under__`, headers `## `, `~~strike~~`, backtick `` `code` `` — Gapo
 * hiển thị raw ký tự, trông xấu. Bỏ marker, giữ nguyên text bên trong.
 *
 * Cố ý KHÔNG strip `*italic*` (single asterisk) vì conflict với bullet `* `
 * và risk phá tên file/ký hiệu user gõ.
 *
 * 2026-05-07 — Strip fenced code blocks (```...```) hoàn toàn (bao gồm cả body).
 * Trước Qwen hallucinate tool_calls dạng ```json {"tool":"search_tasks",...}```
 * bị coi là final content → Gapo render raw cục JSON, leak userId/email cho user.
 * Fenced block trong chat reply gần như luôn là noise, drop thẳng tay.
 */
export function stripMarkdownForGapo(text: string): string {
  if (!text) return text;
  return text
    .replace(/```[\w-]*\s*[\s\S]*?```/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`\n]+?)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(^|[\s(])#\d+\s*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Admin alert helper. Khi cron / scheduler / critical path fail, gửi tin
 * vào ADMIN_ALERT_TARGET channel để admin biết và investigate. Silent skip
 * nếu chưa config (dev environment, không spam).
 *
 * Auto-prefix "[ALERT]" và truncate context để tránh tin quá dài.
 * Throw không catch — fail-safe nếu Gapo cũng down (caller log warn).
 */
export async function notifyAdmin(context: string, error: unknown): Promise<void> {
  const target = config.adminAlert.target;
  if (!target) return; // disabled in dev
  const errMsg = error instanceof Error ? error.message : String(error);
  const text = `🚨 [ALERT] ${context}\n${errMsg.slice(0, 400)}`;
  try {
    await sendToGapo(target, text);
  } catch (notifyErr: any) {
    console.error(
      `[bb-pm-tools] notifyAdmin failed: ${notifyErr?.message ?? notifyErr} (original: ${errMsg.slice(0, 200)})`,
    );
  }
}

/**
 * Outbound channel port — posts a message into a Gapo conversation by
 * calling the gapo-agent plugin's /send endpoint. bb-pm-tools does not hold
 * Gapo credentials itself; gapo-agent owns that surface.
 */
export async function sendToGapo(conversationId: string, text: string): Promise<void> {
  return await sendGapoBody(conversationId, { type: "text", text });
}

export async function sendQuickRepliesToGapo(
  conversationId: string,
  text: string,
  options: Array<{ title: string; payload: string }>,
): Promise<void> {
  return await sendGapoBody(conversationId, {
    type: "quick_replies",
    text,
    metadata: { options },
  });
}

export async function sendMentionTextToGapo(
  conversationId: string,
  args: { text: string; mentionName: string; targetUserId: string },
): Promise<void> {
  return await sendGapoBody(conversationId, {
    type: "text",
    text: `[@${args.mentionName}](https://www.gapowork.vn/profile/${args.targetUserId}) ${args.text}`,
    is_markdown_text: true,
  });
}

async function sendGapoBody(
  conversationId: string,
  body: {
    type: "text";
    text: string;
    is_markdown_text?: boolean;
  } | {
    type: "quick_replies";
    text: string;
    metadata: { options: Array<{ title: string; payload: string }> };
  },
): Promise<void> {
  const url = config.channelOut.gapoSendUrl;
  const token = config.channelOut.gapoSendToken;
  const cleaned = body.type === "text" ? stripMarkdownForGapo(body.text) : body.text;
  const normalizedBody = body.type === "text" ? { ...body, text: cleaned } : body;
  const startedAt = Date.now();
  channelLog("gapo.send.start", {
    conversationId,
    url: url ? new URL(url).pathname : "",
    text: normalizedBody.text,
    textChars: cleaned.length,
    mode: url && token ? "gapo-agent" : "browser-fallback",
  });
  if (!url || !token) {
    const fallback = await sendViaBrowserIfAddressable(conversationId, normalizedBody.text);
    channelLog("gapo.send.end", {
      conversationId,
      durationMs: Date.now() - startedAt,
      delivered: fallback.sent,
      via: fallback.sent ? "browser" : "none",
      fallback,
    });
    if (fallback.sent) return;
    throw new Error(
      `channel-out not configured (GAPO_SEND_URL / GAPO_SEND_TOKEN missing); browser fallback=${fallback.reason}`,
    );
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Plugin-Token": token,
    },
    body: JSON.stringify({ conversationId, text: normalizedBody.text, body: normalizedBody }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body ? `: ${body}` : "";
    const fallback = await sendViaBrowserIfAddressable(conversationId, normalizedBody.text);
    if (fallback.sent) {
      channelLog("gapo.send.end", {
        conversationId,
        durationMs: Date.now() - startedAt,
        delivered: true,
        via: "browser",
        gapoWorkStatus: res.status,
        fallback,
      });
      console.warn(
        `[bb-pm-tools] gapo-agent /send failed ${res.status}; delivered via browser fallback to ${conversationId}`,
      );
      return;
    }
    channelLog("gapo.send.error", {
      conversationId,
      durationMs: Date.now() - startedAt,
      gapoWorkStatus: res.status,
      gapoWorkBody: body,
      fallback,
    });
    throw new Error(
      `gapo-agent /send failed ${res.status}${detail}; browser fallback=${fallback.reason}${fallback.message ? ` ${fallback.message}` : ""}`,
    );
  }
  channelLog("gapo.send.end", {
    conversationId,
    durationMs: Date.now() - startedAt,
    delivered: true,
    via: "gapo-agent",
    gapoWorkStatus: res.status,
  });
}

async function sendViaBrowserIfAddressable(
  conversationId: string,
  text: string,
): Promise<BrowserSendResult> {
  const target = normalizeBrowserTarget(conversationId);
  if (!target) return { sent: false, reason: "not-configured", message: "unsupported target" };
  return await sendDmViaBrowser(target, text);
}

function normalizeBrowserTarget(conversationId: string): string | null {
  const trimmed = conversationId.trim();
  if (!trimmed) return null;
  if (/^(dm|collab):\d+$/i.test(trimmed)) return trimmed;
  if (/^gapo:\d+$/i.test(trimmed)) return `dm:${trimmed.slice(5)}`;
  if (/^\d+$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Browser fallback (Sprint 3.5) — used when bot API has no thread for
 * the recipient. Calls browser-tools /send-dm which drives Gapo Work
 * via Playwright. Returns the Gapo messageId on success so the caller
 * can persist the new thread mapping in bb-pm `channel_identity`.
 *
 * Returns:
 *   { sent: true, messageId }                — DM delivered
 *   { sent: false, reason: "not-configured" } — fallback disabled
 *   { sent: false, reason: "throttled" }     — hourly cap hit upstream
 *   { sent: false, reason: "error", message } — anything else
 */
export type BrowserSendResult =
  | { sent: true; messageId: string | null }
  | { sent: false; reason: "not-configured" | "throttled" | "error"; message?: string; retryAfterSec?: number };

/**
 * Search Gapo org for users by name. Returns matched display names.
 * Uses the browser-tools plugin (Playwright). Note: Gapo doesn't expose
 * conversationId in raw search results — use `findAndOpenDmViaBrowser`
 * if you need a cid for sending a message.
 */
export async function findGapoUserViaBrowser(
  query: string,
): Promise<{ users: Array<{ name: string }> } | { error: string }> {
  const url = config.browserTools.findUserUrl;
  const token = config.browserTools.pluginToken;
  if (!url || !token) return { error: "browser-tools not configured" };
  const startedAt = Date.now();
  channelLog("browser.find_user.start", { query, url: new URL(url).pathname });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plugin-Token": token },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const body = await res.text();
      channelLog("browser.find_user.error", {
        query,
        status: res.status,
        durationMs: Date.now() - startedAt,
        body,
      });
      return { error: `${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as { users: Array<{ name: string }> };
    channelLog("browser.find_user.end", {
      query,
      status: res.status,
      durationMs: Date.now() - startedAt,
      resultCount: json.users.length,
      response: json,
    });
    return json;
  } catch (err: any) {
    channelLog("browser.find_user.error", {
      query,
      durationMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
    });
    return { error: err?.message ?? String(err) };
  }
}

/**
 * Search Gapo org + click DM icon to get conversationId for sending.
 * Returns null if no matching user found.
 */
export async function findAndOpenDmViaBrowser(
  query: string,
): Promise<{ conversationId: string; name: string } | { found: false } | { error: string }> {
  const url = config.browserTools.findAndOpenDmUrl;
  const token = config.browserTools.pluginToken;
  if (!url || !token) return { error: "browser-tools not configured" };
  const startedAt = Date.now();
  channelLog("browser.find_open_dm.start", { query, url: new URL(url).pathname });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plugin-Token": token },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const body = await res.text();
      channelLog("browser.find_open_dm.error", {
        query,
        status: res.status,
        durationMs: Date.now() - startedAt,
        body,
      });
      return { error: `${res.status}: ${body.slice(0, 200)}` };
    }
    const json = (await res.json()) as any;
    channelLog("browser.find_open_dm.end", {
      query,
      status: res.status,
      durationMs: Date.now() - startedAt,
      response: json,
    });
    return json;
  } catch (err: any) {
    channelLog("browser.find_open_dm.error", {
      query,
      durationMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
    });
    return { error: err?.message ?? String(err) };
  }
}

export async function sendDmViaBrowser(
  externalId: string,
  text: string,
): Promise<BrowserSendResult> {
  const url = config.browserTools.sendDmUrl;
  const token = config.browserTools.pluginToken;
  if (!url || !token) {
    return { sent: false, reason: "not-configured" };
  }
  const startedAt = Date.now();
  channelLog("browser.send_dm.start", {
    externalId,
    url: new URL(url).pathname,
    text,
    textChars: text.length,
  });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plugin-Token": token,
      },
      body: JSON.stringify({ externalId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      channelLog("browser.send_dm.error", {
        externalId,
        status: res.status,
        durationMs: Date.now() - startedAt,
        body,
      });
      return { sent: false, reason: "error", message: `${res.status}: ${body}` };
    }
    const json = (await res.json()) as {
      sent: boolean;
      reason?: string;
      messageId?: string | null;
      retryAfterSec?: number;
    };
    if (!json.sent && json.reason === "throttled") {
      channelLog("browser.send_dm.error", {
        externalId,
        status: res.status,
        durationMs: Date.now() - startedAt,
        reason: "throttled",
        retryAfterSec: json.retryAfterSec,
      });
      return { sent: false, reason: "throttled", retryAfterSec: json.retryAfterSec };
    }
    if (json.sent) {
      channelLog("browser.send_dm.end", {
        externalId,
        status: res.status,
        durationMs: Date.now() - startedAt,
        response: json,
      });
      return { sent: true, messageId: json.messageId ?? null };
    }
    channelLog("browser.send_dm.error", {
      externalId,
      status: res.status,
      durationMs: Date.now() - startedAt,
      response: json,
    });
    return { sent: false, reason: "error", message: json.reason ?? "unknown" };
  } catch (err: any) {
    channelLog("browser.send_dm.error", {
      externalId,
      durationMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
    });
    return { sent: false, reason: "error", message: err?.message ?? String(err) };
  }
}
