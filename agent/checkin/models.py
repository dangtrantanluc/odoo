"""Check-in domain models. Ports the ParsedCheckin / CheckinTurnResult types
from bb-pm-tools/src/checkin/service.ts."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from shared.types import ReplyBody

CheckinStatus = Literal["IN_PROGRESS", "REVIEW", "DONE"]
BlockerSeverity = Literal["LOW", "MED", "HIGH"]


class ParsedBlocker(BaseModel):
    description: str
    severity: BlockerSeverity = "MED"


class ParsedCheckin(BaseModel):
    work_date: str
    summary: str
    hours: float = 1.0
    status: Optional[CheckinStatus] = None
    blocker: Optional[ParsedBlocker] = None
    task_hint: Optional[str] = None
    needs_clarification: bool = False
    clarification_question: Optional[str] = None


class CheckinTurnResult(BaseModel):
    reply: str
    channel_reply: Optional[ReplyBody] = None
    pattern: str = Field(default="checkin")
