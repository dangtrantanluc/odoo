"""Pydantic models cho LLM-first intent classifier.

IntentResult là output của LlmIntentRouter (1 LLM call mỗi turn free-text).
Dispatcher đọc IntentResult để chọn handler đúng.

Giữ schema gọn để LLM dễ tuân thủ và prompt không phình.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# Sentinel: khi user nói "tôi", "của mình" → resolve thành caller_user_id
CALLER = "CALLER"

Intent = Literal[
    "read",        # tra cứu dữ liệu (task/project/worklog/member/blocker/risk)
    "action",      # đổi 1 task (deadline/status/assignee) hoặc tạo task lẻ
    "checkin",     # ý định mở /checkin flow
    "planning",    # ý định mở /plan flow
    "help",        # hỏi cách dùng bot
    "smalltalk",   # chào, cảm ơn, "bạn là ai"
    "unknown",     # ngoài scope
]

Topic = Literal[
    "task", "project", "worklog", "member", "blocker",
    "risk", "milestone", "scope", "estimate",
]
Metric = Literal["count", "list", "summary", "trend", "list_with_filter"]


class IntentEntities(BaseModel):
    """Entities trích xuất từ câu user — dispatcher dùng để chọn path."""
    project_name: Optional[str] = None
    project_id: Optional[int] = None
    task_id: Optional[int] = None
    user_name: Optional[str] = None        # "tôi" → CALLER, "Tuấn" → resolve sau
    date_range: Optional[str] = None       # "today" | "this_week" | "YYYY-MM-DD..YYYY-MM-DD"
    status: Optional[str] = None           # OVERDUE|DONE|IN_PROGRESS|REVIEW|TODO|STALE
    topic: Optional[Topic] = None
    metric: Optional[Metric] = None
    extras: dict[str, Any] = Field(default_factory=dict)  # vd new_deadline, new_assignee

    def is_caller_self(self) -> bool:
        return self.user_name == CALLER


class IntentResult(BaseModel):
    """Output classifier mỗi turn."""
    intent: Intent
    entities: IntentEntities = Field(default_factory=IntentEntities)
    needs_context: bool = False
    confidence: float = 0.0
    reasoning: str = ""

    def low_confidence(self, threshold: float = 0.55) -> bool:
        return self.confidence < threshold
