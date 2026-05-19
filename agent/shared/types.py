"""Channel-agnostic contracts between the channel adapter and the orchestrator.

The orchestrator never imports a channel package; channels translate their
native payloads to/from these types. Mirrors AgentContext / ChannelReplyBody
from bb-pm-tools/src/types.ts + shared/types.ts.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

TurnSource = Literal["chat", "cron", "cli", "eval"]


class ReplyOption(BaseModel):
    title: str
    payload: str


class ReplyBody(BaseModel):
    """A rich channel reply. `kind="text"` is a plain message."""
    kind: Literal["text", "quick_replies"] = "text"
    text: str = ""
    options: list[ReplyOption] = Field(default_factory=list)


class TurnRequest(BaseModel):
    """One inbound conversational turn handed to the orchestrator."""
    text: str
    source: TurnSource = "chat"
    conversation_id: Optional[str] = None
    external_id: Optional[str] = None
    correlation_id: Optional[str] = None
    event_type: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    skip_channel_ack: bool = False
    # Resolved lazily by the pipeline (Gapo external id -> bb-pm user id).
    caller_user_id: Optional[int] = None


class TurnReply(BaseModel):
    """Orchestrator output for one turn."""
    reply: str = ""
    channel_reply: Optional[ReplyBody] = None
    request_id: Optional[str] = None
    # Diagnostics — which layer answered.
    pattern: Optional[str] = None
    mode: Optional[str] = None
    # Re-send dedup: empty reply + silent => channel should skip sending.
    dedup: bool = False
    silent: bool = False
