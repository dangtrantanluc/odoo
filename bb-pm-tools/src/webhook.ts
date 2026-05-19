import { IncomingMessage, ServerResponse } from "http";
import { runAgent } from "./orchestrator";
import type { AgentContext } from "./types";
import { checkRateLimit } from "./rate-limit";
import { checkDuplicate } from "./dedup";
import { acquireSlot, getMetrics } from "./concurrency";
import { stripMarkdownForGapo } from "./channel-out";
import { formatResponse } from "./formatter";
import { tryFastPath, executeFastPath } from "./pre-classifier";
import { recordRecentTurn } from "./memory";
import { getTelemetrySnapshot, recordAgentRunSample } from "./telemetry";
import { getCachedGapoUser } from "./caller-cache";
import { getCheckinTelemetrySnapshot, handleCheckinTurn } from "./checkin";
import { handleActionTurn } from "./action-router";
import { tryTextToSqlRead } from "./read-router";

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

const WEBHOOK_IO_LOG = (process.env.BB_PM_WEBHOOK_IO_LOG ?? "true").toLowerCase() !== "false";
const WEBHOOK_IO_LOG_MAX_CHARS = Number(process.env.BB_PM_WEBHOOK_IO_LOG_MAX_CHARS ?? 2000);

function truncateWebhookLog(value: string, max = WEBHOOK_IO_LOG_MAX_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function webhookLog(event: string, fields: Record<string, unknown>) {
  if (!WEBHOOK_IO_LOG) return;
  const payload = { ts: new Date().toISOString(), event, ...fields };
  try {
    console.log(`[bb-pm-tools/webhook-io] ${truncateWebhookLog(JSON.stringify(payload))}`);
  } catch {
    console.log(`[bb-pm-tools/webhook-io] ${event}`);
  }
}

export async function handleAgentRun(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const requestId = ensureRequestId(req);
  const startTurn = Date.now();
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
    webhookLog("agent_run.request", {
      requestId,
      method: req.method,
      source: body?.source ?? "chat",
      conversationId: body?.conversationId,
      correlationId: body?.correlationId,
      text,
      textChars: text.length,
    });

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
      recordAgentRunSample({
        requestId,
        source: body?.source,
        mode: "rate_limited",
        totalMs: Date.now() - startTurn,
        error: "rate_limited",
      });
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
      externalId: body?.externalId,
      eventType: body?.eventType,
      metadata: body?.metadata,
      skipChannelAck: body?.skipChannelAck === true,
      trace: { toolCalls: [] },
      timings: { llmCalls: [] },
    };

    // Sprint 8 Day 1 — dedup re-send protection. User spam re-send (vì LLM
    // chậm + tưởng bot chết) sẽ được short-circuit thay vì spawn duplicate
    // agent run. Skip nếu source=cron hoặc cli (không có user spam path).
    //
    // BUG FIX (2026-05-07): trước trả reply "Mình đang xử lý câu hỏi trước đó"
    // → watcher gửi lên Gapo → user thấy message thừa rất khó hiểu (đặc biệt
    // khi cause là watcher tự re-poll, không phải user spam). Fix: trả EMPTY
    // reply + flag dedup=true → watcher detect empty → skip send.
    if (ctx.source === "chat" && ctx.conversationId && !isSlashCommand(text)) {
      const isDup = checkDuplicate(ctx.conversationId, text);
      if (isDup) {
        recordAgentRunSample({
          requestId,
          source: ctx.source,
          mode: "dedup",
          totalMs: Date.now() - startTurn,
          replyBytes: 0,
          timings: ctx.timings,
          toolCalls: ctx.trace?.toolCalls,
        });
        console.log(
          `[bb-pm-tools] agent/run dedup blocked requestId=${requestId} cid=${ctx.conversationId} (silent — no user-facing message)`,
        );
        writeJson(res, 200, {
          reply: "",        // empty → watcher skip send
          requestId,
          dedup: true,
          silent: true,     // explicit flag cho watcher (defensive)
        });
        return true;
      }
    }

    // ── Fast-path BEFORE concurrency slot ────────────────────────────
    // CRITICAL FIX (load test 2026-05-07): Trước đây slash commands +
    // Vietnamese fast-path bị gate qua acquireSlot → khi Qwen busy (6 slot
    // in-flight × 60-180s mỗi LLM call), slash chờ 30-60s rồi timeout.
    // Fix: fast-path KHÔNG cần slot vì không gọi LLM (chỉ DB query). Resolve
    // caller xong → check pattern → execute trực tiếp. Skip cho non-chat
    // source (cli/eval/cron tự handle ngoài).
    if (ctx.source === "chat" && ctx.conversationId) {
      try {
        // Resolve callerUserId nếu chưa có (cần cho my_role/my_tasks/slash:role/slash:mytasks)
        if (!ctx.callerUserId) {
          const gapoUserId = ctx.externalId;
          if (gapoUserId) {
            const threadId = ctx.conversationId?.startsWith("gapo:")
              ? ctx.conversationId.slice("gapo:".length)
              : ctx.conversationId;
            const u = await getCachedGapoUser(gapoUserId, threadId).catch(() => null);
            if (u) ctx.callerUserId = u.id;
          }
        }
        const preferCheckinFirst = isCheckinCommand(text) || !isSlashCommand(text);
        if (preferCheckinFirst) {
          const checkinReply = await handleCheckinTurn(text, ctx);
          if (checkinReply) {
            const reply = stripMarkdownForGapo(checkinReply.reply);
            recordRecentTurn(ctx.conversationId, text, reply);
            recordAgentRunSample({
              requestId,
              source: ctx.source,
              mode: "fast_path",
              totalMs: Date.now() - startTurn,
              replyBytes: reply.length,
              timings: ctx.timings,
              toolCalls: ctx.trace?.toolCalls,
            });
            writeJson(res, 200, {
              reply,
              channelReply: checkinReply.channelReply,
              requestId,
              fastPath: checkinReply.pattern,
            });
            return true;
          }
        }
        const actionReply = await handleActionTurn(text, ctx).catch(() => null);
        if (actionReply) {
          const reply = stripMarkdownForGapo(actionReply.reply);
          recordAgentRunSample({ requestId, source: ctx.source, mode: "action_router", totalMs: Date.now() - startTurn, replyBytes: reply.length, timings: ctx.timings, toolCalls: ctx.trace?.toolCalls });
          console.log(`[bb-pm-tools] agent/run ACTION_ROUTER ok requestId=${requestId} pattern=${actionReply.pattern}`);
          writeJson(res, 200, { reply, requestId, actionRouter: actionReply.pattern });
          return true;
        }
        const fp = tryFastPath(text, ctx);
        if (fp) {
          const fpStart = Date.now();
          webhookLog("fastpath.start", {
            requestId,
            pattern: fp.pattern,
            toolName: fp.toolName,
            toolArgs: fp.toolArgs ?? {},
          });
          const fpReply = await executeFastPath(fp, ctx);
          // SKIP formatter cho fast-path: output đã chat-ready (hand-formatted
          // theo pattern). Đẩy qua formatter sẽ trigger LLM rewrite (~30s
          // Qwen) cho output > 350 chars → defeat purpose của fast-path.
          // Vẫn strip markdown để Gapo render sạch.
          const reply = stripMarkdownForGapo(fpReply);
          if (ctx.timings) ctx.timings.fastPathMs = Date.now() - fpStart;
          recordRecentTurn(ctx.conversationId, text, reply);
          recordAgentRunSample({
            requestId,
            source: ctx.source,
            mode: "fast_path",
            totalMs: Date.now() - startTurn,
            replyBytes: reply.length,
            timings: ctx.timings,
            toolCalls: ctx.trace?.toolCalls,
          });
          console.log(
            `[bb-pm-tools] agent/run FAST_PATH ok requestId=${requestId} pattern=${fp.pattern} ` +
              `tookMs=${Date.now() - fpStart} bytes=${reply.length}`,
          );
          webhookLog("fastpath.end", {
            requestId,
            pattern: fp.pattern,
            durationMs: Date.now() - fpStart,
            reply,
            replyChars: reply.length,
          });
          writeJson(res, 200, { reply, requestId, fastPath: fp.pattern });
          return true;
        }
      } catch (err: any) {
        // Slash commands are explicit user actions. If their backing tool is
        // down, return a visible error instead of falling through to a slow LLM
        // path that can still end with no useful reply.
        if (isSlashCommand(text)) {
          const reply =
            "Lệnh này đang gặp lỗi khi lấy dữ liệu PM. Bạn thử lại sau ít phút nhé.";
          webhookLog("fastpath.slash_error_reply", {
            requestId,
            durationMs: Date.now() - startTurn,
            error: err?.message ?? String(err),
          });
          writeJson(res, 200, { reply, requestId, fastPath: "slash:error" });
          return true;
        }
        // Fast-path fail (vd DB query lỗi) → fall through LLM path safe.
        webhookLog("fastpath.error", {
          requestId,
          durationMs: Date.now() - startTurn,
          error: err?.message ?? String(err),
        });
        console.warn(
          `[bb-pm-tools] fast-path failed (fall through LLM): ${err?.message ?? err}`,
        );
      }
    }

    if (ctx.source === "chat" && ctx.conversationId) {
      const readReply = await tryTextToSqlRead(text).catch(() => null);
      if (readReply) {
        const reply = stripMarkdownForGapo(readReply.reply);
        const readMode = readReply.pattern === "read:ambiguous_clarified"
          ? "ambiguous_read"
          : readReply.pattern === "read:keyword_fallback"
            ? "keyword_fallback"
            : "text_to_sql";
        recordAgentRunSample({ requestId, source: ctx.source, mode: readMode, totalMs: Date.now() - startTurn, replyBytes: reply.length, timings: ctx.timings, toolCalls: ctx.trace?.toolCalls });
        console.log(`[bb-pm-tools] agent/run TEXT_TO_SQL ok requestId=${requestId} pattern=${readReply.pattern}`);
        writeJson(res, 200, { reply, requestId, readRouter: readReply.pattern });
        return true;
      }
    }

    // Sprint 8 Phase #4 — concurrency limiter. Cap in-flight ở vLLM safe
    // batch size (~6) để tránh timeout cascade khi peak burst. Reject 503
    // nếu queue cũng full, caller (Gapo webhook) đã ack source thì user
    // không bị treo — chỉ Gapo retry sau retryAfterSec.
    const queueStart = Date.now();
    const slot = await acquireSlot();
    if (ctx.timings) ctx.timings.queueWaitMs = Date.now() - queueStart;
    if (!slot.ok) {
      recordAgentRunSample({
        requestId,
        source: ctx.source,
        mode: "overloaded",
        totalMs: Date.now() - startTurn,
        timings: ctx.timings,
        toolCalls: ctx.trace?.toolCalls,
        error: slot.reason,
      });
      console.warn(
        `[bb-pm-tools] agent/run rejected requestId=${requestId} reason=${slot.reason} ` +
          `metrics=${JSON.stringify(getMetrics())}`,
      );
      res.setHeader("Retry-After", String(slot.retryAfterSec));
      writeJson(res, 503, {
        error: "agent_overloaded",
        reason: slot.reason,
        retryAfterSec: slot.retryAfterSec,
        requestId,
      });
      return true;
    }

    const start = Date.now();
    let rawReply: string;
    try {
      rawReply = await runAgent(text, ctx);
      if (ctx.timings) ctx.timings.runAgentMs = Date.now() - start;
    } finally {
      slot.release();
    }
    // Sprint 8 Phase #5 — formatter layer. Biến raw agent output (có thể
    // còn lộ DB term, JSON, error) thành reply chat-ready: skip nếu đã
    // sạch, match template nếu khớp keyword, LLM Qwen rewrite cho free-form.
    // Skip cho cli/eval source. Fail-safe: nếu fail/timeout → trả raw.
    const formatterStart = Date.now();
    const formatted = await formatResponse(rawReply, ctx, text);
    if (ctx.timings) ctx.timings.formatterMs = Date.now() - formatterStart;
    // Strip markdown markers (**, __, ~~, `, # headers) — defense in depth
    // sau formatter để chắc chắn Gapo không thấy raw markup.
    const reply = stripMarkdownForGapo(formatted);
    recordAgentRunSample({
      requestId,
      source: ctx.source,
      mode: "react_fallback",
      totalMs: Date.now() - startTurn,
      replyBytes: reply.length,
      timings: ctx.timings,
      toolCalls: ctx.trace?.toolCalls,
    });
    const m = getMetrics();
    console.log(
      `[bb-pm-tools] agent/run ok requestId=${requestId} source=${ctx.source} ` +
        `tookMs=${Date.now() - start} totalMs=${Date.now() - startTurn} bytes=${reply.length} ` +
        `queueWaitMs=${ctx.timings?.queueWaitMs ?? 0} runAgentMs=${ctx.timings?.runAgentMs ?? 0} ` +
        `formatterMs=${ctx.timings?.formatterMs ?? 0} llmCalls=${(ctx.timings?.llmCalls ?? [])
          .map((c) => `${c.label}:${c.latencyMs}`)
          .join(",") || "0"} ` +
        `inFlight=${m.inFlight} queue=${m.queueDepth}`,
    );
    webhookLog("agent_run.response", {
      requestId,
      source: ctx.source,
      durationMs: Date.now() - startTurn,
      runAgentMs: ctx.timings?.runAgentMs ?? 0,
      formatterMs: ctx.timings?.formatterMs ?? 0,
      reply,
      replyChars: reply.length,
      toolCalls: ctx.trace?.toolCalls ?? [],
      llmCalls: ctx.timings?.llmCalls ?? [],
    });
    writeJson(res, 200, { reply, requestId });
    return true;
  } catch (err: any) {
    recordAgentRunSample({
      requestId,
      source: req.method ?? "unknown",
      mode: "error",
      totalMs: Date.now() - startTurn,
      error: err?.message || String(err),
    });
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

export function isSlashCommand(text: string): boolean {
  return /^\s*\/[a-z][a-z0-9_-]*(?:\s|$)/i.test(text);
}

function isCheckinCommand(text: string): boolean {
  return /^\s*\/(?:checkin|worklog|project)(?:\s|$)/i.test(text) ||
    /^\s*(?:update|cập nhật|cap nhat)\s+worklog\s*$/iu.test(text);
}

/**
 * GET /api/plugins/bb-pm/agent/metrics — concurrency + counter snapshot.
 * Public read-only (không leak data nhạy cảm). Dùng cho ops dashboard +
 * alert nếu queueDepth tăng cao.
 */
export async function handleAgentMetrics(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return true;
  }
  writeJson(res, 200, {
    metrics: getMetrics(),
    telemetry: getTelemetrySnapshot(),
    checkin: getCheckinTelemetrySnapshot(),
    timestamp: new Date().toISOString(),
  });
  return true;
}

