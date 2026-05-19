"""Workflow registry — recurring jobs run by the scheduler or on demand.

Ports bb-pm-tools/src/workflows/registry.ts. Each workflow is a named coroutine
that queries the bb-pm API and pushes a message to Gapo. Workflows never call
the LLM directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from channel.gapo.client import GapoClient
from channel.gapo.models import QuickRepliesBody, QuickReplyOption, TextBody
from checkin.service import CheckinService
from core.logging import log_event
from infrastructure.bbpm_client import BbPmClient
from tools.catalog import ToolCatalog


@dataclass
class WorkflowResult:
    ok: bool
    message: str
    meta: dict[str, Any] | None = None


@dataclass
class WorkflowContext:
    source: str = "cron"          # "cron" | "manual"
    target: Optional[str] = None  # Gapo conversation id
    correlation_id: Optional[str] = None


_REMINDER_PREFIX = {
    "noon": "Bạn cập nhật worklog hôm nay nhé: nội dung, số giờ, trạng thái và blocker nếu có.",
    "eod": "Đến giờ chốt ngày rồi, bạn cập nhật worklog giúp mình nhé: "
           "nội dung, số giờ, trạng thái và blocker nếu có.",
    "missing": "Mình chưa thấy worklog hôm nay của bạn.",
}


class WorkflowRegistry:
    def __init__(
        self, bbpm: BbPmClient, catalog: ToolCatalog,
        gapo: GapoClient, checkin: CheckinService,
    ) -> None:
        self._bbpm = bbpm
        self._catalog = catalog
        self._gapo = gapo
        self._checkin = checkin
        self.names = [
            "daily_digest", "weekly_report", "hygiene_check", "role_based_digest",
            "noon_checkin_reminder", "eod_checkin_reminder", "missing_checkin_followup",
        ]

    async def run(self, name: str, inputs: dict[str, Any], ctx: WorkflowContext) -> WorkflowResult:
        handler = getattr(self, f"_wf_{name}", None)
        if handler is None:
            return WorkflowResult(ok=False, message=f"workflow không tồn tại: {name}")
        try:
            return await handler(inputs, ctx)
        except Exception as err:  # noqa: BLE001
            log_event("workflow.failed", level="error", workflow=name, error=str(err))
            return WorkflowResult(ok=False, message=f"{name} lỗi: {err}")

    # ── push-to-target workflows ────────────────────────────────────────
    async def _wf_daily_digest(self, _inputs, ctx) -> WorkflowResult:
        if not ctx.target:
            return WorkflowResult(ok=False, message="thiếu target")
        await self._send(ctx.target, await self._catalog.daily_digest())
        return WorkflowResult(ok=True, message="digest sent")

    async def _wf_weekly_report(self, inputs, ctx) -> WorkflowResult:
        if not ctx.target:
            return WorkflowResult(ok=False, message="thiếu target")
        await self._send(ctx.target, await self._catalog.weekly_report(inputs.get("days", 7)))
        return WorkflowResult(ok=True, message="weekly report sent")

    async def _wf_hygiene_check(self, inputs, ctx) -> WorkflowResult:
        if not ctx.target:
            return WorkflowResult(ok=False, message="thiếu target")
        await self._send(ctx.target, await self._catalog.data_hygiene(inputs.get("staleDays", 14)))
        return WorkflowResult(ok=True, message="hygiene reported")

    async def _wf_role_based_digest(self, inputs, ctx) -> WorkflowResult:
        if not ctx.target:
            return WorkflowResult(ok=False, message="thiếu target")
        user_id = inputs.get("userId")
        if not isinstance(user_id, int):
            return WorkflowResult(ok=False, message="thiếu userId")
        digest = await self._bbpm.role_based_digest(user_id)
        overview = digest.get("overview", {})
        recipient = digest.get("recipient", {})
        text = (
            f"Digest cho {recipient.get('fullName', '?')} ({recipient.get('role', '?')})\n"
            f"Task mở: {overview.get('openTasks', 0)} | Quá hạn: {overview.get('overdueTasks', 0)}"
            f" | Blocker: {overview.get('blockedTasks', 0)}"
        )
        await self._send(ctx.target, text)
        return WorkflowResult(ok=True, message="role digest sent")

    # ── check-in reminders ──────────────────────────────────────────────
    async def _wf_noon_checkin_reminder(self, _inputs, ctx) -> WorkflowResult:
        return await self._run_reminder("noon", ctx)

    async def _wf_eod_checkin_reminder(self, _inputs, ctx) -> WorkflowResult:
        return await self._run_reminder("eod", ctx)

    async def _wf_missing_checkin_followup(self, _inputs, ctx) -> WorkflowResult:
        return await self._run_reminder("missing", ctx)

    async def _run_reminder(self, kind: str, ctx: WorkflowContext) -> WorkflowResult:
        users = await self._bbpm.missing_checkins()
        sent = skipped = 0
        for user in users:
            target = user.get("gapoThreadId") or (
                f"dm:{user['gapoUserId']}" if user.get("gapoUserId") else None
            )
            if not target or not user.get("gapoUserId"):
                skipped += 1
                self._checkin.record_reminder_metric("skipped")
                continue

            active = user.get("activeSession")
            if active and kind != "missing":
                skipped += 1
                self._checkin.record_reminder_metric("skipped")
                continue
            if active and kind == "missing":
                await self._send(target, "Mình vẫn chưa thấy worklog hôm nay của bạn. "
                                 "Bạn cập nhật giúp mình nhé.")
                await self._audit("checkin.reminder_missing", {"userId": user["id"]}, ctx)
                sent += 1
                self._checkin.record_reminder_metric("sent")
                continue

            body = await self._checkin.build_project_selection_reply(user["id"])
            if body is None or body.kind != "quick_replies":
                skipped += 1
                self._checkin.record_reminder_metric("skipped")
                continue
            await self._bbpm.start_checkin_session(
                user_id=user["id"], gapo_user_id=str(user["gapoUserId"]),
                thread_id=target, expires_at=_two_hours(),
            )
            await self._gapo.send(target, QuickRepliesBody(
                text=f"{_REMINDER_PREFIX[kind]}\n{body.text}",
                options=[QuickReplyOption(title=o.title, payload=o.payload) for o in body.options],
            ))
            await self._audit(f"checkin.reminder_{kind}", {"userId": user["id"]}, ctx)
            sent += 1
            self._checkin.record_reminder_metric("sent")
        return WorkflowResult(ok=True, message=f"{kind} reminder sent={sent} skipped={skipped}",
                              meta={"sent": sent, "skipped": skipped})

    # ── helpers ─────────────────────────────────────────────────────────
    async def _send(self, target: str, text: str) -> None:
        await self._gapo.send(target, TextBody(text=text))

    async def _audit(self, tool: str, args: dict[str, Any], ctx: WorkflowContext) -> None:
        try:
            await self._bbpm.post_audit(tool=tool, args_json=args, source="cron",
                                        correlation_id=ctx.correlation_id)
        except Exception:  # noqa: BLE001
            pass


def _two_hours() -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
