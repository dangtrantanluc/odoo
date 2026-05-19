"""Gapo channel HTTP routes — webhook (inbound), send (outbound), health.

Replaces the OpenClaw gapo-agent plugin routes. Webhook is public (Gapo bot
posts here); send is guarded by the X-Plugin-Token header.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse

from channel.gapo.models import QuickRepliesBody, QuickReplyOption, TextBody
from core.config import settings
from core.deps import container


def build_gapo_router() -> APIRouter:
    router = APIRouter(tags=["gapo"])
    cfg = settings.gapo

    @router.post(cfg.webhook_path)
    async def gapo_webhook(request: Request) -> JSONResponse:
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return JSONResponse(status_code=400, content={"error": "invalid JSON body"})
        if not isinstance(payload, dict):
            return JSONResponse(status_code=400, content={"error": "payload must be an object"})
        assert container.gapo_handler is not None
        result = await container.gapo_handler.handle_webhook(payload)
        return JSONResponse(status_code=200, content=result)

    @router.post(cfg.send_path)
    async def gapo_send(
        request: Request,
        x_plugin_token: Optional[str] = Header(default=None),
    ) -> JSONResponse:
        if cfg.send_token and x_plugin_token != cfg.send_token:
            return JSONResponse(status_code=401, content={"error": "invalid plugin token"})
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return JSONResponse(status_code=400, content={"error": "invalid JSON body"})

        conversation_id = payload.get("conversationId") or payload.get("conversation_id")
        text = payload.get("text") or ""
        if not conversation_id:
            return JSONResponse(status_code=400, content={"error": "conversationId required"})

        body = _parse_body(payload.get("body"), text)
        if body is None and not text:
            return JSONResponse(status_code=400, content={"error": "text or body required"})

        assert container.gapo_handler is not None
        result = await container.gapo_handler.handle_send(conversation_id, text, body)
        return JSONResponse(status_code=200 if result.sent else 502,
                            content=result.model_dump())

    @router.get(f"{cfg.webhook_path.rsplit('/', 1)[0]}/health")
    async def gapo_health() -> dict[str, Any]:
        assert container.gapo_handler is not None
        return {"ok": True, **container.gapo_handler.health()}

    return router


def _parse_body(raw: Any, text: str) -> Optional[TextBody | QuickRepliesBody]:
    if not isinstance(raw, dict):
        return None
    if raw.get("type") == "quick_replies":
        options = raw.get("metadata", {}).get("options", [])
        return QuickRepliesBody(
            text=raw.get("text") or text,
            options=[
                QuickReplyOption(title=o.get("title", ""), payload=o.get("payload", ""))
                for o in options if isinstance(o, dict)
            ],
        )
    if raw.get("type") == "text":
        return TextBody(text=raw.get("text") or text,
                        is_markdown_text=bool(raw.get("is_markdown_text", True)))
    return None
