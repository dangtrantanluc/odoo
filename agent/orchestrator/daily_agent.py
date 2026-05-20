"""Daily Execution Agent — kiến trúc LLM-first (Option B).

Pipeline mới (LLM_FIRST_ROUTING=true):

  ① Kiểm pending action (Redis) — user trả "ok"/"hủy" → exec/cancel
  ② Active state machine? (checkin / planning session) → handle_turn cũ
  ③ Slash command "/xxx"? → FastPathRouter (slash dict only)
  ④ LlmIntentRouter.classify() → IntentResult
  ⑤ Dispatcher.dispatch(result, text, ctx, company_id, memory) → reply

Pipeline cũ (LLM_FIRST_ROUTING=false) giữ làm rollback path: chuỗi tuần tự
checkin → action → fast-path → smalltalk → read → llm_fallback → no_match.
"""

from __future__ import annotations

import re
from typing import Optional

from checkin.service import CheckinService
from core.config import settings
from core.logging import log_event
from infrastructure.bbpm_client import BbPmClient
from orchestrator.conversation_memory import (
    ConversationMemory,
    has_pronoun_reference,
)
from routing.action_router import ActionRouter
from routing.dispatcher import Dispatcher
from routing.fast_path.router import FastPathRouter
from routing.llm_intent_fallback import LlmIntentFallback
from routing.llm_intent_router import LlmIntentRouter
from routing.read_router import ReadRouter
from routing.smalltalk_router import SmallTalkRouter
from shared.types import ReplyBody, TurnRequest


_SLASH = re.compile(r"^\s*/[a-z][a-z0-9_-]*", re.IGNORECASE)
_CHECKIN_CMD = re.compile(r"^\s*/(?:checkin|worklog|project)\b", re.IGNORECASE)

_NO_MATCH = (
    "Mình chưa hiểu yêu cầu này. Gõ /help để xem các lệnh, "
    "hoặc /checkin để cập nhật worklog."
)


