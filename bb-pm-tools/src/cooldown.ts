import { config } from "./config";
import { getRedis } from "./redis";

/**
 * Follow-up cooldown — prevents the agent from pinging the same person /
 * task twice within a TTL window.
 *
 * Backend: Redis if REDIS_URL is set (works across multiple plugin
 * instances), falls back to in-process Map otherwise. The in-memory store
 * is purged lazily on each isCoolingDown call.
 *
 * Key format: `${scope}:${id}`. Typical usage:
 *   await cooldown.isCoolingDown(`followup:${userId}:${taskId}`)
 *   await cooldown.mark(`followup:${userId}:${taskId}`)
 */

const KEY_PREFIX = "bbpm:cooldown:";

type Entry = { expiresAt: number };
const memStore = new Map<string, Entry>();

function defaultTtlSec(): number {
  return config.redis.followUpCooldownSec || 24 * 3600;
}

function memPurge(now = Date.now()) {
  for (const [k, v] of memStore) {
    if (v.expiresAt <= now) memStore.delete(k);
  }
}

async function redisOrNull() {
  return config.redis.url ? await getRedis() : null;
}

export const cooldown = {
  /** True if the key is cooling down (do not fire again). */
  async isCoolingDown(key: string): Promise<boolean> {
    const r = await redisOrNull();
    if (r) {
      const v = await r.get(KEY_PREFIX + key).catch(() => null);
      return !!v;
    }
    memPurge();
    const hit = memStore.get(key);
    return !!hit && hit.expiresAt > Date.now();
  },

  /** Record a firing; subsequent isCoolingDown returns true for ttl seconds. */
  async mark(key: string, ttlSeconds = defaultTtlSec()): Promise<void> {
    const r = await redisOrNull();
    if (r) {
      await r.set(KEY_PREFIX + key, "1", "EX", ttlSeconds).catch(() => {});
      return;
    }
    memStore.set(key, { expiresAt: Date.now() + ttlSeconds * 1000 });
  },

  /** Remove a key — e.g. when the person replied and we want to allow re-ping. */
  async clear(key: string): Promise<void> {
    const r = await redisOrNull();
    if (r) {
      await r.del(KEY_PREFIX + key).catch(() => {});
      return;
    }
    memStore.delete(key);
  },

  /** Seconds until a cooled-down key is eligible to fire again (0 if ready). */
  async remainingSec(key: string): Promise<number> {
    const r = await redisOrNull();
    if (r) {
      const ms = await r.pttl(KEY_PREFIX + key).catch(() => -2);
      return ms > 0 ? Math.ceil(ms / 1000) : 0;
    }
    const hit = memStore.get(key);
    if (!hit) return 0;
    return Math.max(0, Math.ceil((hit.expiresAt - Date.now()) / 1000));
  },
};
