// Sprint 8 Day 1 — Dedup re-send protection.
// Block duplicate agent runs trong window 60s — chống user spam re-send khi
// LLM chậm và họ tưởng bot chết. Without this, 2 agent runs trên cùng câu →
// duplicate reply, GPU waste.
//
// Key = sha256(userId + normalized_text).slice(16) → cheap fingerprint.
// In-memory Map (single-process). PM2 cluster cần Redis-backed (Phase 8.1).

import { createHash } from "crypto";

const TTL_MS = Number(process.env.BB_PM_DEDUP_TTL_MS ?? 60_000);
const MAX_ENTRIES = 1000;

const recent = new Map<string, number>();

function fingerprint(userId: string, text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${userId}|${normalized}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Check + record. Returns true nếu duplicate (caller should reject/short-circuit),
 * false nếu first-seen.
 *
 * Side effect: updates internal map. Không idempotent — caller chỉ gọi 1 lần
 * cho mỗi inbound message.
 */
export function checkDuplicate(userId: string, text: string): boolean {
  if (!text || !userId) return false;
  const key = fingerprint(userId, text);
  const now = Date.now();
  const last = recent.get(key);

  if (last !== undefined && now - last < TTL_MS) {
    // Refresh expiry (sliding window) so spam doesn't unlock at TTL boundary
    recent.set(key, now);
    return true;
  }

  recent.set(key, now);
  // Lazy GC khi map quá lớn — drop entries quá hạn
  if (recent.size > MAX_ENTRIES) {
    for (const [k, t] of recent) {
      if (now - t > TTL_MS) recent.delete(k);
    }
  }
  return false;
}

/** Test-only: clear state. */
export function _resetDedup(): void {
  recent.clear();
}