class DailyExecutionAgent:
    def __init__(
        self,
        bbpm: BbPmClient,
        checkin: CheckinService,
        fast_path: FastPathRouter,
        action: ActionRouter,
        read: ReadRouter,
        smalltalk: SmallTalkRouter | None = None,
        llm_fallback: LlmIntentFallback | None = None,
        memory: ConversationMemory | None = None,
        intent_router: LlmIntentRouter | None = None,
        dispatcher: Dispatcher | None = None,
    ) -> None:
        self._bbpm = bbpm
        self._checkin = checkin
        self._fast_path = fast_path
        self._action = action
        self._read = read
        self._smalltalk = smalltalk or SmallTalkRouter()
        self._llm_fallback = llm_fallback
        self._memory = memory or ConversationMemory()
        # LLM-first stack (chỉ dùng khi LLM_FIRST_ROUTING=true)
        self._intent_router = intent_router
        self._dispatcher = dispatcher

    async def handle(
        self, text: str, request: TurnRequest, company_id: Optional[int]
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str]]:
        """Trả về (reply, channel_reply, mode, pattern)."""
        if settings.llm_first_routing and self._intent_router and self._dispatcher:
            return await self._handle_llm_first(text, request, company_id)
        return await self._handle_legacy(text, request, company_id)

    # ── LLM-FIRST PATH (Option B + A) ───────────────────────────────────
    # Khác biệt vs phiên bản trước: KHÔNG còn `prefer_checkin = not is_slash`.
    # LLM classifier luôn được hỏi cho text free-form, kể cả khi đang trong
    # checkin AWAITING_UPDATE. Chỉ deterministic-route khi:
    #   - text là slash command
    #   - text là quick-reply payload (SELECT_PROJECT, SELECT_TASK, CANCEL…)
    #   - session đang ở AWAITING_PROJECT / AWAITING_TASK_CONFIRM (UI mạnh)
    # Nhờ vậy user "rẽ ngang" giữa AWAITING_UPDATE được route đúng intent
    # mà không cần `_looks_like_query` regex band-aid.
    async def _handle_llm_first(
        self, text: str, request: TurnRequest, company_id: Optional[int]
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str]]:
        is_chat = request.source == "chat"
        is_slash = bool(_SLASH.match(text))
        conv_id = request.conversation_id
        meta = request.metadata or {}
        payload = meta.get("payload") if isinstance(meta.get("payload"), str) else None

        ctx = await self._memory.get(conv_id) if is_chat else None
        memory_dict = ctx.model_dump() if ctx else None

        # ① Pending action (post-LLM confirm) — ưu tiên cao nhất
        if is_chat:
            ack = await self._action.check_pending_and_consume(text, request)
            if ack is not None:
                await self._memory.update(conv_id, intent="action", text=text,
                                           reply_summary=ack[0],
                                           pattern=ack[1], mode="action")
                return (ack[0], None, "action", ack[1])

        # ② Slash command — short-circuit, KHÔNG gọi LLM
        if is_slash:
            # /checkin /worklog /project → start checkin SM
            if _CHECKIN_CMD.match(text):
                cresult = await self._checkin.handle_turn(text, request)
                if cresult is not None:
                    await self._memory.update(conv_id, intent="checkin", text=text,
                                               reply_summary=cresult.reply,
                                               pattern=cresult.pattern, mode="checkin")
                    return (cresult.reply, cresult.channel_reply, "checkin",
                            cresult.pattern)
            fast = await self._fast_path.try_fast_path(text, request)
            if fast is not None:
                await self._memory.update(conv_id, intent="fast_path", text=text,
                                           reply_summary=fast[0],
                                           pattern=fast[1], mode="fast_path")
                return (fast[0], None, "fast_path", fast[1])

        # ③ Quick-reply payload (SELECT_PROJECT / SELECT_TASK / CANCEL…) —
        #    deterministic, đi thẳng vào CheckinService không classify.
        if payload and (payload.startswith(("SELECT_PROJECT:", "SELECT_TASK:",
                                             "CONFIRM_ATTACH_TASK:"))
                        or payload == "CANCEL_CHECKIN"):
            cresult = await self._checkin.handle_turn(text, request)
            if cresult is not None:
                await self._memory.update(conv_id, intent="checkin", text=text,
                                           reply_summary=cresult.reply,
                                           pattern=cresult.pattern, mode="checkin")
                return (cresult.reply, cresult.channel_reply, "checkin",
                        cresult.pattern)

        # ④ Detect active checkin session state
        session_state = await self._checkin_state(request.caller_user_id)

        # AWAITING_PROJECT / AWAITING_TASK_CONFIRM: UI mạnh — user gõ tên/số
        # project hoặc task. LLM classify hầu như sẽ sai. Route thẳng.
        if session_state in {"AWAITING_PROJECT", "AWAITING_TASK_CONFIRM"}:
            cresult = await self._checkin.handle_turn(text, request)
            if cresult is not None:
                await self._memory.update(conv_id, intent="checkin", text=text,
                                           reply_summary=cresult.reply,
                                           pattern=cresult.pattern, mode="checkin")
                return (cresult.reply, cresult.channel_reply, "checkin",
                        cresult.pattern)

        # ⑤ LLM classify (cho AWAITING_UPDATE hoặc không-session)
        if not is_chat:
            return (_NO_MATCH, None, "no_match", None)

        result = await self._intent_router.classify(
            text, request, memory=memory_dict,
        )

        # ⑥ Nếu đang trong AWAITING_UPDATE:
        #    - intent=checkin → tiếp tục worklog flow (parser sẽ parse text này)
        #    - intent ≠ checkin với confidence cao → auto-cancel session + dispatch
        #    - confidence trung bình → ask confirm rẽ ngang
        if session_state == "AWAITING_UPDATE" and result.intent != "checkin":
            return await self._handle_branch_off(
                result, text, request, company_id, memory_dict, conv_id,
            )

        # ⑦ Intent = checkin (kể cả khi không có session) → CheckinService
        if result.intent == "checkin":
            cresult = await self._checkin.handle_turn(text, request)
            if cresult is not None:
                await self._memory.update(conv_id, intent="checkin", text=text,
                                           reply_summary=cresult.reply,
                                           pattern=cresult.pattern, mode="checkin")
                return (cresult.reply, cresult.channel_reply, "checkin",
                        cresult.pattern)

        # ⑧ Dispatch theo intent
        reply, channel_reply, mode, pattern, row_count = \
            await self._dispatcher.dispatch(
                result, text, request, company_id, memory=memory_dict,
            )

        await self._memory.update(
            conv_id,
            intent=result.intent,
            text=text,
            reply_summary=reply,
            entities=result.entities.model_dump(exclude_none=True),
            project_name=result.entities.project_name,
            project_id=result.entities.project_id,
            task_id=result.entities.task_id,
            row_count=row_count,
            pattern=pattern,
            mode=mode,
        )
        return (reply, channel_reply, mode, pattern)

    # ── helpers ─────────────────────────────────────────────────────────
    async def _checkin_state(self, user_id: Optional[int]) -> Optional[str]:
        """Trả về state ('AWAITING_PROJECT' | 'AWAITING_UPDATE' | …) hoặc None."""
        if not user_id:
            return None
        try:
            session = await self._bbpm.current_checkin_session(user_id)
        except Exception:  # noqa: BLE001
            return None
        if not session:
            return None
        return session.get("state")

    async def _handle_branch_off(
        self,
        result, text: str, request: TurnRequest,
        company_id: Optional[int], memory_dict: Optional[dict],
        conv_id: Optional[str],
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str]]:
        """User đang AWAITING_UPDATE nhưng gõ câu thuộc intent khác.

        Confidence cao  → tự cancel session, dispatch.
        Confidence vừa  → hỏi confirm "dừng worklog để hỏi X?".
        """
        log_event("checkin.branch_off",
                  intent=result.intent, confidence=result.confidence,
                  text=text[:80])
        if result.confidence >= 0.75:
            # Cancel session để không kẹt clarify loop
            user_id = request.caller_user_id
            if user_id:
                try:
                    sess = await self._bbpm.current_checkin_session(user_id)
                    if sess:
                        await self._bbpm.complete_checkin_session(sess["id"])
                except Exception:  # noqa: BLE001
                    pass
            # Dispatch như câu bình thường
            reply, channel_reply, mode, pattern, row_count = \
                await self._dispatcher.dispatch(
                    result, text, request, company_id, memory=memory_dict,
                )
            await self._memory.update(
                conv_id, intent=result.intent, text=text,
                reply_summary=reply,
                entities=result.entities.model_dump(exclude_none=True),
                pattern=pattern, mode=mode, row_count=row_count,
            )
            return (reply, channel_reply, mode, pattern)
        # Confidence trung bình → hỏi user
        return (
            f"Bạn đang trong flow /checkin nhưng câu này có vẻ là "
            f"{result.intent}. Gõ \"hủy\" để dừng checkin, hoặc tiếp tục "
            f"nhập worklog.",
            None, "branch_off_ask", "checkin:branch_off:ask",
        )

    # ── LEGACY PATH (rollback) ──────────────────────────────────────────
    async def _handle_legacy(
        self, text: str, request: TurnRequest, company_id: Optional[int]
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str]]:
        is_chat = request.source == "chat"
        is_slash = bool(_SLASH.match(text))
        conv_id = request.conversation_id

        ctx = await self._memory.get(conv_id) if is_chat else None
        has_pronoun = is_chat and has_pronoun_reference(text)
        memory_dict = ctx.model_dump() if (ctx and has_pronoun) else None

        prefer_checkin = bool(_CHECKIN_CMD.match(text)) or not is_slash
        if prefer_checkin:
            result = await self._checkin.handle_turn(text, request)
            if result is not None:
                await self._memory.update(conv_id, intent="checkin",
                                           text=text, reply_summary=result.reply)
                return (result.reply, result.channel_reply, "checkin",
                        result.pattern)

        action = await self._action.handle(text, request)
        if action is not None:
            await self._memory.update(conv_id, intent="action",
                                       text=text, reply_summary=action[0])
            return (action[0], None, "action", action[1])

        if is_slash or not has_pronoun:
            fast = await self._fast_path.try_fast_path(text, request)
            if fast is not None:
                await self._memory.update(conv_id, intent="fast_path",
                                           text=text, reply_summary=fast[0])
                return (fast[0], None, "fast_path", fast[1])

        if not has_pronoun:
            st = await self._smalltalk.try_handle(text, request)
            if st is not None:
                await self._memory.update(conv_id, intent="smalltalk",
                                           text=text, reply_summary=st[0])
                return (st[0], None, "smalltalk", st[1])

        if is_chat:
            read = await self._read.try_read(
                text, request, company_id, memory_context=memory_dict,
            )
            if read is not None:
                reply, pattern, sql, row_count = read
                await self._memory.update(
                    conv_id, intent="read", text=text, reply_summary=reply,
                    sql=sql, row_count=row_count,
                )
                return (reply, None, "read", pattern)

        if is_chat and self._llm_fallback is not None:
            fb = await self._llm_fallback.try_handle(text, request, company_id)
            if fb is not None:
                await self._memory.update(conv_id, intent="fallback",
                                           text=text, reply_summary=fb[0])
                return (fb[0], None, "fallback", fb[1])

        return (_NO_MATCH, None, "no_match", None)
