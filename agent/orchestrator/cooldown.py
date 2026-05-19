"""Cooldown gate. Ports bb-pm-tools/src/cooldown.ts.

Prevents repeated proactive pings (e.g. follow-ups) to the same target inside
a window. Redis-backed when available, in-process otherwise.
"""

from __future__ import annotations

import time

from core.config import settings
from infrastructure.redis import redis_client

_memory: dict[str, float] = {}


async def is_on_cooldown(scope: str) -> bool:
    redis = redis_client.client
    key = f"cooldown:{scope}"
    if redis is not None:
        try:
            return bool(await redis.exists(key))
        except Exception:  # noqa: BLE001
            pass
    expires = _memory.get(key)
    return expires is not None and expires > time.monotonic()


async def set_cooldown(scope: str, ttl_sec: int | None = None) -> None:
    ttl = ttl_sec if ttl_sec is not None else settings.redis.follow_up_cooldown_sec
    redis = redis_client.client
    key = f"cooldown:{scope}"
    if redis is not None:
        try:
            await redis.set(key, "1", ex=ttl)
            return
        except Exception:  # noqa: BLE001
            pass
    _memory[key] = time.monotonic() + ttl
