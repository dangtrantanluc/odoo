"""Dependency container — process-wide singletons.

Built once at startup (FastAPI lifespan) and shared by routes, the channel
handler, the orchestrator and the scheduler.
"""

from __future__ import annotations

from typing import Optional

from channel.gapo.client import GapoClient
from channel.gapo.handler import GapoHandler
from checkin.service import CheckinService
from infrastructure.bbpm_client import BbPmClient
from infrastructure.llm_client import LlmClient
from infrastructure.redis import redis_client
from orchestrator.pipeline import Orchestrator
from reporting.nl_to_sql.translator import NlToSqlTranslator
from routing.action_router import ActionRouter
from routing.fast_path.router import FastPathRouter
from routing.read_router import ReadRouter
from shared.types import TurnReply, TurnRequest
from tools.catalog import ToolCatalog
from workflows.registry import WorkflowRegistry
from workflows.scheduler import AgentScheduler


class Container:
    def __init__(self) -> None:
        self.bbpm: Optional[BbPmClient] = None
        self.llm: Optional[LlmClient] = None
        self.gapo_client: Optional[GapoClient] = None
        self.gapo_handler: Optional[GapoHandler] = None
        self.catalog: Optional[ToolCatalog] = None
        self.checkin: Optional[CheckinService] = None
        self.orchestrator: Optional[Orchestrator] = None
        self.registry: Optional[WorkflowRegistry] = None
        self.scheduler: Optional[AgentScheduler] = None
        self.redis = redis_client

    async def run_turn(self, request: TurnRequest) -> TurnReply:
        """Channel-agnostic entry point. Delegates to the orchestrator pipeline."""
        if self.orchestrator is None:
            return TurnReply(reply="Agent đang khởi động, bạn thử lại sau giây lát nhé.")
        return await self.orchestrator.handle(request)

    async def startup(self) -> None:
        self.bbpm = BbPmClient()
        self.llm = LlmClient()
        self.catalog = ToolCatalog(self.bbpm)
        self.checkin = CheckinService(self.bbpm, self.llm)
        fast_path = FastPathRouter(self.catalog)
        action = ActionRouter(self.catalog)
        translator = NlToSqlTranslator(self.bbpm, self.llm)
        read = ReadRouter(translator)
        self.orchestrator = Orchestrator(self.bbpm, self.checkin, fast_path, action, read)
        self.gapo_client = GapoClient()
        self.gapo_handler = GapoHandler(self.gapo_client, self.run_turn)
        await self.redis.connect()
        self.registry = WorkflowRegistry(self.bbpm, self.catalog, self.gapo_client, self.checkin)
        self.scheduler = AgentScheduler(self.registry, self.bbpm)
        self.scheduler.start()

    async def shutdown(self) -> None:
        if self.scheduler is not None:
            self.scheduler.shutdown()
        if self.bbpm is not None:
            await self.bbpm.close()
        if self.llm is not None:
            await self.llm.close()
        if self.gapo_client is not None:
            await self.gapo_client.close()
        await self.redis.close()


container = Container()
