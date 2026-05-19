import { IncomingMessage, ServerResponse } from "http";
import { assertConfig, config } from "./config";
import { GapoMessageBody, sendGapoMessage } from "./gapo-client";
import { normalizeGapoPayload } from "./normalizer";

interface OpenClawApi {
  registerHttpRoute: (opts: {
    path: string;
    auth: "plugin";
    match: "exact";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  }) => void;
}

interface AgentResponse {
  reply?: string;
  channelReply?: GapoMessageBody;
  gapo?: {
    conversation_id?: string | null;
    conversationId?: string | null;
    thread_id?: string | null;
    threadId?: string | null;
  };
  [key: string]: unknown;
}

export type OutboundPlan = {
  text: string;
  body?: GapoMessageBody;
  kind: GapoMessageBody["type"] | "empty";
};

const counters = {
  webhookReceived: 0,
  webhookProcessed: 0,
  webhookIgnored: 0,
  webhookFailed: 0,
  sendSucceeded: 0,
  sendFailed: 0,
};
const recentEventIds = new Map<string, number>();
const EVENT_DEDUP_TTL_MS = 5 * 60_000;

export function register(api: OpenClawApi): void {
  const missing = assertConfig();
  if (missing.length) {
    console.warn(`[gapo-agent] missing config: ${missing.join(", ")} — plugin will register but may fail at runtime`);
  }
  if (!api || typeof api.registerHttpRoute !== "function") {
    console.error("[gapo-agent] api.registerHttpRoute unavailable");
    return;
  }

  api.registerHttpRoute({
    path: config.paths.health,
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "GET") return methodNotAllowed(res);
      writeJson(res, 200, {
        ok: missing.length === 0,
        plugin: "gapo-agent",
        missing,
        paths: config.paths,
        agentWebhookUrl: config.agent.webhookUrl,
        gapoApiConfigured: Boolean(config.gapo.apiUrl),
        gapoBotConfigured: Boolean(config.gapo.botToken),
        dryRun: config.gapo.dryRun,
        sendTokenConfigured: Boolean(config.auth.pluginToken),
        counters,
      });
      return true;
    },
  });

  api.registerHttpRoute({
    path: config.paths.send,
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "POST") return methodNotAllowed(res);
      if (!checkPluginToken(req)) {
        writeJson(res, 401, { error: "invalid plugin token" });
        return true;
      }
      try {
        const body = (await readJson(req)) as {
          conversationId?: string;
          text?: string;
          body?: Parameters<typeof sendGapoMessage>[2];
        };
        if (!body.conversationId) {
          writeJson(res, 400, { error: "conversationId required" });
          return true;
        }
        const text = body.text || body.body?.text;
        if (!text) {
          writeJson(res, 400, { error: "text or body.text required" });
          return true;
        }
        const sent = await sendGapoMessage(body.conversationId, text, body.body);
        if (sent.sent) counters.sendSucceeded += 1;
        else counters.sendFailed += 1;
        writeJson(res, sent.sent ? 200 : 502, sent);
      } catch (err: any) {
        console.error("[gapo-agent] send failed:", err?.message || err);
        writeJson(res, 500, { error: err?.message || "internal" });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: config.paths.webhook,
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "POST") return methodNotAllowed(res);
      const startedAt = Date.now();
      counters.webhookReceived += 1;
      let payload: Record<string, unknown> = {};
      try {
        payload = (await readJson(req)) as Record<string, unknown>;
        const normalized = normalizeGapoPayload(payload);
        channelLog("webhook.received", { rawPayload: payload, normalized });
        const eventId = typeof payload.id === "string" ? payload.id : null;
        if (eventId && isDuplicateEvent(eventId)) {
          counters.webhookIgnored += 1;
          writeJson(res, 200, {
            ok: true,
            received: true,
            processed: false,
            duplicate: true,
            durationMs: Date.now() - startedAt,
            normalized,
            sent: { sent: false, reason: "duplicate event" },
          });
          return true;
        }
        if (!normalized.shouldProcess) {
          counters.webhookIgnored += 1;
          writeJson(res, 200, {
            ok: true,
            received: true,
            processed: false,
            durationMs: Date.now() - startedAt,
            normalized,
            sent: { sent: false, reason: "event ignored" },
          });
          return true;
        }

        const agent = await callAgent(normalized);
        if (agent.processed === false) {
          writeJson(res, 200, {
            ok: true,
            received: true,
            processed: false,
            durationMs: Date.now() - startedAt,
            normalized,
            agent,
            sent: { sent: false, reason: "agent did not process message" },
          });
          return true;
        }
        const reply = typeof agent.reply === "string" ? agent.reply.trim() : "";
        const conversationId =
          agent.gapo?.conversation_id ||
          agent.gapo?.conversationId ||
          normalized.conversationId ||
          normalized.threadId;
        const outbound = buildOutboundPlan(reply, agent.channelReply);
        channelLog("outbound.attempt", {
          conversationId,
          kind: outbound.kind,
          textChars: outbound.text.length,
          optionCount:
            outbound.body?.type === "quick_replies"
              ? outbound.body.metadata.options.length
              : undefined,
        });
        let sent = outbound.text && conversationId
          ? await sendGapoMessage(conversationId, outbound.text, outbound.body)
          : { sent: false, reason: outbound.text ? "missing conversation id" : "empty reply" };
        channelLog("outbound.result", {
          conversationId,
          kind: outbound.kind,
          sent: sent.sent,
          statusCode: "statusCode" in sent ? sent.statusCode : undefined,
          message: "message" in sent ? sent.message?.slice(0, 200) : undefined,
        });
        if (
          !sent.sent &&
          conversationId &&
          agent.channelReply?.type === "quick_replies"
        ) {
          const fallbackText = buildQuickReplyFallbackText(agent.channelReply);
          channelLog("outbound.fallback.attempt", {
            conversationId,
            kind: "text",
            textChars: fallbackText.length,
          });
          const fallbackSent = await sendGapoMessage(conversationId, fallbackText);
          channelLog("outbound.fallback.result", {
            conversationId,
            sent: fallbackSent.sent,
            statusCode: fallbackSent.statusCode,
            message: fallbackSent.message?.slice(0, 200),
          });
          if (fallbackSent.sent) sent = fallbackSent;
        }
        counters.webhookProcessed += 1;
        if (sent.sent) counters.sendSucceeded += 1;
        else counters.sendFailed += 1;

        writeJson(res, 200, {
          ok: true,
          received: true,
          processed: true,
          durationMs: Date.now() - startedAt,
          normalized,
          agent,
          sent,
        });
      } catch (err: any) {
        counters.webhookFailed += 1;
        const normalized = tryNormalize(payload);
        console.error("[gapo-agent] webhook failed:", err?.message || err);
        channelLog("webhook.failed", {
          rawPayload: payload,
          normalized,
          error: err?.message || String(err),
        });
        writeJson(res, 200, {
          ok: true,
          received: true,
          processed: false,
          durationMs: Date.now() - startedAt,
          normalized,
          error: { message: err?.message || "internal" },
        });
      }
      return true;
    },
  });

  console.log(`[gapo-agent] registered webhook=${config.paths.webhook}, send=${config.paths.send}, agent=${config.agent.webhookUrl}`);
}

