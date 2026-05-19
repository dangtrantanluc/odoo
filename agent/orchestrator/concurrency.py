"""In-process concurrency limiter. Ports bb-pm-tools/src/concurrency.ts.

Caps simultaneous LLM-bound turns so a slow upstream cannot pile up unbounded
work. Fast-path turns bypass this (they only hit the DB).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass

from core.config import settings


@dataclass
class _Metrics:
    in_flight: int = 0
    queue_depth: int = 0
    rejected: int = 0
    acquired: int = 0


_metrics = _Metrics()
_semaphore = asyncio.Semaphore(settings.concurrency.max_concurrent)


def get_metrics() -> dict[str, int]:
    return {
        "in_flight": _metrics.in_flight,
        "queue_depth": _metrics.queue_depth,
        "rejected": _metrics.rejected,
        "acquired": _metrics.acquired,
        "max_concurrent": settings.concurrency.max_concurrent,
    }


@asynccontextmanager
async def acquire_slot():
    """Acquire a concurrency slot. Raises TimeoutError if the queue is full
    or the wait exceeds the configured timeout."""
    if _metrics.queue_depth >= settings.concurrency.max_queue:
        _metrics.rejected += 1
        raise TimeoutError("agent queue full")
    _metrics.queue_depth += 1
    try:
        await asyncio.wait_for(
            _semaphore.acquire(),
            timeout=settings.concurrency.acquire_timeout_ms / 1000,
        )
    except asyncio.TimeoutError as err:
        _metrics.rejected += 1
        raise TimeoutError("agent slot acquire timeout") from err
    finally:
        _metrics.queue_depth -= 1
    _metrics.in_flight += 1
    _metrics.acquired += 1
    try:
        yield
    finally:
        _metrics.in_flight -= 1
        _semaphore.release()
