from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from core.config import settings
from infrastructure.bbpm_client import BbPmClient
from infrastructure.gapo_client import GapoClient
from infrastructure.llm_client import LlmClient
from services.checkins import CheckinService
from services.reminders import ReminderService
from .api.routes import build_router


bbpm = BbPmClient(settings)
llm = LlmClient(settings)
gapo = GapoClient(settings)
checkins = CheckinService(bbpm, llm)
reminders = ReminderService(bbpm, gapo)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await bbpm.close()
    await llm.close()
    await gapo.close()


app = FastAPI(title="BB-PM Python Agent", lifespan=lifespan)
app.include_router(build_router(checkins=checkins, reminders=reminders, gapo=gapo, llm=llm))
