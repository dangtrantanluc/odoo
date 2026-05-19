"""PM Agent service — FastAPI application entry point.

Standalone replacement for the OpenClaw gateway + plugins. Wires the
dependency container, mounts the channel + debug routes, and (from Phase 4+)
the orchestrator route and the workflow scheduler.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes_agent import build_agent_router
from app.api.routes_debug import build_debug_router
from app.api.routes_gapo import build_gapo_router
from core.config import assert_config, settings
from core.deps import container
from core.logging import configure_logging, log_event


@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    missing = assert_config(settings)
    if missing:
        log_event("config.incomplete", level="warning", missing=missing)
    await container.startup()
    log_event("service.started", port=settings.port,
              llm_provider=settings.llm.active_provider)
    yield
    await container.shutdown()
    log_event("service.stopped")


app = FastAPI(title="BB-PM Agent", lifespan=lifespan)
app.include_router(build_agent_router())
app.include_router(build_gapo_router())
app.include_router(build_debug_router())


@app.get("/health")
async def health() -> dict[str, object]:
    checks: dict[str, object] = {"service": "ok"}
    if container.bbpm is not None:
        try:
            await container.bbpm.health()
            checks["bb_pm_api"] = "ok"
        except Exception as err:  # noqa: BLE001
            checks["bb_pm_api"] = f"error: {err}"
    checks["redis"] = "ok" if container.redis.available else "unavailable"
    status = "ok" if all(v == "ok" or v == "unavailable" for v in checks.values()) else "degraded"
    return {"status": status, "checks": checks}
