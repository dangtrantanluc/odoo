import fetch from "node-fetch";
import { config } from "./config";

/**
 * Outbound channel port — posts a message into a Gapo conversation by
 * calling the gapo-work plugin's /send endpoint. After Phase 2 bb-pm-tools
 * does not hold Gapo credentials itself; gapo-work owns that surface.
 */
export async function sendToGapo(conversationId: string, text: string): Promise<void> {
  const url = config.channelOut.gapoSendUrl;
  const token = config.channelOut.gapoSendToken;
  if (!url || !token) {
    console.warn(
      "[bb-pm-tools] channel-out not configured (GAPO_SEND_URL / GAPO_SEND_TOKEN missing) — dropping outbound message",
    );
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Plugin-Token": token,
    },
    body: JSON.stringify({ conversationId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[bb-pm-tools] gapo-work /send failed", res.status, body);
  }
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
