"""Intent Router — phân loại turn vào 1 trong 2 nhánh agent.

Quy tắc (theo thứ tự):
  1. Có planning-session đang mở → PLANNING (giữ cho user hoàn thành flow).
  2. Slash command planning (/plan, /newproject, /kehoach) → PLANNING.
  3. NL pattern planning ("lập kế hoạch …", "tạo dự án mới") → PLANNING.
  4. Mặc định → DAILY.

Daily branch giữ y nguyên chuỗi cũ: checkin → action → fast-path → NL-SQL.
"""

from __future__ import annotations

import re
from enum import Enum

from planning.session import PlanningSessionStore
from shared.types import TurnRequest


class IntentBranch(str, Enum):
    DAILY = "daily"
    PLANNING = "planning"


_SLASH = re.compile(r"^\s*/([a-z][a-z0-9_-]*)", re.IGNORECASE)
_SLASH_PLANNING = {"plan", "newproject", "new-project", "kehoach", "ke-hoach"}

_PLANNING_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"l[ậaạ]p\s+k[êe]\s*ho[ạa]ch|l[êe]n\s+k[êe]\s*ho[ạa]ch",
               re.IGNORECASE),
    re.compile(r"t[ạa]o\s+(?:d[ựu]\s*[áa]n|project)\s+m[ớo]i", re.IGNORECASE),
    re.compile(r"chia\s+(?:epic|task)\s+cho", re.IGNORECASE),
    re.compile(r"estimate\s+(?:d[ựu]\s*[áa]n|project)", re.IGNORECASE),
]


class IntentRouter:
    def __init__(self, sessions: PlanningSessionStore) -> None:
        self._sessions = sessions

    async def classify(self, text: str, ctx: TurnRequest) -> IntentBranch:
        # 1) phiên planning đang mở
        if ctx.caller_user_id and await self._sessions.exists(ctx.caller_user_id):
            return IntentBranch.PLANNING

        stripped = text.strip()

        # 2) slash
        m = _SLASH.match(stripped)
        if m and m.group(1).lower() in _SLASH_PLANNING:
            return IntentBranch.PLANNING

        # 3) NL patterns
        if any(p.search(stripped) for p in _PLANNING_PATTERNS):
            return IntentBranch.PLANNING

        # 4) mặc định
        return IntentBranch.DAILY
