"""Channel adapter contract.

A channel adapter translates a platform's native webhook payload into a
`TurnRequest`, and a `TurnReply` back into a native outbound message. Keeps
the orchestrator independent of any specific channel (Gapo today, Slack/
Telegram possible later).
"""

from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from shared.types import TurnReply, TurnRequest

# The orchestrator entry point — injected into channel handlers.
TurnHandler = Callable[[TurnRequest], Awaitable[TurnReply]]


class ChannelAdapter(Protocol):
    name: str

    async def close(self) -> None:
        ...
