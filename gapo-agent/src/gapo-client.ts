import { config } from "./config";
import { stripGapoPrefix } from "./normalizer";

export interface GapoSendResult {
  sent: boolean;
  conversationId: string;
  response?: unknown;
  statusCode?: number;
  message?: string;
  requestBody?: unknown;
}

export type GapoMessageBody =
  | { type: "text"; text: string; is_markdown_text?: boolean }
  | {
      type: "quick_replies";
      text: string;
      metadata: { options: Array<{ title: string; payload: string }> };
    };

export function buildTextBody(text: string): GapoMessageBody {
  return { type: "text", text, is_markdown_text: true };
}

export function buildQuickRepliesBody(
  text: string,
  options: Array<{ title: string; payload: string }>,
): GapoMessageBody {
  return { type: "quick_replies", text, metadata: { options } };
}

export function buildMentionTextBody(args: {
  text: string;
  mentionName: string;
  targetUserId: string;
}): GapoMessageBody {
  return {
    type: "text",
    text: `[@${args.mentionName}](https://www.gapowork.vn/profile/${args.targetUserId}) ${args.text}`,
    is_markdown_text: true,
  };
}

export async function sendGapoMessage(
  conversationId: string,
  text: string,
  body: GapoMessageBody = buildTextBody(text),
): Promise<GapoSendResult> {
  const requestBody = buildGapoRequest(conversationId, body);
  if (!requestBody) {
    return { sent: false, conversationId, message: "missing conversationId/threadId" };
  }
  if (!config.gapo.botToken && !config.gapo.dryRun) {
    return { sent: false, conversationId, message: "GAPO_BOT_TOKEN is empty" };
  }

  const authValue = config.gapo.authPrefix
    ? `${config.gapo.authPrefix} ${config.gapo.botToken}`
    : config.gapo.botToken;
  if (config.gapo.dryRun) {
    return {
      sent: true,
      conversationId,
      response: { dryRun: true },
      requestBody,
    };
  }

  const res = await fetch(config.gapo.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [config.gapo.authHeader]: authValue,
    },
    body: JSON.stringify(requestBody),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    return {
      sent: false,
      conversationId,
      statusCode: res.status,
      message: bodyText.slice(0, 500),
      requestBody,
    };
  }
  return {
    sent: true,
    conversationId,
    response: bodyText ? safeJson(bodyText) : { ok: true },
  };
}

export function buildGapoRequest(
  conversationId: string,
  body: GapoMessageBody,
): Record<string, unknown> | null {
  const target = parseConversationTarget(conversationId);
  if (!target) return null;
  const requestBody: Record<string, unknown> = {
    ...target,
    body,
  };
  if (config.gapo.botId) {
    requestBody.bot_id = parseNumericIfPossible(config.gapo.botId);
  }
  return requestBody;
}

export function parseConversationTarget(value: string | null | undefined): Record<string, string> | null {
  const raw = stripGapoPrefix(value);
  if (!raw) return null;
  if (/^dm:/i.test(raw)) return { receiver_id: raw.slice(3) };
  if (/^collab:/i.test(raw)) return { collab_id: raw.slice(7) };
  return { thread_id: raw };
}

function parseNumericIfPossible(value: string): string | number {
  if (!/^\d+$/.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
