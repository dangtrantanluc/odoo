"""Gapo channel data models.

Ports the GapoNormalizedEvent / GapoMessageBody shapes from
gapo-agent/src/{normalizer,gapo-client}.ts.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class Mention(BaseModel):
    target: str
    length: Optional[int] = None
    offset: Optional[int] = None


class GapoNormalizedEvent(BaseModel):
    event_type: Optional[str] = None
    text: Optional[str] = None
    conversation_id: Optional[str] = None
    external_id: Optional[str] = None
    from_user_id: Optional[str] = None
    thread_id: Optional[str] = None
    to_bot_id: Optional[str] = None
    message_id: Optional[str] = None
    message_type: Optional[str] = None
    payload: Optional[str] = None
    mentions: list[Mention] = Field(default_factory=list)
    is_group_message: bool = False
    sender_name: Optional[str] = None
    correlation_id: Optional[str] = None
    should_process: bool = False


class QuickReplyOption(BaseModel):
    title: str
    payload: str


class TextBody(BaseModel):
    type: Literal["text"] = "text"
    text: str
    is_markdown_text: bool = True


class QuickRepliesBody(BaseModel):
    type: Literal["quick_replies"] = "quick_replies"
    text: str
    options: list[QuickReplyOption] = Field(default_factory=list)

    def to_gapo(self) -> dict[str, Any]:
        return {
            "type": "quick_replies",
            "text": self.text,
            "metadata": {"options": [o.model_dump() for o in self.options]},
        }


GapoMessageBody = TextBody | QuickRepliesBody


class GapoSendResult(BaseModel):
    sent: bool
    conversation_id: str
    response: Any = None
    status_code: Optional[int] = None
    message: Optional[str] = None
