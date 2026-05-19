"""Read router — classify a turn and answer read questions via NL-to-SQL.

Ports bb-pm-tools/src/routing/read/router.ts. Only read-intent turns reach the
translator; action verbs are deliberately excluded (writes go through the
action router → structured tools, never raw SQL).
"""

from __future__ import annotations

import re
from typing import Literal, Optional

from reporting.nl_to_sql.translator import NlToSqlTranslator
from shared.text import normalize
from shared.types import TurnRequest

ReadClass = Literal["read", "action", "ambiguous", "other"]

_ACTION_MARKERS = re.compile(
    r"\b(tao|them moi|doi|thay doi|giao|assign|danh dau|xoa|gui|sua|chuyen|cap nhat)\b"
)
_READ_VERBS = re.compile(r"\b(thong ke|liet ke|xem|cho biet|bao nhieu|may|danh sach|tim)\b")
_READ_ENTITIES = re.compile(r"\b(task|cong viec|du an|project|deadline|blocker|worklog|user|nhan su)\b")
_READ_STATUS = re.compile(r"\b(qua han|done|hoan thanh|tuan nay|hom nay|dang lam|review)\b")
_READ_RANKING = re.compile(r"\b(nhieu nhat|it nhat|cao nhat|thap nhat|top)\b")
_QUESTION = re.compile(r"\b(ai|bao nhieu|may|nao|khi nao|the nao|gi)\b|\?")


def classify_read_turn(text: str) -> ReadClass:
    n = normalize(text)
    if not n:
        return "other"
    if _ACTION_MARKERS.search(n):
        return "action"
    has_entity = bool(_READ_ENTITIES.search(n))
    has_read_signal = bool(
        _READ_VERBS.search(n) or _READ_STATUS.search(n)
        or _READ_RANKING.search(n) or _QUESTION.search(n)
    )
    if has_entity and has_read_signal:
        return "read"
    tokens = n.split()
    if len(tokens) <= 3 and (has_entity or len(tokens) <= 2):
        return "ambiguous"
    return "other"


class ReadRouter:
    def __init__(self, translator: NlToSqlTranslator) -> None:
        self._translator = translator

    async def try_read(
        self, text: str, ctx: TurnRequest, company_id: Optional[int]
    ) -> Optional[tuple[str, str]]:
        """Return (reply, pattern) if this is a read turn, else None."""
        kind = classify_read_turn(text)
        if kind == "ambiguous":
            return (
                "Bạn hỏi rõ hơn giúp mình nhé — ví dụ \"task quá hạn của dự án X\" "
                "hay \"thống kê worklog tuần này\".",
                "read:ambiguous",
            )
        if kind != "read":
            return None
        if company_id is None:
            return ("Mình chưa xác định được công ty của bạn để tra cứu dữ liệu.",
                    "read:no_company")
        reply = await self._translator.run(text, company_id, ctx.caller_user_id)
        return reply, "read:text_to_sql"
