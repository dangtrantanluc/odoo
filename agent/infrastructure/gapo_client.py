from __future__ import annotations

import re
from typing import Any

import httpx
from fastapi import HTTPException
from logging import getLogger
from core.config import Settings
from domain.schemas import GapoNormalizedEvent

logger = getLogger(__name__)


class GapoClient:
    """Small adapter for receiving/sending Gapo messages directly.

    This client is intentionally independent from OpenClaw/gapo-agent. It uses
    the Python agent's own BOT_TOKEN and Gapo 3rd-bot API URL.
    """

    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(20.0))

    async def close(self) -> None:
        await self.client.aclose()

    def parse_webhook_payload(self, payload: dict[str, Any]) -> GapoNormalizedEvent:
        text = first_string(
            payload.get("text"),
            dig(payload, "message", "text"),
            dig(payload, "data", "text"),
            dig(payload, "event", "text"),
        )
        if not text:
            raise HTTPException(status_code=400, detail="Missing Gapo message text")

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

        normalized_conversation_id = (
            ensure_gapo_prefix(raw_thread_id) if raw_thread_id else None
        )
        correlation_id = first_string(
            payload.get("correlationId"),
            payload.get("correlation_id"),
        )
        if not correlation_id and raw_thread_id:
            correlation_id = f"gapo-{raw_thread_id}"

        return GapoNormalizedEvent(
            text=text.strip(),
            conversation_id=normalized_conversation_id,
            external_id=external_id,
            thread_id=raw_thread_id,
            sender_name=sender_name,
            correlation_id=correlation_id,
        )

    async def send_message(self, conversation_id: str | None, text: str) -> dict[str, Any]:
        target = parse_conversation_target(conversation_id)
        if not target:
            return {
                "skipped": True,
                "reason": "missing conversationId/threadId",
                "conversationId": conversation_id,
                "text": text,
            }
        if not self.settings.gapo_api_url:
            return {
                "skipped": True,
                "reason": "GAPO_API_URL is empty",
                "conversationId": conversation_id,
                "text": text,
            }
        if not self.settings.bot_token:
            return {
                "skipped": True,
                "reason": "BOT_TOKEN is empty",
                "conversationId": conversation_id,
                "text": text,
            }

        auth_value = self.settings.bot_token
        if self.settings.gapo_auth_prefix:
            auth_value = f"{self.settings.gapo_auth_prefix} {auth_value}"
        headers = {
            "Content-Type": "application/json",
            self.settings.gapo_auth_header: auth_value,
        }
        request_body: dict[str, Any] = {**target, "body": {"type": "text", "text": text}}
        if self.settings.gapo_bot_id:
            request_body["bot_id"] = parse_numeric_if_possible(self.settings.gapo_bot_id)

        res = await self.client.post(
            self.settings.gapo_api_url,
            headers=headers,
            json=request_body,
        )
        if res.status_code >= 400:
            response_body = res.text
            return {
                "sent": False,
                "reason": "error",
                "statusCode": res.status_code,
                "message": response_body[:500],
                "conversationId": conversation_id,
                "requestBody": request_body,
            }
        response = res.json() if res.content else {"ok": True}
        return {"sent": True, "conversationId": conversation_id, "response": response}


def dig(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def first_string(*values: Any) -> str | None:
    for value in values:
        if value is None:
            continue
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def strip_gapo_prefix(value: str | None) -> str | None:
    if not value:
        return None
    trimmed = value.strip()
    match = re.match(r"^gapo:(.+)$", trimmed, re.IGNORECASE)
    return match.group(1) if match else trimmed


def ensure_gapo_prefix(value: str | None) -> str | None:
    if not value:
        return None
    return value if value.lower().startswith("gapo:") else f"gapo:{value}"


def parse_numeric_if_possible(value: str) -> str | int:
    return int(value) if value.isdigit() else value


def parse_conversation_target(value: str | None) -> dict[str, str] | None:
    raw = strip_gapo_prefix(value)
    if not raw:
        return None
    if raw.lower().startswith("dm:"):
        return {"receiver_id": raw[3:]}
    if raw.lower().startswith("collab:"):
        return {"collab_id": raw[7:]}
    return {"thread_id": raw}
