"""Agent HTTP routes — orchestrator turn entry, metrics, health.

Replaces the OpenClaw bb-pm-tools plugin routes. The agent/run endpoint is
channel-agnostic: any caller POSTs a turn and gets a reply.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from core.deps import container
from orchestrator import telemetry
from orchestrator.concurrency import get_metrics
from shared.types import TurnRequest


def build_agent_router() -> APIRouter:
    router = APIRouter(tags=["agent"])

    @router.post("/api/plugins/bb-pm/agent/run")
    async def agent_run(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return JSONResponse(status_code=400, content={"error": "invalid JSON body"})
        text = str(body.get("text") or "").strip()
        if not text:
            return JSONResponse(status_code=400, content={"error": "missing `text`"})

        turn = TurnRequest(
            text=text,
            source=body.get("source") or "chat",
            conversation_id=body.get("conversationId") or body.get("conversation_id"),
            external_id=body.get("externalId") or body.get("external_id"),
            correlation_id=body.get("correlationId") or body.get("correlation_id"),
            event_type=body.get("eventType"),
            metadata=body.get("metadata") or {},
        )
        reply = await container.run_turn(turn)
        return JSONResponse(status_code=200, content=reply.model_dump())

    @router.get("/api/plugins/bb-pm/agent/metrics")
    async def agent_metrics() -> dict[str, Any]:
        checkin = container.checkin.telemetry_snapshot() if container.checkin else {}
        return {
            "telemetry": telemetry.snapshot(),
            "concurrency": get_metrics(),
            "checkin": checkin,
        }

    @router.get("/api/plugins/bb-pm/health")
    async def agent_health() -> dict[str, Any]:
        return {"status": "ok", "orchestrator": container.orchestrator is not None}

    return router
