import { IncomingMessage, ServerResponse } from "http";
import { runAgent } from "./orchestrator";
import type { AgentContext } from "./types";
import { checkRateLimit } from "./rate-limit";

/**
 * Channel-agnostic agent entry point. Any channel plugin (Gapo, Slack,
 * Telegram…) POSTs here with { text, correlationId?, source? } and receives
 * { reply }. Channels own their own inbound parsing + outbound delivery;
 * this plugin only orchestrates the LLM + tools.
 *
 * OpenClaw injects raw Node.js IncomingMessage / ServerResponse via its
 * plugin SDK registerHttpRoute contract, so we parse the body manually.
 */
function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_048_576) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function ensureRequestId(req: IncomingMessage): string {
  const incoming =
    (req.headers["x-request-id"] as string | undefined) ??
    (req.headers["x-correlation-id"] as string | undefined);
  return incoming ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleAgentRun(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const requestId = ensureRequestId(req);
  res.setHeader("X-Request-Id", requestId);

  try {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return true;
    }

    let body: any;
    try {
      body = await parseBody(req);
    } catch (err: any) {
      writeJson(res, 400, { error: err?.message || "Bad Request" });
      return true;
    }

    const text = String(body?.text ?? "").trim();
    if (!text) {
      writeJson(res, 400, { error: "Missing `text`" });
      return true;
    }

    // Rate limit by best-effort client identifier. Channel-supplied
    // correlationId beats raw IP because Gapo webhooks all share the
    // gateway IP.
    const rlKey = body?.correlationId
      ? `cid:${body.correlationId}`
      : `ip:${clientIp(req)}`;
    const rl = await checkRateLimit(rlKey);
    res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, rl.remaining)));
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      writeJson(res, 429, {
        error: "rate_limited",
        retryAfterSec: rl.retryAfterSec,
        limit: rl.limit,
      });
      return true;
    }

    const ctx: AgentContext = {
      source: (body?.source as AgentContext["source"]) ?? "chat",
      correlationId: body?.correlationId ?? requestId,
      conversationId: body?.conversationId,
    };
    const start = Date.now();
    const reply = await runAgent(text, ctx);
    console.log(
      `[bb-pm-tools] agent/run ok requestId=${requestId} source=${ctx.source} ` +
        `tookMs=${Date.now() - start} bytes=${reply.length}`,
    );
    writeJson(res, 200, { reply, requestId });
    return true;
  } catch (err: any) {
    console.error(
      `[bb-pm-tools] agent/run error requestId=${requestId}:`,
      err?.message || err,
    );
    if (!res.headersSent) {
      writeJson(res, 500, { error: err?.message || "Internal error", requestId });
    }
    return true;
  }
}
