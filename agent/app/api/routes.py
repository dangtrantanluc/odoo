from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from domain.schemas import ChatWebhook, ParseCheckinRequest, ReminderRunRequest
from infrastructure.gapo_client import GapoClient
from infrastructure.llm_client import LlmClient
from services.checkins import CheckinService
from services.reminders import ReminderService

logger = logging.getLogger(__name__)


def build_router(
    *,
    checkins: CheckinService,
    reminders: ReminderService,
    gapo: GapoClient,
    llm: LlmClient,
) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.post("/webhook/checkin")
    async def webhook_checkin(event: ChatWebhook) -> dict[str, Any]:
        return await checkins.handle_checkin(event)

    async def process_gapo_webhook(payload: dict[str, Any], route: str) -> dict[str, Any]:
        event = gapo.parse_webhook_payload(payload)
        logger.warning(
            "gapo_webhook_received %s",
            json.dumps({"route": route, "raw_payload": payload, "normalized": event.model_dump(mode="json")}, ensure_ascii=False, default=str),
        )
        checkin = ChatWebhook(
            channel="gapo",
            external_id=event.external_id or event.thread_id or "",
            thread_id=event.thread_id,
            text=event.text,
        )
        try:
            result = await checkins.handle_checkin(checkin)
        except HTTPException as exc:
            logger.warning(
                "gapo_webhook_processing_failed %s",
                json.dumps({"route": route, "status_code": exc.status_code, "detail": exc.detail, "normalized": event.model_dump(mode="json")}, ensure_ascii=False, default=str),
            )
            return {"ok": True, "received": True, "processed": False, "error": {"statusCode": exc.status_code, "detail": exc.detail}, "gapo": event.model_dump(mode="json")}
        except Exception as exc:
            logger.exception(
                "gapo_webhook_unhandled_error %s",
                json.dumps({"route": route, "error": str(exc), "normalized": event.model_dump(mode="json")}, ensure_ascii=False, default=str),
            )
            return {"ok": True, "received": True, "processed": False, "error": {"statusCode": 500, "detail": str(exc)}, "gapo": event.model_dump(mode="json")}
        return {"ok": True, "received": True, "processed": True, **result, "gapo": event.model_dump(mode="json")}

    @router.post("/webhook/gapo")
    async def webhook_gapo(payload: dict[str, Any]) -> dict[str, Any]:
        result = await process_gapo_webhook(payload, route="/webhook/gapo")
        if not result.get("processed"):
            return result
        gapo_event = result.get("gapo")
        conversation_id = None
        if isinstance(gapo_event, dict):
            conversation_id = gapo_event.get("conversation_id") or gapo_event.get("thread_id")
        sent = await gapo.send_message(conversation_id if isinstance(conversation_id, str) else None, str(result.get("reply", "")))
        return {**result, "sent": sent}

    @router.post("/webhook/gapo/process")
    async def webhook_gapo_process(payload: dict[str, Any]) -> dict[str, Any]:
        return await process_gapo_webhook(payload, route="/webhook/gapo/process")

    @router.post("/debug/normalize-gapo")
    async def debug_normalize_gapo(payload: dict[str, Any]) -> dict[str, Any]:
        event = gapo.parse_webhook_payload(payload)
        return {"normalized": event.model_dump(mode="json")}

    @router.post("/debug/parse-checkin")
    async def debug_parse_checkin(payload: ParseCheckinRequest) -> dict[str, Any]:
        parsed = await llm.parse_checkin(payload.text)
        return {"input": payload.text, "structured": parsed.model_dump(mode="json")}

    @router.post("/reminders/run")
    async def run_reminder(payload: ReminderRunRequest) -> dict[str, Any]:
        return await reminders.run(payload)

    return router
