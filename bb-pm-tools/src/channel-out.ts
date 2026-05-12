import fetch from "node-fetch";
import { config } from "./config";

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
 * calling the gapo-work plugin's /send endpoint. After Phase 2 bb-pm-tools
 * does not hold Gapo credentials itself; gapo-work owns that surface.
 */
export async function sendToGapo(conversationId: string, text: string): Promise<void> {
  const url = config.channelOut.gapoSendUrl;
  const token = config.channelOut.gapoSendToken;
  const cleaned = stripMarkdownForGapo(text);
  if (!url || !token) {
    const fallback = await sendViaBrowserIfAddressable(conversationId, cleaned);
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
    body: JSON.stringify({ conversationId, text: cleaned }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body ? `: ${body}` : "";
    const fallback = await sendViaBrowserIfAddressable(conversationId, cleaned);
    if (fallback.sent) {
      console.warn(
        `[bb-pm-tools] gapo-work /send failed ${res.status}; delivered via browser fallback to ${conversationId}`,
      );
      return;
    }
    throw new Error(
      `gapo-work /send failed ${res.status}${detail}; browser fallback=${fallback.reason}${fallback.message ? ` ${fallback.message}` : ""}`,
    );
  }
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
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plugin-Token": token },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return { error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
    return (await res.json()) as { users: Array<{ name: string }> };
  } catch (err: any) {
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
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plugin-Token": token },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return { error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
    return (await res.json()) as any;
  } catch (err: any) {
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
      return { sent: false, reason: "error", message: `${res.status}: ${body}` };
    }
    const json = (await res.json()) as {
      sent: boolean;
      reason?: string;
      messageId?: string | null;
      retryAfterSec?: number;
    };
    if (!json.sent && json.reason === "throttled") {
      return { sent: false, reason: "throttled", retryAfterSec: json.retryAfterSec };
    }
    if (json.sent) {
      return { sent: true, messageId: json.messageId ?? null };
    }
    return { sent: false, reason: "error", message: json.reason ?? "unknown" };
  } catch (err: any) {
    return { sent: false, reason: "error", message: err?.message ?? String(err) };
  }
}
