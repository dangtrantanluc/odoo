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
    "• /risk <tên project> — risk của dự án\n"
    "• /plan — lập kế hoạch dự án mới (Manager/Admin)\n"
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
            "risk": lambda a, c: self._catalog.risk_snapshot(a),
        }
        # VN patterns đã DEPRECATE — LLM-first router xử lý hết câu free-text.
        # Chỉ giữ slash dict ở trên. Đặt rỗng để legacy code đường cũ vẫn chạy
        # khi LLM_FIRST_ROUTING=false (rollback path).
        self._patterns: list[tuple[re.Pattern[str], Callable]] = []

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
                # Slash không biết → trả /help thay vì rơi xuống NL-SQL (vốn
                # luôn classify "ambiguous" cho token đơn lẻ và làm rối user).
                return (f'Mình chưa biết lệnh "/{cmd}".\n\n{HELP_TEXT}',
                        f"slash:unknown:{cmd}")
            reply = await handler(slash.group(2), ctx)
            return (reply, f"slash:{cmd}") if reply else None
        # "help" / "help me" không có dấu / cũng đẩy về help text.
        if re.match(r"^(?:help|trợ giúp|tro giup|huong dan|hướng dẫn)\b", stripped, re.IGNORECASE):
            return (HELP_TEXT, "pattern:help")

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