export function buildOutboundPlan(
  reply: string,
  channelReply?: GapoMessageBody,
): OutboundPlan {
  if (channelReply) {
    return {
      text: channelReply.text,
      body: channelReply,
      kind: channelReply.type,
    };
  }
  if (reply) return { text: reply, kind: "text" };
  return { text: "", kind: "empty" };
}

export function buildQuickReplyFallbackText(body: Extract<GapoMessageBody, { type: "quick_replies" }>): string {
  if (/nếu không thấy nút/i.test(body.text)) return body.text;
  const choices = body.metadata.options
    .map((option, index) => `${index + 1}. ${option.title}`)
    .join("\n");
  return `${body.text}\n\nNếu không thấy nút, trả lời bằng số:\n${choices}`;
}

function isDuplicateEvent(eventId: string): boolean {
  const now = Date.now();
  for (const [id, seenAt] of recentEventIds) {
    if (now - seenAt > EVENT_DEDUP_TTL_MS) recentEventIds.delete(id);
  }
  if (recentEventIds.has(eventId)) return true;
  recentEventIds.set(eventId, now);
  return false;
}

async function callAgent(normalized: ReturnType<typeof normalizeGapoPayload>): Promise<AgentResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.agent.timeoutMs);
  try {
    const res = await fetch(config.agent.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "chat",
        conversationId: normalized.conversationId,
        externalId: normalized.externalId,
        correlationId: normalized.correlationId,
        text: normalized.text,
        eventType: normalized.eventType,
        metadata: {
          fromUserId: normalized.fromUserId,
          threadId: normalized.threadId,
          toBotId: normalized.toBotId,
          messageId: normalized.messageId,
          messageType: normalized.messageType,
          payload: normalized.payload,
          mentions: normalized.mentions,
          isGroupMessage: normalized.isGroupMessage,
          senderName: normalized.senderName,
        },
        skipChannelAck: true,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    const body = text ? safeJson(text) : {};
    if (!res.ok) {
      throw new Error(`agent webhook failed ${res.status}: ${text.slice(0, 500)}`);
    }
    return body as AgentResponse;
  } finally {
    clearTimeout(timer);
  }
}

function checkPluginToken(req: IncomingMessage): boolean {
  const token = req.headers["x-plugin-token"];
  return typeof token === "string" && token === config.auth.pluginToken;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_048_576) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res: ServerResponse): boolean {
  writeJson(res, 405, { error: "method not allowed" });
  return true;
}

function channelLog(event: string, fields: Record<string, unknown>): void {
  if (!config.log.io) return;
  const payload = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  const text = payload.length > config.log.maxChars
    ? `${payload.slice(0, config.log.maxChars)}...[truncated ${payload.length - config.log.maxChars} chars]`
    : payload;
  console.log(`[gapo-agent/io] ${text}`);
}

function tryNormalize(payload: Record<string, unknown>): unknown {
  try {
    return normalizeGapoPayload(payload);
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default { register };
