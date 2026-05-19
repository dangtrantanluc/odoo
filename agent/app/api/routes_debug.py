"""Debug / introspection routes — not part of the production surface."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from channel.gapo.normalizer import normalize_gapo_payload


def build_debug_router() -> APIRouter:
    router = APIRouter(prefix="/debug", tags=["debug"])

    @router.post("/normalize-gapo")
    async def normalize_gapo(request: Request) -> JSONResponse:
        payload = await request.json()
        if not isinstance(payload, dict):
            return JSONResponse(status_code=400, content={"error": "payload must be an object"})
        event = normalize_gapo_payload(payload)
        return JSONResponse(status_code=200, content={"normalized": event.model_dump()})

    return router
