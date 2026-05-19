export interface GapoNormalizedEvent {
  eventType: string | null;
  text: string | null;
  conversationId: string | null;
  externalId: string | null;
  fromUserId: string | null;
  threadId: string | null;
  toBotId: string | null;
  messageId: string | null;
  messageType: string | null;
  payload: string | null;
  mentions: Array<{ target: string; length: number | null; offset: number | null }>;
  isGroupMessage: boolean;
  senderName: string | null;
  correlationId: string | null;
  shouldProcess: boolean;
}

export function normalizeGapoPayload(payload: Record<string, unknown>): GapoNormalizedEvent {
  const eventType = firstString(payload.event);
  const text = firstString(
    payload.text,
    dig(payload, "message", "text"),
    dig(payload, "data", "text"),
    dig(payload, "event", "text"),
  );
  const conversationId = firstString(
    payload.conversationId,
    payload.conversation_id,
    payload.threadId,
    payload.thread_id,
    dig(payload, "message", "thread", "id"),
    dig(payload, "message", "thread_id"),
    dig(payload, "message", "conversationId"),
    dig(payload, "data", "conversationId"),
  );
  const rawThreadId = stripGapoPrefix(conversationId);

  const senderId = firstString(
    payload.from_user_id,
    payload.externalId,
    payload.external_id,
    payload.senderId,
    payload.sender_id,
    dig(payload, "message", "sender", "id"),
    dig(payload, "message", "user", "id"),
    dig(payload, "message", "from", "id"),
    dig(payload, "sender", "id"),
    dig(payload, "user", "id"),
    dig(payload, "from", "id"),
  );
  const externalId = stripGapoPrefix(senderId || rawThreadId);
  const fromUserId = firstString(payload.from_user_id, senderId);
  const toBotId = firstString(payload.to_bot_id);
  const messageId = firstString(dig(payload, "message", "id"));
  const messageType = firstString(dig(payload, "message", "type"));
  const messagePayload = firstString(dig(payload, "message", "payload"));
  const mentions = normalizeMentions(dig(payload, "message", "metadata", "mentions"));
  const threadType = firstString(dig(payload, "message", "thread", "type"));

  const senderName = firstString(
    payload.senderName,
    payload.sender_name,
    dig(payload, "message", "sender", "name"),
    dig(payload, "message", "sender", "display_name"),
    dig(payload, "message", "user", "name"),
    dig(payload, "message", "from", "name"),
    dig(payload, "sender", "name"),
    dig(payload, "user", "name"),
    dig(payload, "from", "name"),
  );

  const normalizedConversationId = rawThreadId ? ensureGapoPrefix(rawThreadId) : null;
  const correlationId = firstString(payload.correlationId, payload.correlation_id) ||
    (rawThreadId ? `gapo-${rawThreadId}` : null);

  const effectiveText = messageType === "menu" && messagePayload?.trim().startsWith("/")
    ? messagePayload.trim()
    : text?.trim() ?? null;
  const processableMessageType = !messageType || ["text", "quick_reply", "menu"].includes(messageType);
  const isGroupMessage = Boolean(threadType && threadType !== "direct");
  const isCommand = Boolean(effectiveText?.trim().startsWith("/"));
  const botMentioned = Boolean(
    toBotId && mentions.some((mention) => mention.target === toBotId),
  );
  return {
    eventType,
    text: effectiveText,
    conversationId: normalizedConversationId,
    externalId,
    fromUserId,
    threadId: rawThreadId,
    toBotId,
    messageId,
    messageType,
    payload: messagePayload,
    mentions,
    isGroupMessage,
    senderName,
    correlationId,
    shouldProcess:
      (!eventType || eventType === "message_created") &&
      processableMessageType &&
      (!isGroupMessage || isCommand || botMentioned || messageType === "quick_reply" || messageType === "menu") &&
      Boolean(effectiveText?.trim()),
  };
}

export function dig(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function stripGapoPrefix(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^gapo:(.+)$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

export function ensureGapoPrefix(value: string): string {
  return value.toLowerCase().startsWith("gapo:") ? value : `gapo:${value}`;
}

function normalizeMentions(value: unknown): Array<{ target: string; length: number | null; offset: number | null }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const target = firstString(entry.target);
      if (!target) return null;
      return {
        target,
        length: typeof entry.length === "number" ? entry.length : null,
        offset: typeof entry.offset === "number" ? entry.offset : null,
      };
    })
    .filter((entry): entry is { target: string; length: number | null; offset: number | null } => Boolean(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
