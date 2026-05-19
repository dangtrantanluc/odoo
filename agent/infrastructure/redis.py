"""Async Redis client wrapper.

Used by rate-limit, cooldown, caller-cache and action-pending state. If
REDIS_URL is unset or the server is unreachable, `client` stays None and the
callers fall back to in-process structures (fine for a single worker).
Mirrors bb-pm-tools/src/infrastructure/redis.ts.
"""

from __future__ import annotations

from typing import Optional

import redis.asyncio as aioredis

from core.config import settings
from core.logging import log_event


class RedisClient:
    def __init__(self, url: str) -> None:
        self._url = url
        self._client: Optional[aioredis.Redis] = None

    @property
    def client(self) -> Optional[aioredis.Redis]:
        return self._client

    @property
    def available(self) -> bool:
        return self._client is not None

    async def connect(self) -> None:
        if not self._url:
            log_event("redis.disabled", level="warning", reason="REDIS_URL not set")
            return
        try:
            client = aioredis.from_url(
                self._url, encoding="utf-8", decode_responses=True
            )
            await client.ping()
            self._client = client
            log_event("redis.connected", url=self._url)
        except Exception as err:  # noqa: BLE001 — fall back to in-memory on any failure
            self._client = None
            log_event("redis.unavailable", level="warning", error=str(err))

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


redis_client = RedisClient(settings.redis.url)
