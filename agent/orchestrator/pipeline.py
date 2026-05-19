"""Orchestrator pipeline — routes one conversational turn.

Ports the layered routing of bb-pm-tools/src/webhook.ts:

    rate-limit → dedup → check-in → action → fast-path → NL-read → no-match

The ReAct LLM agent was removed upstream (Phương án C′); turns that match no
layer get a short help message instead.
"""

from __future__ import annotations

import re
import time
from typing import Optional

from checkin.service import CheckinService
from core.logging import log_event
from infrastructure.bbpm_client import BbPmClient
from orchestrator import telemetry
from orchestrator.caller_cache import resolve_caller
from orchestrator.dedup import check_duplicate
from orchestrator.rate_limit import check_rate_limit
from routing.action_router import ActionRouter
from routing.fast_path.router import FastPathRouter
from routing.read_router import ReadRouter
from shared.text import strip_markdown_for_gapo
from shared.types import TurnReply, TurnRequest

_SLASH = re.compile(r"^\s*/[a-z][a-z0-9_-]*", re.IGNORECASE)
_CHECKIN_CMD = re.compile(r"^\s*/(?:checkin|worklog|project)\b", re.IGNORECASE)

_NO_MATCH = (
    "Mình chưa hiểu yêu cầu này. Gõ /help để xem các lệnh, "
    "hoặc /checkin để cập nhật worklog."
)


class Orchestrator:
    def __init__(
        self,
        bbpm: BbPmClient,
        checkin: CheckinService,
        fast_path: FastPathRouter,
        action: ActionRouter,
        read: ReadRouter,
    ) -> None:
        self._bbpm = bbpm
        self._checkin = checkin
        self._fast_path = fast_path
        self._action = action
        self._read = read

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

        # 4. check-in (first, unless this is a non-checkin slash command)
        prefer_checkin = bool(_CHECKIN_CMD.match(text)) or not is_slash
        if prefer_checkin:
            result = await self._checkin.handle_turn(text, request)
            if result is not None:
                return self._done(request, started, "checkin", reply=result.reply,
                                  channel_reply=result.channel_reply, pattern=result.pattern)

        # 5. action router (natural-language writes with confirm)
        action = await self._action.handle(text, request)
        if action is not None:
            return self._done(request, started, "action", reply=action[0], pattern=action[1])

        # 6. fast-path (slash commands + VN patterns)
        fast = await self._fast_path.try_fast_path(text, request)
        if fast is not None:
            return self._done(request, started, "fast_path", reply=fast[0], pattern=fast[1])

        # 7. NL-to-SQL read
        if is_chat:
            read = await self._read.try_read(text, request, company_id)
            if read is not None:
                return self._done(request, started, "read", reply=read[0], pattern=read[1])

        # 8. no match
        return self._done(request, started, "no_match", reply=_NO_MATCH)

    @staticmethod
    def _done(request, started, mode, *, reply, channel_reply=None, pattern=None) -> TurnReply:
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
