"""Structured JSON logging for the PM Agent service.

Mirrors the `channelLog` / `webhookLog` helpers in the TypeScript plugins:
single-line JSON events, truncated to a max length so large payloads do not
flood the container log.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any

from core.config import settings

_LOGGER = logging.getLogger("pm_agent")


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    _LOGGER.handlers = [handler]
    _LOGGER.setLevel(level)
    _LOGGER.propagate = False


def _truncate(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return f"{value[:max_chars]}…[truncated {len(value) - max_chars} chars]"


def log_event(event: str, level: str = "info", **fields: Any) -> None:
    """Emit one structured JSON log line."""
    if not settings.io_log_enabled and level == "debug":
        return
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    try:
        line = json.dumps(payload, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        line = json.dumps({"ts": payload["ts"], "event": event}, ensure_ascii=False)
    line = _truncate(line, settings.io_log_max_chars)
    getattr(_LOGGER, level, _LOGGER.info)(line)


def log_io(event: str, **fields: Any) -> None:
    """Emit an I/O trace event (request/response). Suppressed if io_log disabled."""
    if not settings.io_log_enabled:
        return
    log_event(event, level="info", **fields)
