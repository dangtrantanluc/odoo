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
