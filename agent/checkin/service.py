"""Check-in state machine.

Faithful port of bb-pm-tools/src/checkin/service.ts. Drives the conversational
worklog flow:

    IDLE → AWAITING_PROJECT → AWAITING_UPDATE → COMPLETED
                     (AWAITING_TASK_CONFIRM used by the edit-worklog flow)

Session state is persisted via the bb-pm API (`checkin-sessions` endpoints),
not locally — survives restart and is safe across workers.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from checkin.models import CheckinTurnResult, ParsedCheckin
from checkin.parser import parse_checkin
from core.config import settings
from core.logging import log_event
from infrastructure.bbpm_client import BbPmApiError, BbPmClient
from infrastructure.llm_client import LlmClient
from shared.text import normalize
from shared.types import ReplyBody, ReplyOption, TurnRequest

_CANCEL = re.compile(r"^(?:hủy|huy|cancel|thoát|thoat|dừng|dung)$")
_WORKLOG_START_SLASH = re.compile(r"^\s*/(?:checkin|worklog|project)\b", re.IGNORECASE)
_WORKLOG_EDIT_SLASH = re.compile(
    r"^\s*/(?:edit-worklog|edit_worklog|sua-worklog|update-worklog)\b", re.IGNORECASE
)


class CheckinService:
    def __init__(self, bbpm: BbPmClient, llm: LlmClient) -> None:
        self._bbpm = bbpm
        self._llm = llm
        self.counters = {
            "sessions_started": 0,
            "projects_selected": 0,
            "completed": 0,
            "parse_success": 0,
            "parse_fallback": 0,
            "reminders_sent": 0,
            "reminders_skipped": 0,
        }

    # ── telemetry ───────────────────────────────────────────────────────
    def telemetry_snapshot(self) -> dict[str, int]:
        return dict(self.counters)

    def record_reminder_metric(self, kind: str) -> None:
        self.counters["reminders_sent" if kind == "sent" else "reminders_skipped"] += 1

    # ── main entry ──────────────────────────────────────────────────────
    async def handle_turn(self, text: str, ctx: TurnRequest) -> Optional[CheckinTurnResult]:
        is_start = _is_worklog_start(text)
        is_edit = _is_worklog_edit(text)
        if not ctx.caller_user_id or not ctx.external_id or not ctx.conversation_id:
            if is_start or is_edit:
                return CheckinTurnResult(
                    reply="Mình chưa nhận diện được tài khoản của bạn trong hệ thống "
                    "worklog. Nhờ admin map tài khoản Gapo này trước nhé.",
                    pattern="checkin:no_caller",
                )
            return None

        meta = ctx.metadata or {}
        payload = meta.get("payload") if isinstance(meta.get("payload"), str) else None
        message_id = meta.get("message_id") if isinstance(meta.get("message_id"), str) else None
        thread_id = meta.get("thread_id") if isinstance(meta.get("thread_id"), str) else ctx.conversation_id

        if _is_current_project_question(text):
            return await self._answer_current_project(ctx.caller_user_id)

        if payload == "CANCEL_CHECKIN" or _is_cancel(text):
            session = await self._get_session(ctx.caller_user_id)
            if session and not _is_expired(session):
                await self._bbpm.complete_checkin_session(session["id"])
            return CheckinTurnResult(reply="Đã hủy thao tác worklog hiện tại.",
                                     pattern="checkin:cancel")

        if is_edit:
            return await self._start_edit_session(ctx, thread_id, message_id)
        if is_start:
            return await self._start_session(ctx, thread_id, message_id)

        if payload and payload.startswith("SELECT_PROJECT:"):
            project_id = _safe_int(payload[len("SELECT_PROJECT:"):])
            if project_id is None:
                return None
            session = await self._ensure_session(ctx, thread_id, message_id)
            return await self._select_project(ctx, session, project_id, message_id)

        if payload and (payload.startswith("SELECT_TASK:") or payload.startswith("CONFIRM_ATTACH_TASK:")):
            task_id = _safe_int(payload[payload.index(":") + 1:])
            if task_id is None:
                return None
            session = await self._get_session(ctx.caller_user_id)
            if not session or not session.get("pendingParsed") or not session.get("pendingText"):
                return None
            return await self._complete_with_task(
                ctx, session, task_id,
                ParsedCheckin.model_validate(session["pendingParsed"]),
            )

        session = await self._get_session(ctx.caller_user_id)
        if not session or _is_expired(session):
            return None

        state = session.get("state")
        if state == "AWAITING_PROJECT":
            projects = await self._list_user_projects(ctx.caller_user_id)
            selected = _select_by_text(projects, text)
            if not selected:
                return None
            return await self._select_project(ctx, session, selected["id"], message_id)

        if state == "AWAITING_TASK_CONFIRM":
            if _is_edit_select(session):
                return await self._select_worklog_to_edit(ctx, session, text, message_id)
            tasks = await self._list_project_tasks(ctx.caller_user_id, session.get("currentProjectId"))
            selected = _select_by_text(tasks, text)
            if not selected or not session.get("pendingParsed"):
                return None
            return await self._complete_with_task(
                ctx, session, selected["id"],
                ParsedCheckin.model_validate(session["pendingParsed"]),
            )

        if state != "AWAITING_UPDATE":
            return None

        parsed, used_llm = await parse_checkin(text, self._llm)
        self.counters["parse_success" if used_llm else "parse_fallback"] += 1
        if parsed.needs_clarification:
            return CheckinTurnResult(
                reply=parsed.clarification_question
                or "Bạn nói rõ thêm giúp mình phần update hôm nay nhé.",
                pattern="checkin:clarify",
            )
        if _is_edit_apply(session):
            return await self._update_existing_worklog(ctx, session, parsed)
        return await self._complete_with_project(ctx, session, parsed)

    # ── project selection reply (also used by reminder workflow) ────────
    async def build_project_selection_reply(self, user_id: int) -> Optional[ReplyBody]:
        projects = await self._list_user_projects(user_id)
        if not projects:
            return None
        options = [
            ReplyOption(title=p["name"][:30], payload=f"SELECT_PROJECT:{p['id']}")
            for p in projects[:3]
        ]
        return ReplyBody(kind="quick_replies", text=_project_choice_text(options), options=options)

    # ── session lifecycle ───────────────────────────────────────────────
    async def _start_session(
        self, ctx: TurnRequest, thread_id: str, message_id: Optional[str]
    ) -> CheckinTurnResult:
        channel_reply = await self.build_project_selection_reply(ctx.caller_user_id)
        if channel_reply is None:
            return CheckinTurnResult(
                reply="Mình chưa thấy project nào bạn đang tham gia để mở check-in.",
                pattern="checkin:no_project",
            )
        await self._bbpm.start_checkin_session(
            user_id=ctx.caller_user_id, gapo_user_id=ctx.external_id,
            thread_id=thread_id, last_message_id=message_id, expires_at=_expires_at_iso(),
        )
        log_event("checkin.state", state="AWAITING_PROJECT", user_id=ctx.caller_user_id)
        self.counters["sessions_started"] += 1
        await self._audit(ctx, "checkin.session_started", {})
        return CheckinTurnResult(reply=channel_reply.text, channel_reply=channel_reply,
                                 pattern="checkin:start")

    async def _ensure_session(
        self, ctx: TurnRequest, thread_id: str, message_id: Optional[str]
    ) -> dict[str, Any]:
        return await self._bbpm.start_checkin_session(
            user_id=ctx.caller_user_id, gapo_user_id=ctx.external_id,
            thread_id=thread_id, last_message_id=message_id, expires_at=_expires_at_iso(),
        )

    async def _get_session(self, user_id: int) -> Optional[dict[str, Any]]:
        try:
            return await self._bbpm.current_checkin_session(user_id)
        except BbPmApiError as err:
            if err.status == 404:
                return None
            raise

    async def _select_project(
        self, ctx: TurnRequest, session: dict[str, Any], project_id: int,
        message_id: Optional[str],
    ) -> CheckinTurnResult:
        await self._bbpm.patch_checkin_session(
            session["id"], currentProjectId=project_id, currentTaskId=None,
            state="AWAITING_UPDATE", lastMessageId=message_id or session.get("lastMessageId"),
            expiresAt=_expires_at_iso(),
        )
        log_event("checkin.state", state="AWAITING_UPDATE", user_id=ctx.caller_user_id,
                  project_id=project_id)
        self.counters["projects_selected"] += 1
        await self._audit(ctx, "checkin.project_selected", {"projectId": project_id})
        return CheckinTurnResult(
            reply="Bạn cập nhật worklog hôm nay nhé: nội dung đã làm, số giờ, trạng thái "
            '(đang làm/review/xong) và blocker nếu có. Gõ "hủy" để dừng.',
            pattern="checkin:project_selected",
        )

    async def _complete_with_project(
        self, ctx: TurnRequest, session: dict[str, Any], parsed: ParsedCheckin
    ) -> CheckinTurnResult:
        project_id = session.get("currentProjectId")
        if not project_id:
            return CheckinTurnResult(reply="Mình chưa xác định được project hiện tại.",
                                     pattern="checkin:no_project")
        backlog = await self._bbpm.import_checkin(
            user_id=ctx.caller_user_id, project_id=project_id,
            work_date=parsed.work_date, hours=str(parsed.hours), description=parsed.summary,
        )
        await self._bbpm.complete_checkin_session(session["id"])
        log_event("checkin.state", state="COMPLETED", user_id=ctx.caller_user_id,
                  project_id=project_id)
        self.counters["completed"] += 1
        await self._audit(ctx, "checkin.worklog_created",
                          {"projectId": project_id, "backlogId": _id_of(backlog)})
        parts = [f"Đã ghi nhận: {parsed.summary}", f"{parsed.hours}h."]
        if parsed.status:
            parts.append(f"Trạng thái: {parsed.status}.")
        if parsed.blocker:
            parts.append("Có blocker.")
        return CheckinTurnResult(reply=" ".join(parts), pattern="checkin:completed_project")

    async def _complete_with_task(
        self, ctx: TurnRequest, session: dict[str, Any], task_id: int, parsed: ParsedCheckin
    ) -> CheckinTurnResult:
        project_id = session.get("currentProjectId")
        tasks = await self._list_project_tasks(ctx.caller_user_id, project_id)
        if not any(t["id"] == task_id for t in tasks):
            return CheckinTurnResult(
                reply=f"Task #{task_id} không nằm trong project hiện tại của bạn.",
                pattern="checkin:invalid_task",
            )
        backlog = await self._bbpm.import_checkin(
            user_id=ctx.caller_user_id, project_id=project_id, task_id=task_id,
            work_date=parsed.work_date, hours=str(parsed.hours), description=parsed.summary,
        )
        if parsed.status:
            await self._bbpm.transition_task(task_id, parsed.status)
        blocker = None
        if parsed.blocker:
            blocker = await self._bbpm.create_blocker(
                task_id, parsed.blocker.description, parsed.blocker.severity
            )
        await self._bbpm.complete_checkin_session(session["id"])
        log_event("checkin.state", state="COMPLETED", user_id=ctx.caller_user_id, task_id=task_id)
        self.counters["completed"] += 1
        await self._audit(ctx, "checkin.backlog_created",
                          {"taskId": task_id, "backlogId": _id_of(backlog)})
        parts = [f"Đã ghi nhận: {parsed.summary}", f"Backlog {_id_of(backlog)}, {parsed.hours}h."]
        if parsed.status:
            parts.append(f"Status: {parsed.status}.")
        if blocker:
            parts.append(f"Blocker {blocker.get('blockerId') or blocker.get('id')} đã được ghi.")
        return CheckinTurnResult(reply=" ".join(parts), pattern="checkin:completed")

    # ── edit-worklog flow ───────────────────────────────────────────────
    async def _start_edit_session(
        self, ctx: TurnRequest, thread_id: str, message_id: Optional[str]
    ) -> CheckinTurnResult:
        today = datetime.now(timezone.utc).date().isoformat()
        rows = await self._bbpm.checkin_status(date=today, user_id=ctx.caller_user_id)
        pending = [
            r for r in rows
            if r.get("status") == "PENDING" and (r.get("user") or {}).get("id") == ctx.caller_user_id
        ]
        if not pending:
            return CheckinTurnResult(
                reply="Hôm nay chưa có worklog nào để sửa. Gõ /checkin để tạo worklog mới nhé.",
                pattern="checkin:edit:none",
            )
        candidates = [
            {
                "id": r["id"],
                "description": r.get("description") or "",
                "hours": float(r.get("hours") or 0),
                "projectId": (r.get("project") or {}).get("id") or r.get("projectId"),
                "projectName": (r.get("project") or {}).get("name"),
                "workDate": str(r.get("workDate"))[:10],
            }
            for r in pending[:10]
        ]
        session = await self._ensure_session(ctx, thread_id, message_id)
        await self._bbpm.patch_checkin_session(
            session["id"], state="AWAITING_TASK_CONFIRM", pendingText="EDIT_WORKLOG_SELECT",
            pendingParsed={"mode": "EDIT_WORKLOG_SELECT", "candidates": candidates},
            lastMessageId=message_id or session.get("lastMessageId"), expiresAt=_expires_at_iso(),
        )
        return CheckinTurnResult(
            reply=f"Bạn muốn sửa worklog nào?\n{_format_worklog_choices(candidates)}\n\n"
            'Trả lời bằng số, hoặc gõ "hủy" để dừng.',
            pattern="checkin:edit:list",
        )

    async def _select_worklog_to_edit(
        self, ctx: TurnRequest, session: dict[str, Any], text: str, message_id: Optional[str]
    ) -> CheckinTurnResult:
        candidates = (session.get("pendingParsed") or {}).get("candidates", [])
        selected = _select_index(candidates, text)
        if not selected:
            return CheckinTurnResult(
                reply='Bạn chọn số worklog cần sửa giúp mình nhé, hoặc gõ "hủy" để dừng.',
                pattern="checkin:edit:select_clarify",
            )
        await self._bbpm.patch_checkin_session(
            session["id"], currentProjectId=selected["projectId"], state="AWAITING_UPDATE",
            pendingText="EDIT_WORKLOG_APPLY",
            pendingParsed={"mode": "EDIT_WORKLOG_APPLY", "backlogId": selected["id"],
                           "projectId": selected["projectId"]},
            lastMessageId=message_id or session.get("lastMessageId"), expiresAt=_expires_at_iso(),
        )
        desc = selected.get("description") or "không có nội dung"
        return CheckinTurnResult(
            reply=f"Đang sửa worklog: {desc} ({selected['hours']}h). "
            'Gửi nội dung mới + số giờ, hoặc gõ "hủy" để dừng.',
            pattern="checkin:edit:selected",
        )

    async def _update_existing_worklog(
        self, ctx: TurnRequest, session: dict[str, Any], parsed: ParsedCheckin
    ) -> CheckinTurnResult:
        pending = session.get("pendingParsed") or {}
        updated = await self._bbpm.update_checkin(
            pending["backlogId"], userId=ctx.caller_user_id, workDate=parsed.work_date,
            hours=str(parsed.hours), description=parsed.summary,
        )
        await self._bbpm.complete_checkin_session(session["id"])
        self.counters["completed"] += 1
        await self._audit(ctx, "checkin.worklog_updated",
                          {"backlogId": pending.get("backlogId"), "projectId": pending.get("projectId")})
        return CheckinTurnResult(
            reply=f"Đã cập nhật: {updated.get('description')} {updated.get('hours')}h.",
            pattern="checkin:edit:updated",
        )

    # ── queries / helpers ───────────────────────────────────────────────
    async def _answer_current_project(self, user_id: int) -> CheckinTurnResult:
        session = await self._get_session(user_id)
        if not session or not session.get("currentProjectId"):
            return CheckinTurnResult(reply="Mình chưa xác định được project hiện tại.",
                                     pattern="checkin:current_project_unknown")
        projects = await self._list_user_projects(user_id)
        project = next((p for p in projects if p["id"] == session["currentProjectId"]), None)
        if not project:
            return CheckinTurnResult(
                reply="Mình đã có project hiện tại nhưng chưa lấy được tên project.",
                pattern="checkin:current_project_unresolved",
            )
        return CheckinTurnResult(reply=f"Project hiện tại của bạn là {project['name']}.",
                                 pattern="checkin:current_project")

    async def _list_user_projects(self, user_id: int) -> list[dict[str, Any]]:
        try:
            return await self._bbpm.checkin_projects(user_id)
        except BbPmApiError as err:
            if err.status != 404:
                raise
        tasks = await self._bbpm.list_tasks(assignee_id=user_id, page_size=100)
        seen: set[int] = set()
        projects: list[dict[str, Any]] = []
        for task in tasks:
            project = task.get("project")
            if task.get("status") == "DONE" or not project or project["id"] in seen:
                continue
            seen.add(project["id"])
            projects.append(project)
        return projects

    async def _list_project_tasks(
        self, user_id: int, project_id: Optional[int]
    ) -> list[dict[str, Any]]:
        if not project_id:
            return []
        tasks = await self._bbpm.list_tasks(assignee_id=user_id, project_id=project_id, page_size=50)
        return [t for t in tasks if t.get("status") != "DONE"]

    async def _audit(self, ctx: TurnRequest, tool: str, args: dict[str, Any]) -> None:
        try:
            source = "other" if ctx.source == "eval" else (ctx.source or "chat")
            await self._bbpm.post_audit(tool=tool, args_json=args, source=source,
                                        correlation_id=ctx.correlation_id)
        except Exception:  # noqa: BLE001 — audit must never break the flow
            pass


# ── module-level pure helpers ──────────────────────────────────────────
def _is_cancel(text: str) -> bool:
    return bool(_CANCEL.match(normalize(text)))


def _is_worklog_start(text: str) -> bool:
    n = normalize(text)
    return bool(
        _WORKLOG_START_SLASH.match(text)
        or re.match(r"^(?:update|cap nhat) worklog$", n)
        or re.match(r"^(?:update|cap nhat) (?:cong viec|tien do)(?: hom nay)?$", n)
        or re.match(r"^(?:worklog|check in|checkin|project)$", n)
    )


def _is_worklog_edit(text: str) -> bool:
    n = normalize(text)
    return bool(
        _WORKLOG_EDIT_SLASH.match(text)
        or re.match(r"^(?:sua|chinh sua|edit|update|cap nhat lai) worklog(?: hom nay)?$", n)
        or re.match(r"^(?:sua|chinh sua|edit|update lai|cap nhat lai) (?:tien do|cong viec)(?: hom nay)?$", n)
    )


def _is_current_project_question(text: str) -> bool:
    return bool(re.match(r"^(?:project|du an) hien tai (?:la gi|la project nao)$", normalize(text)))


def _is_edit_select(session: dict[str, Any]) -> bool:
    return (session.get("pendingParsed") or {}).get("mode") == "EDIT_WORKLOG_SELECT"


def _is_edit_apply(session: dict[str, Any]) -> bool:
    return (session.get("pendingParsed") or {}).get("mode") == "EDIT_WORKLOG_APPLY"


def _select_by_text(items: list[dict[str, Any]], text: str) -> Optional[dict[str, Any]]:
    trimmed = text.strip()
    n = _safe_int(trimmed)
    if n is not None and 1 <= n <= len(items):
        return items[n - 1]
    q = normalize(trimmed)
    if not q:
        return None
    exact = next((it for it in items if normalize(it.get("name", "")) == q), None)
    if exact:
        return exact
    return next(
        (it for it in items
         if q in normalize(it.get("name", "")) or normalize(it.get("name", "")) in q),
        None,
    )


def _select_index(items: list[dict[str, Any]], text: str) -> Optional[dict[str, Any]]:
    n = _safe_int(text.strip())
    if n is not None and 1 <= n <= len(items):
        return items[n - 1]
    return None


def _format_worklog_choices(items: list[dict[str, Any]]) -> str:
    lines = []
    for i, item in enumerate(items):
        desc = item.get("description") or "không có nội dung"
        project = f" · {item['projectName']}" if item.get("projectName") else ""
        lines.append(f"{i + 1}. {desc} · {item['hours']}h{project}")
    return "\n".join(lines)


def _project_choice_text(options: list[ReplyOption]) -> str:
    choices = "\n".join(f"{i + 1}. {o.title}" for i, o in enumerate(options))
    return (
        f"Hôm nay bạn làm project nào?\n\nGần đây:\n{choices}\n\n"
        'Hoặc nhập tên project khác. Gõ "hủy" để dừng.'
    )


def _expires_at_iso() -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=settings.checkin_session_ttl_sec)).isoformat()


def _is_expired(session: dict[str, Any]) -> bool:
    raw = session.get("expiresAt")
    if not raw:
        return False
    try:
        expires = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return False
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires <= datetime.now(timezone.utc)


def _safe_int(value: str) -> Optional[int]:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _id_of(obj: Any) -> Any:
    return obj.get("id") if isinstance(obj, dict) else obj
