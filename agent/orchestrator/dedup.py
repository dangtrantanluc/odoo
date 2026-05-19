"""Re-send dedup. Ports bb-pm-tools/src/dedup.ts.

Users spam-resend a message when the bot feels slow. We short-circuit a
repeated (conversation, text) within a short TTL so the same turn is not
processed twice. In-process only — assumes a single worker.
"""

from __future__ import annotations

import hashlib
import time

from core.config import settings

_seen: dict[str, float] = {}


def _key(conversation_id: str, text: str) -> str:
    digest = hashlib.sha256(f"{conversation_id}\n{text.strip().lower()}".encode("utf-8"))
    return digest.hexdigest()[:16]


def check_duplicate(conversation_id: str, text: str) -> bool:
    """Return True if this (conversation, text) was seen within the TTL."""
    now = time.monotonic()
    ttl = settings.dedup_ttl_sec
    if len(_seen) > 1000:  # lazy GC
        for k, seen_at in list(_seen.items()):
            if now - seen_at > ttl:
                del _seen[k]
    key = _key(conversation_id, text)
    last = _seen.get(key)
    _seen[key] = now
    return last is not None and (now - last) <= ttl
