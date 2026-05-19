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
  });
  if (!url || !token) {
    throw new Error("channel-out not configured (GAPO_SEND_URL / GAPO_SEND_TOKEN missing)");
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
    const errBody = await res.text().catch(() => "");
    channelLog("gapo.send.error", {
      conversationId,
      durationMs: Date.now() - startedAt,
      gapoWorkStatus: res.status,
      gapoWorkBody: errBody,
    });
    throw new Error(`gapo-agent /send failed ${res.status}${errBody ? `: ${errBody}` : ""}`);
  }
  channelLog("gapo.send.end", {
    conversationId,
    durationMs: Date.now() - startedAt,
    delivered: true,
    via: "gapo-agent",
    gapoWorkStatus: res.status,
  });
}
