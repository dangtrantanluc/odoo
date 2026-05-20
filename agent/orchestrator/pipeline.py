"""Orchestrator pipeline — pre-process → Intent Router → 1 trong 2 agent.

Trước đây pipeline là chuỗi tuần tự (checkin → action → fast-path → NL-SQL).
Sau refactor:
  - pre-process: rate-limit → dedup → resolve identity (giữ nguyên).
  - dispatch: IntentRouter.classify(...) ∈ {PLANNING, DAILY} →
        PlanningAgent.handle_turn(...)   |   DailyExecutionAgent.handle(...)

DailyExecutionAgent đóng gói nguyên chuỗi cũ — không đổi behavior nhánh
hằng-ngày.
"""

from __future__ import annotations

import re
import time
from typing import Optional

from core.logging import log_event
from infrastructure.bbpm_client import BbPmClient
from orchestrator import telemetry
from orchestrator.caller_cache import resolve_caller
from orchestrator.daily_agent import DailyExecutionAgent
from orchestrator.dedup import check_duplicate
from orchestrator.rate_limit import check_rate_limit
from planning.service import PlanningAgent
from routing.intent_router import IntentBranch, IntentRouter
from shared.text import strip_markdown_for_gapo
from shared.types import ReplyBody, TurnReply, TurnRequest

_SLASH = re.compile(r"^\s*/[a-z][a-z0-9_-]*", re.IGNORECASE)


class Orchestrator:
    def __init__(
        self,
        bbpm: BbPmClient,
        intent: IntentRouter,
        planning: PlanningAgent,
        daily: DailyExecutionAgent,
    ) -> None:
        self._bbpm = bbpm
        self._intent = intent
        self._planning = planning
        self._daily = daily

    async def handle(self, request: TurnRequest) -> TurnReply:
        started = time.monotonic()
        text = (request.text or "").strip()
        if not text:
            return self._done(request, started, "empty", reply="")

        is_chat = request.source == "chat"
        is_slash = bool(_SLASH.match(text))

        # 1. rate limit (chat only)
        if is_chat:
            rl_key = (f"cid:{request.correlation_id}" if request.correlation_id
                      else f"conv:{request.conversation_id}")
            rl = await check_rate_limit(rl_key)
            if not rl.ok:
                return self._done(request, started, "rate_limited",
                                  reply="Bạn thao tác hơi nhanh, thử lại sau giây lát nhé.")

        # 2. dedup re-send (chat, non-slash) — silent skip
        if is_chat and request.conversation_id and not is_slash:
            if check_duplicate(request.conversation_id, text):
                log_event("pipeline.dedup", correlation_id=request.correlation_id)
                return TurnReply(reply="", dedup=True, silent=True, mode="dedup",
                                 request_id=request.correlation_id)

        # 3. resolve caller identity
        company_id: Optional[int] = None
        if request.external_id and request.caller_user_id is None:
            thread_id = (request.metadata or {}).get("thread_id")
            user = await resolve_caller(self._bbpm, request.external_id, thread_id)
            if user:
                request.caller_user_id = user.get("id")
                company_id = user.get("companyId") or user.get("company_id")
                # gắn role + company vào metadata để PlanningAgent kiểm RBAC
                meta = request.metadata or {}
                if not isinstance(meta, dict):
                    meta = {}
                if user.get("role"):
                    meta["role"] = user.get("role")
                if user.get("isSuperAdmin"):
                    meta["is_super_admin"] = True
                if company_id is not None:
                    meta["company_id"] = company_id
                request.metadata = meta

        # 4. Intent Router → dispatch 2 nhánh
        branch = await self._intent.classify(text, request)

        if branch == IntentBranch.PLANNING:
            reply, channel_reply, pattern = await self._planning.handle_turn(text, request)
            return self._done(request, started, "planning", reply=reply,
                              channel_reply=channel_reply, pattern=pattern)

        reply, channel_reply, mode, pattern = await self._daily.handle(
            text, request, company_id
        )
        return self._done(request, started, mode, reply=reply,
                          channel_reply=channel_reply, pattern=pattern)

    @staticmethod
    def _done(request, started, mode, *, reply, channel_reply: Optional[ReplyBody] = None,
              pattern: Optional[str] = None) -> TurnReply:
        total_ms = int((time.monotonic() - started) * 1000)
        telemetry.record_run(mode, total_ms)
        log_event("pipeline.turn", mode=mode, pattern=pattern, total_ms=total_ms,
                  correlation_id=request.correlation_id)
        return TurnReply(
            reply=strip_markdown_for_gapo(reply) if reply else reply,
            channel_reply=channel_reply,
            request_id=request.correlation_id,
            pattern=pattern,
            mode=mode,
        )
