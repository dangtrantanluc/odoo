import { bbPm } from "./api-client";

type CachedCaller = {
  id: number;
  email: string;
  fullName: string;
  role: string;
  active: boolean;
} | null;

type Entry = {
  value: CachedCaller;
  expiresAt: number;
};

const CALLER_TTL_MS = Number(process.env.BB_PM_CALLER_CACHE_TTL_MS ?? 15 * 60 * 1000);
const cache = new Map<string, Entry>();

export async function getCachedGapoUser(externalId: string, threadId?: string): Promise<CachedCaller> {
  const cacheKey = threadId ? `${externalId}|${threadId}` : externalId;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) cache.delete(cacheKey);

  const value = await bbPm.getUserByGapoCid(externalId, threadId);
  cache.set(cacheKey, { value, expiresAt: now + CALLER_TTL_MS });
  return value;
}

export function clearCallerCache() {
  cache.clear();
}
