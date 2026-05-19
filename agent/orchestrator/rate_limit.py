"""Per-caller rate limiting. Ports bb-pm-tools/src/rate-limit.ts.

Fixed-window counter, Redis-backed when available, in-process otherwise.
Key is `cid:<correlationId>` (preferred) or `ip:<addr>`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from core.config import settings
from infrastructure.redis import redis_client


@dataclass
class RateLimitResult:
    ok: bool
    limit: int
    remaining: int
    retry_after_sec: int


_memory: dict[str, tuple[int, int]] = {}  # key -> (window_start, count)


async def check_rate_limit(key: str) -> RateLimitResult:
    limit = settings.rate_limit.max_per_window
    window = settings.rate_limit.window_sec
    if limit <= 0:
        return RateLimitResult(ok=True, limit=limit, remaining=limit, retry_after_sec=0)

    now = int(time.time())
    window_index = now // window
    redis = redis_client.client

    if redis is not None:
        redis_key = f"rl:{key}:{window_index}"
        try:
            count = await redis.incr(redis_key)
            if count == 1:
                await redis.expire(redis_key, window)
        except Exception:  # noqa: BLE001 — fall back to in-memory
            count = _memory_incr(key, window_index)
    else:
        count = _memory_incr(key, window_index)

    remaining = max(0, limit - count)
    if count > limit:
        retry_after = window - (now % window)
        return RateLimitResult(ok=False, limit=limit, remaining=0, retry_after_sec=retry_after)
    return RateLimitResult(ok=True, limit=limit, remaining=remaining, retry_after_sec=0)


def _memory_incr(key: str, window_index: int) -> int:
    start, count = _memory.get(key, (window_index, 0))
    if start != window_index:
        start, count = window_index, 0
    count += 1
    _memory[key] = (start, count)
    if len(_memory) > 5000:  # lazy GC
        for k, (s, _) in list(_memory.items()):
            if s != window_index:
                _memory.pop(k, None)
    return count
