"""Gapo webhook + send handler.

Ports gapo-agent/src/index.ts. In the standalone service the orchestrator is
called as an in-process coroutine (`turn_handler`) instead of an HTTP POST to
another plugin.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from channel.base import TurnHandler
from channel.gapo.client import GapoClient, build_quick_reply_fallback_text
from channel.gapo.models import (
    GapoNormalizedEvent,
    GapoSendResult,
    QuickRepliesBody,
    QuickReplyOption,
    TextBody,
)
from channel.gapo.normalizer import normalize_gapo_payload
from core.logging import log_io
from shared.types import ReplyBody, TurnReply, TurnRequest

_EVENT_DEDUP_TTL_SEC = 5 * 60


class GapoHandler:
    def __init__(self, client: GapoClient, turn_handler: TurnHandler) -> None:
        self._client = client
        self._turn_handler = turn_handler
        self._recent_events: dict[str, float] = {}
        self.counters = {
            "webhook_received": 0,
            "webhook_processed": 0,
            "webhook_ignored": 0,
            "webhook_failed": 0,
            "send_succeeded": 0,
            "send_failed": 0,
        }

    # ── webhook ─────────────────────────────────────────────────────────
    def _is_duplicate_event(self, event_id: str) -> bool:
        now = time.monotonic()
        for eid, seen in list(self._recent_events.items()):
            if now - seen > _EVENT_DEDUP_TTL_SEC:
                del self._recent_events[eid]
        if event_id in self._recent_events:
            return True
        self._recent_events[event_id] = now
        return False

    async def handle_webhook(self, payload: dict[str, Any]) -> dict[str, Any]:
        started = time.monotonic()
        self.counters["webhook_received"] += 1
        try:
            normalized = normalize_gapo_payload(payload)
        except Exception as err:  # noqa: BLE001
            self.counters["webhook_failed"] += 1
            log_io("gapo.webhook.failed", error=str(err))
            return {"ok": True, "received": True, "processed": False,
                    "error": {"message": str(err)}}

        log_io("gapo.webhook.received", normalized=normalized.model_dump())

        event_id = payload.get("id")
        if isinstance(event_id, str) and self._is_duplicate_event(event_id):
            self.counters["webhook_ignored"] += 1
            return self._result(started, normalized, processed=False, duplicate=True,
                                sent={"sent": False, "reason": "duplicate event"})

        if not normalized.should_process:
            self.counters["webhook_ignored"] += 1
            return self._result(started, normalized, processed=False,
                                sent={"sent": False, "reason": "event ignored"})

        try:
            reply = await self._turn_handler(self._to_turn_request(normalized))
        except Exception as err:  # noqa: BLE001
            self.counters["webhook_failed"] += 1
            log_io("gapo.webhook.turn_error", error=str(err),
                   correlation_id=normalized.correlation_id)
            # Gửi reply generic để user không bị im lặng — không expose chi tiết
            # lỗi backend ra ngoài.
            fallback_reply = TurnReply(
                reply=("Mình gặp lỗi khi xử lý yêu cầu này. "
                       "Bạn thử lại sau giây lát, hoặc gõ /help nhé."),
                mode="error",
                request_id=normalized.correlation_id,
            )
            sent = await self._deliver(normalized, fallback_reply)
            return self._result(started, normalized, processed=False,
                                error={"message": str(err)},
                                sent=sent.model_dump())

        sent = await self._deliver(normalized, reply)
        self.counters["webhook_processed"] += 1
        if sent.sent:
            self.counters["send_succeeded"] += 1
        elif not (reply.silent or reply.dedup):
            self.counters["send_failed"] += 1
        return self._result(started, normalized, processed=True,
                            sent=sent.model_dump())

    def _to_turn_request(self, ev: GapoNormalizedEvent) -> TurnRequest:
        return TurnRequest(
            text=ev.text or "",
            source="chat",
            conversation_id=ev.conversation_id,
            external_id=ev.external_id,
            correlation_id=ev.correlation_id,
            event_type=ev.event_type,
            skip_channel_ack=True,
            metadata={
                "from_user_id": ev.from_user_id,
                "thread_id": ev.thread_id,
                "to_bot_id": ev.to_bot_id,
                "message_id": ev.message_id,
                "message_type": ev.message_type,
                "payload": ev.payload,
                "mentions": [m.model_dump() for m in ev.mentions],
                "is_group_message": ev.is_group_message,
                "sender_name": ev.sender_name,
            },
        )

    async def _deliver(
        self, normalized: GapoNormalizedEvent, reply: TurnReply
    ) -> GapoSendResult:
        conversation_id = normalized.conversation_id or normalized.thread_id
        if reply.silent or reply.dedup:
            return GapoSendResult(sent=False, conversation_id=conversation_id or "",
                                  message="silent reply — skip send")
        body = _reply_to_body(reply)
        if body is None or not conversation_id:
            return GapoSendResult(sent=False, conversation_id=conversation_id or "",
                                  message="empty reply" if body is None else "no conversation id")

        sent = await self._client.send(conversation_id, body)
        # Quick-reply fallback: if the rich card failed, retry as numbered text.
        if not sent.sent and isinstance(body, QuickRepliesBody):
            fallback = TextBody(text=build_quick_reply_fallback_text(body))
            retry = await self._client.send(conversation_id, fallback)
            if retry.sent:
                return retry
            sent = retry
        # DM fallback: nếu thread không gửi được (bot bị kick, mismatch bot,
        # thread đóng…) thử gửi DM trực tiếp cho from_user_id để user không
        # bị im lặng. Chỉ thử khi target hiện tại là thread (không phải dm:).
        if (not sent.sent
                and normalized.from_user_id
                and not conversation_id.lower().startswith(("dm:", "gapo:dm:"))):
            dm_target = f"dm:{normalized.from_user_id}"
            log_io("gapo.send.dm_fallback", target=dm_target,
                   thread_failed=conversation_id)
            dm_body: TextBody | QuickRepliesBody = (
                TextBody(text=build_quick_reply_fallback_text(body))
                if isinstance(body, QuickRepliesBody) else body
            )
            dm_retry = await self._client.send(dm_target, dm_body)
            if dm_retry.sent:
                return dm_retry
        return sent

    @staticmethod
    def _result(
        started: float,
        normalized: GapoNormalizedEvent,
        *,
        processed: bool,
        sent: Optional[dict[str, Any]] = None,
        duplicate: bool = False,
        error: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        out: dict[str, Any] = {
            "ok": True,
            "received": True,
            "processed": processed,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "normalized": normalized.model_dump(),
        }
        if duplicate:
            out["duplicate"] = True
        if sent is not None:
            out["sent"] = sent
        if error is not None:
            out["error"] = error
        return out

    # ── send (proactive / workflow) ─────────────────────────────────────
    async def handle_send(
        self, conversation_id: str, text: str,
        body: Optional[TextBody | QuickRepliesBody] = None,
    ) -> GapoSendResult:
        result = await self._client.send(conversation_id, body, text=text)
        if result.sent:
            self.counters["send_succeeded"] += 1
        else:
            self.counters["send_failed"] += 1
        return result

    def health(self) -> dict[str, Any]:
        return {"plugin": "gapo", "counters": dict(self.counters)}


def _reply_to_body(reply: TurnReply) -> Optional[TextBody | QuickRepliesBody]:
    cr: Optional[ReplyBody] = reply.channel_reply
    if cr is not None and cr.kind == "quick_replies":
        return QuickRepliesBody(
            text=cr.text,
            options=[QuickReplyOption(title=o.title, payload=o.payload) for o in cr.options],
        )
    text = (cr.text if cr is not None else reply.reply) or reply.reply
    text = (text or "").strip()
    return TextBody(text=text) if text else None
