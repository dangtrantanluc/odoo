"""Fast-path router — slash commands + Vietnamese intent patterns.

Ports bb-pm-tools/src/routing/fast-path/*. Fast-path turns never call the LLM
(DB queries only) and bypass the concurrency limiter. Returns Gapo-ready text,
or None when nothing matches (turn falls through to the read router).
"""

from __future__ import annotations

import re
from typing import Awaitable, Callable, Optional

from core.logging import log_event
from shared.types import TurnRequest
from tools.catalog import ToolCatalog

HELP_TEXT = (
    "Mình là PM Agent. Các lệnh:\n"
    "• /checkin — cập nhật worklog hôm nay\n"
    "• /mytasks — task đang mở của bạn\n"
    "• /overdue — task quá hạn\n"
    "• /stale — task lâu chưa update\n"
    "• /projects — danh sách dự án\n"
    "• /digest — tổng hợp hôm nay\n"
    "• /weekly — báo cáo tuần\n"
    "• /automations — automation đang chạy\n"
    "• /help — trợ giúp"
)
BLOCKER_HELP = (
    "Để báo blocker, bạn dùng /checkin rồi mô tả vướng mắc trong phần update "
    "(kèm từ khóa 'blocker' hoặc 'đang kẹt'), agent sẽ ghi nhận blocker cho task."
)


class FastPathRouter:
    def __init__(self, catalog: ToolCatalog) -> None:
        self._catalog = catalog
        # Slash command -> handler. Handler receives (args, ctx).
        self._slash: dict[str, Callable[[str, TurnRequest], Awaitable[Optional[str]]]] = {
            "help": lambda a, c: _const(HELP_TEXT),
            "blocker": lambda a, c: _const(BLOCKER_HELP),
            "mytasks": lambda a, c: self._my_tasks(c),
            "overdue": lambda a, c: self._catalog.overdue_tasks(),
            "stale": lambda a, c: self._catalog.stale_tasks(),
            "blocked": lambda a, c: self._catalog.overdue_tasks(),
            "projects": lambda a, c: self._catalog.list_projects(),
            "digest": lambda a, c: self._catalog.daily_digest(),
            "report": lambda a, c: self._catalog.daily_digest(),
            "weekly": lambda a, c: self._catalog.weekly_report(),
            "automations": lambda a, c: self._catalog.list_automations(),
        }
        # Vietnamese intent patterns -> handler. Order matters (first match wins).
        self._patterns: list[tuple[re.Pattern[str], Callable]] = [
            (re.compile(r"task.*qu[áa] h[ạa]n|qu[áa] h[ạa]n", re.IGNORECASE),
             lambda m, c: self._catalog.overdue_tasks()),
            (re.compile(r"task.*l[âa]u.*update|task.*stale", re.IGNORECASE),
             lambda m, c: self._catalog.stale_tasks()),
            (re.compile(r"\b(digest|t[ổo]ng h[ợo]p|b[áa]o c[áa]o s[áa]ng)\b", re.IGNORECASE),
             lambda m, c: self._catalog.daily_digest()),
            (re.compile(r"\b(b[áa]o c[áa]o tu[âa]n|weekly)\b", re.IGNORECASE),
             lambda m, c: self._catalog.weekly_report()),
            (re.compile(r"task c[ủu]a t[ôo]i|task c[ủu]a m[ìi]nh|task h[ôo]m nay c[ủu]a t[ôo]i",
                        re.IGNORECASE),
             lambda m, c: self._my_tasks(c)),
            (re.compile(r"d[ựu] [áa]n.*(?:n[àa]o|đang ch[ạa]y)|c[óo] project n[àa]o", re.IGNORECASE),
             lambda m, c: self._catalog.list_projects()),
            (re.compile(r"data hygiene|ki[ểe]m tra d[ữu] li[ệe]u", re.IGNORECASE),
             lambda m, c: self._catalog.data_hygiene()),
            (re.compile(r"automation", re.IGNORECASE),
             lambda m, c: self._catalog.list_automations()),
            (re.compile(r"t[ìi]nh h[ìi]nh d[ựu] [áa]n\s+(.+)$", re.IGNORECASE),
             lambda m, c: self._catalog.project_snapshot(m.group(1).strip())),
            (re.compile(r"task c[ủu]a\s+(.+)$", re.IGNORECASE),
             lambda m, c: self._catalog.person_tasks(m.group(1).strip())),
        ]

    async def _my_tasks(self, ctx: TurnRequest) -> Optional[str]:
        if not ctx.caller_user_id:
            return "Mình chưa nhận diện được tài khoản của bạn."
        return await self._catalog.my_tasks_today(ctx.caller_user_id)

    async def try_fast_path(self, text: str, ctx: TurnRequest) -> Optional[tuple[str, str]]:
        """Return (reply, pattern) if a fast-path matches, else None."""
        stripped = text.strip()
        slash = re.match(r"^/([a-z][a-z0-9_-]*)\b\s*(.*)$", stripped, re.IGNORECASE)
        if slash:
            cmd = slash.group(1).lower()
            handler = self._slash.get(cmd)
            if handler is None:
                return None
            reply = await handler(slash.group(2), ctx)
            return (reply, f"slash:{cmd}") if reply else None

        for pattern, handler in self._patterns:
            match = pattern.search(stripped)
            if match:
                try:
                    reply = await handler(match, ctx)
                except Exception as err:  # noqa: BLE001
                    log_event("fast_path.error", level="warning",
                              pattern=pattern.pattern, error=str(err))
                    return None
                if reply:
                    return reply, f"pattern:{pattern.pattern[:24]}"
        return None


async def _const(text: str) -> str:
    return text
