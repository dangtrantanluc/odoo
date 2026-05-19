import { config } from "../shared/config";

/**
 * Lightweight Redis wrapper. Uses ioredis if REDIS_URL is set; otherwise
 * exposes a noop client so callers can fall back to in-memory state without
 * branching on null. The wrapper isolates the dynamic import so the plugin
 * still boots if ioredis is missing or Redis is unreachable.
 */

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: "EX", ttl?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  pttl(key: string): Promise<number>;
  ping(): Promise<string>;
  keys(pattern: string): Promise<string[]>;
};

let client: RedisLike | null = null;
let connecting: Promise<RedisLike | null> | null = null;
let connectFailed = false;

async function tryConnect(): Promise<RedisLike | null> {
  if (!config.redis.url) return null;
  if (connectFailed) return null;
  try {
    const mod: any = await import("ioredis").catch(() => null);
    if (!mod) {
      connectFailed = true;
      console.warn("[bb-pm-tools] ioredis not installed; using in-memory cooldown");
      return null;
    }
    const Ctor = mod.default ?? mod.Redis ?? mod;
    const r = new Ctor(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    r.on("error", (err: Error) => {
      // log once per minute to avoid spamming
      console.warn("[bb-pm-tools] Redis error:", err?.message);
    });
    await r.connect();
    return r as RedisLike;
  } catch (err: any) {
    connectFailed = true;
    console.warn("[bb-pm-tools] Redis connect failed; using in-memory:", err?.message);
    return null;
  }
}

export async function getRedis(): Promise<RedisLike | null> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = tryConnect().then((r) => {
    client = r;
    connecting = null;
    return r;
  });
  return connecting;
}

export async function pingRedis(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!config.redis.url) return { ok: false, error: "no_url" };
  try {
    const r = await getRedis();
    if (!r) return { ok: false, error: "not_connected" };
    const start = Date.now();
    await r.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
