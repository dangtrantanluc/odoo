"""Gapo Work 3rd-bot API client.

Ports gapo-agent/src/gapo-client.ts. Sends text / quick_replies / mention
messages. Supports dry-run. The agent holds the Gapo bot credential here and
nowhere else (channel-isolation boundary).
"""

from __future__ import annotations

import re
from typing import Any, Optional

import httpx

from channel.gapo.models import GapoSendResult, QuickRepliesBody, QuickReplyOption, TextBody
from core.config import settings
from core.logging import log_io

_DM_PREFIX = re.compile(r"^dm:", re.IGNORECASE)
_COLLAB_PREFIX = re.compile(r"^collab:", re.IGNORECASE)
_GAPO_PREFIX = re.compile(r"^gapo:(.+)$", re.IGNORECASE)


def _strip_gapo_prefix(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    trimmed = value.strip()
    match = _GAPO_PREFIX.match(trimmed)
    return match.group(1) if match else trimmed


def build_text_body(text: str) -> TextBody:
    return TextBody(text=text, is_markdown_text=True)


def build_quick_replies_body(text: str, options: list[QuickReplyOption]) -> QuickRepliesBody:
    return QuickRepliesBody(text=text, options=options)


def build_mention_text_body(text: str, mention_name: str, target_user_id: str) -> TextBody:
    return TextBody(
        text=f"[@{mention_name}](https://www.gapowork.vn/profile/{target_user_id}) {text}",
        is_markdown_text=True,
    )


def build_quick_reply_fallback_text(body: QuickRepliesBody) -> str:
    """Plain-text fallback when the channel cannot render quick-reply buttons."""
    if re.search(r"nếu không thấy nút", body.text, re.IGNORECASE):
        return body.text
    choices = "\n".join(f"{i + 1}. {o.title}" for i, o in enumerate(body.options))
    return f"{body.text}\n\nNếu không thấy nút, trả lời bằng số:\n{choices}"


def parse_conversation_target(value: Optional[str]) -> Optional[dict[str, str]]:
    raw = _strip_gapo_prefix(value)
    if not raw:
        return None
    if _DM_PREFIX.match(raw):
        return {"receiver_id": raw[3:]}
    if _COLLAB_PREFIX.match(raw):
        return {"collab_id": raw[7:]}
    return {"thread_id": raw}


def _body_to_gapo(body: TextBody | QuickRepliesBody) -> dict[str, Any]:
    if isinstance(body, QuickRepliesBody):
        return body.to_gapo()
    return body.model_dump()


class GapoClient:
    def __init__(self) -> None:
        self._cfg = settings.gapo
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))

    async def close(self) -> None:
        await self._http.aclose()

    def build_request(
        self, conversation_id: str, body: TextBody | QuickRepliesBody
    ) -> Optional[dict[str, Any]]:
        target = parse_conversation_target(conversation_id)
        if target is None:
            return None
        request: dict[str, Any] = {**target, "body": _body_to_gapo(body)}
        if self._cfg.bot_id:
            request["bot_id"] = int(self._cfg.bot_id) if self._cfg.bot_id.isdigit() else self._cfg.bot_id
        return request

    async def send(
        self,
        conversation_id: str,
        body: Optional[TextBody | QuickRepliesBody] = None,
        *,
        text: str = "",
    ) -> GapoSendResult:
        message = body if body is not None else build_text_body(text)
        request = self.build_request(conversation_id, message)
        if request is None:
            return GapoSendResult(sent=False, conversation_id=conversation_id,
                                  message="missing conversationId/threadId")
        if not self._cfg.bot_token and not self._cfg.dry_run:
            return GapoSendResult(sent=False, conversation_id=conversation_id,
                                  message="GAPO_BOT_TOKEN is empty")

        preview = message.text[:120] if hasattr(message, "text") else ""
        if self._cfg.dry_run:
            log_io("gapo.send.dry_run", conversation_id=conversation_id, request=request)
            return GapoSendResult(sent=True, conversation_id=conversation_id,
                                  response={"dryRun": True})

        auth_value = (
            f"{self._cfg.auth_prefix} {self._cfg.bot_token}"
            if self._cfg.auth_prefix
            else self._cfg.bot_token
        )
        try:
            res = await self._http.post(
                self._cfg.api_url,
                headers={"Content-Type": "application/json", self._cfg.auth_header: auth_value},
                json=request,
            )
        except httpx.HTTPError as err:
            log_io("gapo.send.error", conversation_id=conversation_id, error=str(err))
            return GapoSendResult(sent=False, conversation_id=conversation_id, message=str(err))

        if res.status_code >= 400:
            log_io("gapo.send.error", conversation_id=conversation_id,
                   status=res.status_code, body=res.text[:500])
            return GapoSendResult(sent=False, conversation_id=conversation_id,
                                  status_code=res.status_code, message=res.text[:500])
        log_io("gapo.send.ok", conversation_id=conversation_id, preview=preview)
        try:
            response: Any = res.json()
        except ValueError:
            response = res.text or {"ok": True}
        return GapoSendResult(sent=True, conversation_id=conversation_id, response=response)
