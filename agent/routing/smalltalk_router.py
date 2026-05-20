"""SmallTalk router — chào hỏi & câu giao tiếp ngắn.

Bắt sớm các câu xã giao thường gặp (hi/hello/chào, cảm ơn, tạm biệt, "ổn không")
để bot trả lời thân thiện thay vì rơi vào "Mình chưa hiểu yêu cầu này".

Đây là layer regex-only, không gọi LLM — đặt SAU FastPath và TRƯỚC ReadRouter
trong DailyExecutionAgent.
"""

from __future__ import annotations

import random
import re
from typing import Optional

from shared.text import normalize
from shared.types import TurnRequest


# Pattern match đầu câu, sau khi normalize ("hi", "hello", "chao ban", "xin chao")
_GREETING = re.compile(
    r"^(?:hi|hey|hello|halo|alo|xin chao|chao|chao\s+(?:ban|b|moi nguoi|agent|bot|cau))"
    r"(?:\s|[.!,?]|$)"
)
_THANKS = re.compile(
    r"\b(?:thanks|thank you|tks|thx|cam on|cảm ơn|cam o|cam ow)\b", re.IGNORECASE
)
_GOODBYE = re.compile(
    r"\b(?:bye|tam biet|tạm biệt|goodbye|hen gap lai)\b", re.IGNORECASE
)
_HOWRU = re.compile(
    r"\b(?:on khong|khoe khong|the nao roi|sao roi|how are you|"
    r"ban on chu|ban on khong)\b"
)
_WHOAMI = re.compile(
    r"\b(?:ban la ai|ban la gi|gioi thieu|introduce|"
    r"ban lam (?:duoc )?gi|co the lam gi|chuc nang)\b"
)


_GREETING_REPLIES = [
    "Chào bạn! Mình là PM Agent. Gõ /help để xem các lệnh mình hỗ trợ.",
    "Hi bạn 👋. Cần mình giúp gì hôm nay? (gõ /help nếu cần danh sách lệnh)",
    "Chào bạn nha! Bắt đầu bằng /checkin để cập nhật worklog hoặc /mytasks "
    "để xem việc đang mở.",
]
_THANKS_REPLIES = [
    "Không có gì, bạn cứ gọi mình bất cứ lúc nào nhé.",
    "Cảm ơn bạn! Có gì cần tiếp tục cứ nhắn.",
]
_GOODBYE_REPLIES = [
    "Chào bạn, có gì gọi mình nha 👋",
    "Hẹn gặp lại bạn!",
]
_HOWRU_REPLY = (
    "Mình ổn — đang phục vụ team. Còn bạn thì sao? "
    "Nếu cần thì /digest hoặc /mytasks nhé."
)
_WHOAMI_REPLY = (
    "Mình là PM Agent — trợ lý quản lý dự án trên Gapo:\n"
    "• Nhập worklog hằng ngày (/checkin)\n"
    "• Lập kế hoạch dự án mới (/plan, Manager/Admin)\n"
    "• Hỏi đáp dữ liệu dự án bằng câu tự nhiên\n"
    "• Cảnh báo rủi ro tự động (/risk)\n\n"
    "Gõ /help để xem đủ lệnh."
)


class SmallTalkRouter:
    async def try_handle(
        self, text: str, _ctx: TurnRequest
    ) -> Optional[tuple[str, str]]:
        """Return (reply, pattern) nếu là smalltalk, None nếu không."""
        n = normalize(text)
        if not n:
            return None

        if _GREETING.match(n):
            return (random.choice(_GREETING_REPLIES), "smalltalk:greeting")
        if _HOWRU.search(n):
            return (_HOWRU_REPLY, "smalltalk:howru")
        if _WHOAMI.search(n):
            return (_WHOAMI_REPLY, "smalltalk:whoami")
        if _THANKS.search(n):
            return (random.choice(_THANKS_REPLIES), "smalltalk:thanks")
        if _GOODBYE.search(n):
            return (random.choice(_GOODBYE_REPLIES), "smalltalk:goodbye")
        return None
