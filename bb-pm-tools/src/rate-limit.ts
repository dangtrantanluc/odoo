import { config } from "./config";
import { getRedis } from "./redis";

/**
 * Token-bucket rate limit for /agent/run. Uses Redis if available so the
 * limit is shared across plugin instances; otherwise falls back to a
 * per-process in-memory bucket. The cap stays small (~30 req/min by
 * default) because each /agent/run hits the LLM and bb-pm DB.
 *
 * Limit is keyed by best-effort client identifier: prefer the channel-
 * supplied `correlationId` if present (one identifier per chat thread),
 * else the request IP. This protects against runaway loops more than
 * malicious abuse — a real DoS layer belongs upstream of the gateway.
 *
 * Redis encoding: `${windowStart}:${count}` so we can compute remaining
 * window time without a second PTTL call. Keeps the wire format simple.
 */

const KEY_PREFIX = "bbpm:rl:agent-run:";

type Bucket = { count: number; windowStart: number };
const memBuckets = new Map<string, Bucket>();

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
  limit: number;
};

export async function checkRateLimit(identifier: string): Promise<RateLimitResult> {
  const limit = config.rateLimit.maxPerWindow;
  if (limit <= 0) {
    return { ok: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0, limit };
  }
  const winSec = config.rateLimit.windowSec;
  const winMs = winSec * 1000;
  const now = Date.now();

  const r = config.redis.url ? await getRedis() : null;
  if (r) {
    const key = KEY_PREFIX + identifier;
    try {
      const raw = await r.get(key);
      let windowStart = now;
      let count = 0;
      if (raw) {
        const [wsStr, cStr] = raw.split(":");
        const ws = Number(wsStr);
        const c = Number(cStr);
        if (Number.isFinite(ws) && Number.isFinite(c) && now - ws < winMs) {
          windowStart = ws;
          count = c;
        }
      }
      if (count >= limit) {
        const elapsed = now - windowStart;
        return {
          ok: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((winMs - elapsed) / 1000)),
          limit,
        };
      }
      const ttlSec = Math.max(1, Math.ceil((winMs - (now - windowStart)) / 1000));
      await r.set(key, `${windowStart}:${count + 1}`, "EX", ttlSec).catch(() => {});
      return { ok: true, remaining: limit - count - 1, retryAfterSec: 0, limit };
    } catch {
      // fall through to in-memory
    }
  }

  const b = memBuckets.get(identifier);
  if (!b || now - b.windowStart > winMs) {
    memBuckets.set(identifier, { count: 1, windowStart: now });
    return { ok: true, remaining: limit - 1, retryAfterSec: 0, limit };
  }
  if (b.count >= limit) {
    const elapsed = now - b.windowStart;
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((winMs - elapsed) / 1000)),
      limit,
    };
  }
  b.count += 1;
  return { ok: true, remaining: limit - b.count, retryAfterSec: 0, limit };
}
