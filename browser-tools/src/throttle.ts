import { config } from "./config";

/**
 * Per-process hourly DM cap. Shared across all calls in the running
 * plugin. If REDIS_URL is set we could swap to a Redis bucket — for
 * now the in-memory ring is enough because this plugin is single-
 * process by definition (one Chromium per host).
 */

const sentTimestamps: number[] = [];

export function checkDmThrottle(): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  while (sentTimestamps.length > 0 && sentTimestamps[0] < oneHourAgo) {
    sentTimestamps.shift();
  }
  const cap = config.limits.maxDmsPerHour;
  if (sentTimestamps.length >= cap) {
    const oldest = sentTimestamps[0];
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + 3600_000 - now) / 1000)) };
  }
  return { ok: true };
}

export function recordDmSent(): void {
  sentTimestamps.push(Date.now());
}
