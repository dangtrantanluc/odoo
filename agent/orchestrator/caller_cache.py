"""Caller identity cache. Ports bb-pm-tools/src/caller-cache.ts.

Resolves a Gapo external id -> bb-pm user, cached in-process for a short TTL
so every turn does not re-hit `/agent/user-by-channel`.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from core.config import settings
from infrastructure.bbpm_client import BbPmClient

_cache: dict[str, tuple[float, Optional[dict[str, Any]]]] = {}


async def resolve_caller(
    bbpm: BbPmClient, external_id: str, thread_id: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Return the bb-pm user for a Gapo external id, or None if unmapped."""
    key = f"{external_id}|{thread_id or ''}"
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and (now - hit[0]) <= settings.caller_cache_ttl_sec:
        return hit[1]
    try:
        user = await bbpm.user_by_channel("gapo", external_id, thread_id)
    except Exception:  # noqa: BLE001
        user = None
    _cache[key] = (now, user)
    if len(_cache) > 2000:  # lazy GC
        for k, (ts, _) in list(_cache.items()):
            if now - ts > settings.caller_cache_ttl_sec:
                _cache.pop(k, None)
    return user
