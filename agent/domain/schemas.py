from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


Channel = Literal["gapo", "gapo-work"]
BbPmChannel = Literal["gapo"]
CheckinType = Literal["NOON", "EOD"]
TaskStatus = Literal["TODO", "IN_PROGRESS", "REVIEW", "DONE"]
Severity = Literal["LOW", "MED", "HIGH"]


class ChatWebhook(BaseModel):
    channel: Channel = "gapo"
    external_id: str = Field(..., description="Gapo user id or conversation id")
    thread_id: str | None = None
    text: str
    checkin_type: CheckinType = "EOD"
    project_id: int | None = None
    task_id: int | None = None


class GapoRawWebhook(BaseModel):
    model_config = ConfigDict(extra="allow")


class GapoNormalizedEvent(BaseModel):
    text: str
    conversation_id: str | None = None
    external_id: str | None = None
    thread_id: str | None = None
    sender_name: str | None = None
    correlation_id: str | None = None


class Blocker(BaseModel):
    description: str
    severity: Severity = "MED"


class ParsedCheckin(BaseModel):
    work_date: date = Field(default_factory=date.today)
    summary: str
    done_items: list[str] = Field(default_factory=list)
    hours: Decimal = Field(default=Decimal("1.0"), gt=0, le=24)
    task_status: TaskStatus | None = None
    blocker: Blocker | None = None
    needs_clarification: bool = False
    clarification_question: str | None = None


class CheckinResult(BaseModel):
    reply: str
    data: dict[str, Any]


class ReminderRunRequest(BaseModel):
    checkin_type: CheckinType = "EOD"
    dry_run: bool = True


class ParseCheckinRequest(BaseModel):
    text: str
