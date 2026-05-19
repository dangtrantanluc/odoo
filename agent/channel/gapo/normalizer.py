"""Normalize raw Gapo Work webhook payloads into a GapoNormalizedEvent.

Faithful port of gapo-agent/src/normalizer.ts — including the `should_process`
filter that decides whether a webhook event reaches the orchestrator.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from channel.gapo.models import GapoNormalizedEvent, Mention

_GAPO_PREFIX = re.compile(r"^gapo:(.+)$", re.IGNORECASE)
_PROCESSABLE_TYPES = {"text", "quick_reply", "menu"}


def dig(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def first_string(*values: Any) -> Optional[str]:
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value == value:  # finite check
            return str(value)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def strip_gapo_prefix(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    trimmed = value.strip()
    match = _GAPO_PREFIX.match(trimmed)
    return match.group(1) if match else trimmed


def ensure_gapo_prefix(value: str) -> str:
    return value if value.lower().startswith("gapo:") else f"gapo:{value}"


def _normalize_mentions(value: Any) -> list[Mention]:
    if not isinstance(value, list):
        return []
    result: list[Mention] = []
    for entry in value:
        if not isinstance(entry, dict):
            continue
        target = first_string(entry.get("target"))
        if not target:
            continue
        result.append(
            Mention(
                target=target,
                length=entry["length"] if isinstance(entry.get("length"), int) else None,
                offset=entry["offset"] if isinstance(entry.get("offset"), int) else None,
            )
        )
    return result


def normalize_gapo_payload(payload: dict[str, Any]) -> GapoNormalizedEvent:
    event_type = first_string(payload.get("event"))
    text = first_string(
        payload.get("text"),
        dig(payload, "message", "text"),
        dig(payload, "data", "text"),
        dig(payload, "event", "text"),
    )
    conversation_id = first_string(
        payload.get("conversationId"),
        payload.get("conversation_id"),
        payload.get("threadId"),
        payload.get("thread_id"),
        dig(payload, "message", "thread", "id"),
        dig(payload, "message", "thread_id"),
        dig(payload, "message", "conversationId"),
        dig(payload, "data", "conversationId"),
    )
    raw_thread_id = strip_gapo_prefix(conversation_id)

    sender_id = first_string(
        payload.get("from_user_id"),
        payload.get("externalId"),
        payload.get("external_id"),
        payload.get("senderId"),
        payload.get("sender_id"),
        dig(payload, "message", "sender", "id"),
        dig(payload, "message", "user", "id"),
        dig(payload, "message", "from", "id"),
        dig(payload, "sender", "id"),
        dig(payload, "user", "id"),
        dig(payload, "from", "id"),
    )
    external_id = strip_gapo_prefix(sender_id or raw_thread_id)
    from_user_id = first_string(payload.get("from_user_id"), sender_id)
    to_bot_id = first_string(payload.get("to_bot_id"))
    message_id = first_string(dig(payload, "message", "id"))
    message_type = first_string(dig(payload, "message", "type"))
    message_payload = first_string(dig(payload, "message", "payload"))
    mentions = _normalize_mentions(dig(payload, "message", "metadata", "mentions"))
    thread_type = first_string(dig(payload, "message", "thread", "type"))

    sender_name = first_string(
        payload.get("senderName"),
        payload.get("sender_name"),
        dig(payload, "message", "sender", "name"),
        dig(payload, "message", "sender", "display_name"),
        dig(payload, "message", "user", "name"),
        dig(payload, "message", "from", "name"),
        dig(payload, "sender", "name"),
        dig(payload, "user", "name"),
        dig(payload, "from", "name"),
    )

    normalized_conversation_id = ensure_gapo_prefix(raw_thread_id) if raw_thread_id else None
    correlation_id = first_string(
        payload.get("correlationId"), payload.get("correlation_id")
    ) or (f"gapo-{raw_thread_id}" if raw_thread_id else None)

    if message_type == "menu" and message_payload and message_payload.strip().startswith("/"):
        effective_text: Optional[str] = message_payload.strip()
    else:
        effective_text = text.strip() if text else None

    processable_type = (not message_type) or message_type in _PROCESSABLE_TYPES
    is_group_message = bool(thread_type and thread_type != "direct")
    is_command = bool(effective_text and effective_text.strip().startswith("/"))
    bot_mentioned = bool(
        to_bot_id and any(m.target == to_bot_id for m in mentions)
    )

    should_process = (
        ((not event_type) or event_type == "message_created")
        and processable_type
        and (
            (not is_group_message)
            or is_command
            or bot_mentioned
            or message_type in {"quick_reply", "menu"}
        )
        and bool(effective_text and effective_text.strip())
    )

    return GapoNormalizedEvent(
        event_type=event_type,
        text=effective_text,
        conversation_id=normalized_conversation_id,
        external_id=external_id,
        from_user_id=from_user_id,
        thread_id=raw_thread_id,
        to_bot_id=to_bot_id,
        message_id=message_id,
        message_type=message_type,
        payload=message_payload,
        mentions=mentions,
        is_group_message=is_group_message,
        sender_name=sender_name,
        correlation_id=correlation_id,
        should_process=should_process,
    )