/**
 * GET /api/plugins/bb-pm/health — liveness + readiness probe.
 * Check 3 critical deps: bb-pm API + Postgres (transitively via API) + LLM.
 * Trả về 200 nếu all OK, 503 nếu component nào fail. Dùng cho PM2/k8s/uptime
 * monitor + manual ops check.
 *
 * Format response:
 *   { status: "ok" | "degraded", checks: { name: { ok, latencyMs, detail? } } }
 *
 * status="ok" → all critical deps reachable
 * status="degraded" → ≥ 1 dep fail nhưng plugin still responsive
 *                     (LLM down ≠ chết hoàn toàn — fast-path vẫn work)
 */
export async function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return true;
  }

  // Lazy require để tránh circular import
  const { config, getActiveLlmConfig } = await import("./config");
  const { bbPm } = await import("./api-client");

  type CheckResult = { ok: boolean; latencyMs: number; detail?: string };
  const checks: Record<string, CheckResult> = {};

  // Check 1: bb-pm API health (transitively check Postgres via /health endpoint)
  const bbPmStart = Date.now();
  try {
    const url = `${config.bbPmApi.baseUrl}/health`;
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    checks.bbPmApi = {
      ok: r.ok,
      latencyMs: Date.now() - bbPmStart,
      detail: r.ok ? undefined : `${r.status}`,
    };
  } catch (err: any) {
    checks.bbPmApi = {
      ok: false,
      latencyMs: Date.now() - bbPmStart,
      detail: err?.message ?? String(err),
    };
  }

  // Check 2: LLM endpoint reachable (HEAD/OPTIONS - không tốn token)
  const llmStart = Date.now();
  try {
    const cfg = getActiveLlmConfig();
    // Most OpenAI-compat endpoints expose /models cheap GET
    const modelsUrl = `${cfg.baseUrl.replace(/\/$/, "")}/models`;
    const headers: Record<string, string> = {};
    if (cfg.apiKey && cfg.apiKey !== "not-needed" && cfg.apiKey !== "nokey") {
      headers["Authorization"] = `Bearer ${cfg.apiKey}`;
    }
    // Timeout 5s — Tailscale/remote vLLM có thể lag 1-2s khi cold.
    const r = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(5000) });
    checks.llm = {
      ok: r.ok,
      latencyMs: Date.now() - llmStart,
      detail: r.ok ? `${config.llm.activeProvider}/${cfg.model}` : `${r.status}`,
    };
  } catch (err: any) {
    checks.llm = {
      ok: false,
      latencyMs: Date.now() - llmStart,
      detail: err?.message ?? String(err),
    };
  }

  // Aggregate: degraded nếu bb-pm API fail (Postgres dead) — coi là critical.
  // LLM down → degraded nhưng plugin vẫn handle được fast-path.
  const allOk = Object.values(checks).every((c) => c.ok);
  const bbPmOk = checks.bbPmApi.ok;
  const status = bbPmOk && allOk ? "ok" : "degraded";

  // 200 nếu critical deps OK (cho phép LLM down — caller biết qua checks).
  // 503 nếu bb-pm API down (plugin về cơ bản chết).
  const httpCode = bbPmOk ? 200 : 503;
  writeJson(res, httpCode, {
    status,
    checks,
    timestamp: new Date().toISOString(),
  });
  return true;
}
