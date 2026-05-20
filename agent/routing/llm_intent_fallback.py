"""LLM intent fallback — chạy CUỐI CÙNG khi mọi regex layer miss.

Mục tiêu: thay thế trả lời "Mình chưa hiểu yêu cầu này" bằng cách hỏi Haiku
phân loại nhanh thuộc 1 trong 3 nhóm: read | smalltalk | unknown. Nếu là
read → push tiếp vào NL→SQL; còn lại sinh câu trả lời phù hợp.

Tốn token: 1 call rất nhỏ (max_tokens=20) cho mỗi câu rơi xuống đây — không
phải call cho mọi turn (đa số đã match regex trước).
"""

from __future__ import annotations

import json
import re
from typing import Optional

from core.logging import log_event
from infrastructure.llm_client import LlmClient
from reporting.nl_to_sql.translator import NlToSqlTranslator
from shared.types import TurnRequest


_SYS_PROMPT = (
    "Bạn là intent classifier cho một PM bot. Phân loại câu thoại tiếng Việt "
    "thành 1 trong 4 nhãn:\n"
    "  - read       : hỏi/tra cứu dữ liệu dự án/task/worklog/member/blocker/report\n"
    "  - smalltalk  : chào hỏi, cảm ơn, giao tiếp ngắn, hỏi 'bạn là ai', đùa vui\n"
    "  - help       : hỏi cách dùng bot, có những lệnh gì, hướng dẫn\n"
    "  - unknown    : không thuộc bb-pm hoặc không hiểu được\n\n"
    'Trả về DUY NHẤT JSON: {"intent":"read|smalltalk|help|unknown","reason":"<1 câu>"}.'
)


class LlmIntentFallback:
    def __init__(self, llm: LlmClient, translator: NlToSqlTranslator) -> None:
        self._llm = llm
        self._translator = translator

    async def try_handle(
        self, text: str, ctx: TurnRequest, company_id: Optional[int]
    ) -> Optional[tuple[str, str]]:
        """Return (reply, pattern) hoặc None nếu không xử lý được."""
        if not text or len(text) > 500:
            return None
        intent = await self._classify(text)
        if intent is None:
            return None
        log_event("fallback.classified", intent=intent, sample=text[:80])

        if intent == "read":
            if company_id is None:
                return (
                    "Mình chưa xác định được công ty của bạn để tra cứu, nhờ admin "
                    "map account giúp.",
                    "fallback:read_no_company",
                )
            reply, _sql, _rc = await self._translator.run(
                text, company_id, ctx.caller_user_id,
            )
            return (reply, "fallback:read_via_llm")

        if intent == "smalltalk":
            return (
                "Mình là PM Agent — có thể giúp bạn: /checkin nhập worklog, "
                "/mytasks xem việc, /digest tổng hợp, hoặc hỏi tự do về dự án.",
                "fallback:smalltalk",
            )

        if intent == "help":
            return (
                "Mình hỗ trợ những việc chính:\n"
                "• /checkin — nhập worklog\n"
                "• /mytasks /overdue /stale — xem task\n"
                "• /digest /weekly — báo cáo\n"
                "• /risk <project> — rủi ro\n"
                "• /plan — lập kế hoạch (Manager)\n"
                "• Hỏi tự do: 'task quá hạn dự án X', 'ai làm dự án Y'…",
                "fallback:help",
            )

        # unknown
        return None

    async def _classify(self, text: str) -> Optional[str]:
        try:
            res = await self._llm.chat(
                [
                    {"role": "system", "content": _SYS_PROMPT},
                    {"role": "user", "content": text.strip()},
                ],
                temperature=0,
                max_tokens=60,
                response_format={"type": "json_object"},
            )
        except Exception as err:  # noqa: BLE001 — fallback an toàn
            log_event("fallback.llm_failed", level="warning", error=str(err))
            return None
        raw = (res.content or "").strip()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            # cố gắng trích JSON đầu tiên
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return None
            try:
                payload = json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
        intent = payload.get("intent")
        if intent in {"read", "smalltalk", "help", "unknown"}:
            return intent
        return None
