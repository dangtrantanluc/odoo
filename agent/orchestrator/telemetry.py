"""Lightweight run telemetry. Ports bb-pm-tools/src/telemetry.ts.

Counts agent turns by outcome mode; exposed via /agent/metrics.
"""

from __future__ import annotations

import time
from collections import Counter

_modes: Counter[str] = Counter()
_total_ms = 0
_count = 0
_started_at = time.time()


def record_run(mode: str, total_ms: int) -> None:
    global _total_ms, _count
    _modes[mode] += 1
    _total_ms += total_ms
    _count += 1


def snapshot() -> dict[str, object]:
    return {
        "uptime_sec": int(time.time() - _started_at),
        "total_runs": _count,
        "avg_ms": int(_total_ms / _count) if _count else 0,
        "by_mode": dict(_modes),
    }
