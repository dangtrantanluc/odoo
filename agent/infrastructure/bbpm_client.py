"""bb-pm API client.

Ports bb-pm-tools/src/infrastructure/api-client.ts. Every domain read/write
goes through the bb-pm Fastify API (auth header `X-Agent-Token`) — the agent
never touches Postgres directly. Responses use the envelope
`{success, data, meta}`; `_data()` unwraps `data`.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

from core.config import settings
from core.logging import log_io


def _params(**kwargs: Any) -> dict[str, Any]:
    """Drop None values so optional query params are omitted."""
    return {k: v for k, v in kwargs.items() if v is not None}


def _to_float(value: Any) -> float:
    """Coerce hours / decimal-like fields to JSON number.

    bb-pm API (Zod) reject string khi schema khai báo number — vd
    `hours: z.number()`. Caller cũ có thể truyền `"2"`; ép về float để
    payload luôn hợp lệ.
    """
    if isinstance(value, bool):  # bool là instance của int — chặn nhầm lẫn
        raise TypeError("hours không nhận bool")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return float(value.strip())
    raise TypeError(f"hours phải là số hoặc str, nhận {type(value).__name__}")


class BbPmApiError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"bb-pm API {status}: {body[:300]}")


class BbPmClient:
    def __init__(self) -> None:
        self.client = httpx.AsyncClient(
            base_url=settings.bb_pm.base_url,
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={
                "X-Agent-Token": settings.bb_pm.agent_token,
                "Content-Type": "application/json",
            },
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        res = await self.client.request(method, path, **kwargs)
        if res.status_code >= 400:
            log_io("bbpm.error", method=method, path=path, status=res.status_code,
                   body=res.text[:500])
            raise BbPmApiError(res.status_code, res.text)
        if res.status_code == 204 or not res.content:
            return {"success": True, "data": None}
        return res.json()

    async def _data(self, method: str, path: str, **kwargs: Any) -> Any:
        return (await self.request(method, path, **kwargs)).get("data")

    # ── Health ──────────────────────────────────────────────────────────
    async def health(self) -> dict[str, Any]:
        return await self.request("GET", "/health")

    # ── Tasks ───────────────────────────────────────────────────────────
    async def list_tasks(
        self,
        *,
        project_id: Optional[int] = None,
        status: Optional[str] = None,
        assignee_id: Optional[int] = None,
        q: Optional[str] = None,
        page_size: int = 50,
        sort: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/tasks", params=_params(
            projectId=project_id, status=status, assigneeId=assignee_id,
            q=q, pageSize=page_size, sort=sort,
        ))

    async def get_task(self, task_id: int) -> dict[str, Any]:
        return await self._data("GET", f"/tasks/{task_id}")

    async def list_overdue_tasks(
        self, *, project_id: Optional[int] = None, days: Optional[int] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/tasks/overdue", params=_params(
            projectId=project_id, days=days, limit=limit))

    async def list_stale_tasks(
        self, *, project_id: Optional[int] = None,
        days_since_update: Optional[int] = None, limit: int = 50,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/tasks/stale", params=_params(
            projectId=project_id, daysSinceUpdate=days_since_update, limit=limit))

    async def check_hygiene(
        self, *, project_id: Optional[int] = None, stale_days: int = 14,
    ) -> dict[str, Any]:
        return await self._data("GET", "/tasks/hygiene", params=_params(
            projectId=project_id, staleDays=stale_days))

    async def transition_task(self, task_id: int, status: str) -> dict[str, Any]:
        return await self._data("POST", f"/tasks/{task_id}/transition",
                                 json={"status": status})

    async def create_task(
        self, project_id: int, name: str, *,
        assignee_id: Optional[int] = None, deadline: Optional[str] = None,
    ) -> dict[str, Any]:
        return await self._data("POST", f"/tasks/by-project/{project_id}",
                                 json=_params(name=name, assigneeId=assignee_id,
                                              deadline=deadline))

    async def patch_task(self, task_id: int, **fields: Any) -> dict[str, Any]:
        return await self._data("PATCH", f"/tasks/{task_id}", json=_params(**fields))

    async def create_blocker(
        self, task_id: int, description: str, severity: str = "MED",
    ) -> dict[str, Any]:
        return await self._data("POST", f"/tasks/{task_id}/blocker",
                                 json={"description": description, "severity": severity})

    # ── Members ────────────────────────────────────────────────────────
    async def add_member(
        self, project_id: int, *, user_id: int, role: Optional[str] = None,
    ) -> dict[str, Any]:
        return await self._data("POST", f"/members/by-project/{project_id}",
                                 json=_params(userId=user_id, role=role))

    async def list_members(self, project_id: int) -> list[dict[str, Any]]:
        return await self._data("GET", "/members",
                                 params={"projectId": project_id})

    # ── Milestones (đóng vai "epic") ───────────────────────────────────
    async def create_milestone(
        self, project_id: int, *,
        name: str,
        due_date: Optional[str] = None,
        description: Optional[str] = None,
        status: Optional[str] = None,
    ) -> dict[str, Any]:
        return await self._data("POST", f"/milestones/by-project/{project_id}",
                                 json=_params(name=name, dueDate=due_date,
                                              description=description, status=status))

    async def list_milestones(self, project_id: int) -> list[dict[str, Any]]:
        return await self._data("GET", "/milestones", params={"projectId": project_id})

    async def patch_milestone(self, milestone_id: int, **fields: Any) -> dict[str, Any]:
        return await self._data("PATCH", f"/milestones/{milestone_id}",
                                 json=_params(**fields))

    # ── Scopes (mục estimate — gắn taskId để có estimate per-task) ─────
    async def create_scope(
        self, project_id: int, *,
        name: str,
        estimated_hours: Optional[float] = None,
        estimated_rate: Optional[float] = None,
        estimated_cost: Optional[float] = None,
        task_id: Optional[int] = None,
        assignee_id: Optional[int] = None,
        currency_id: Optional[int] = None,
        sequence: Optional[int] = None,
        notes: Optional[str] = None,
    ) -> dict[str, Any]:
        return await self._data("POST", f"/scopes/by-project/{project_id}",
                                 json=_params(name=name,
                                              estimatedHours=estimated_hours,
                                              estimatedRate=estimated_rate,
                                              estimatedCost=estimated_cost,
                                              taskId=task_id, assigneeId=assignee_id,
                                              currencyId=currency_id,
                                              sequence=sequence, notes=notes))

    async def list_scopes(self, project_id: int) -> list[dict[str, Any]]:
        return await self._data("GET", "/scopes", params={"projectId": project_id})

    # ── Projects ────────────────────────────────────────────────────────
    async def get_project(self, project_id: int) -> dict[str, Any]:
        return await self._data("GET", f"/projects/{project_id}")

    async def list_projects(
        self, *, q: Optional[str] = None, page_size: int = 50,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/projects", params=_params(q=q, pageSize=page_size))

    async def create_project(self, **fields: Any) -> dict[str, Any]:
        return await self._data("POST", "/projects", json=_params(**fields))

    async def patch_project(self, project_id: int, **fields: Any) -> dict[str, Any]:
        return await self._data("PATCH", f"/projects/{project_id}", json=_params(**fields))

    async def digest(self) -> dict[str, Any]:
        return await self._data("GET", "/projects/digest")

    async def weekly_report(
        self, *, days: int = 7, project_id: Optional[int] = None,
    ) -> dict[str, Any]:
        return await self._data("GET", "/projects/weekly-report",
                                 params=_params(days=days, projectId=project_id))

    # ── Users ───────────────────────────────────────────────────────────
    async def list_users(self) -> list[dict[str, Any]]:
        return await self._data("GET", "/users")

    async def users_workload(
        self, *, department: Optional[str] = None, role: Optional[str] = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/agent/users-workload", params=_params(
            department=department, role=role, limit=limit))

    async def user_by_channel(
        self, channel: str, external_id: str, thread_id: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        data = await self._data("GET", "/agent/user-by-channel", params=_params(
            channel=channel, externalId=external_id, threadId=thread_id))
        if isinstance(data, dict):
            return data.get("user", data)
        return data

    async def gapo_thread(self, user_id: int) -> dict[str, Any]:
        return await self._data("GET", f"/agent/gapo-thread/{user_id}")

    # ── Role-based digest ───────────────────────────────────────────────
    async def role_based_digest(
        self, user_id: int, *, project_ids: Optional[list[int]] = None,
        include: Optional[list[str]] = None, detail_level: Optional[str] = None,
        days_ahead: Optional[int] = None, stale_days: Optional[int] = None,
    ) -> dict[str, Any]:
        return await self._data("GET", "/agent/digests/role-based", params=_params(
            userId=user_id, projectIds=project_ids, include=include,
            detailLevel=detail_level, daysAhead=days_ahead, staleDays=stale_days))

    # ── Audit ───────────────────────────────────────────────────────────
    async def post_audit(
        self, *, tool: str, args_json: Any, source: str = "chat",
        correlation_id: Optional[str] = None, result_json: Any = None,
        error_message: Optional[str] = None, duration_ms: Optional[int] = None,
    ) -> dict[str, Any]:
        return await self._data("POST", "/agent/audit", json=_params(
            tool=tool, argsJson=args_json, source=source, correlationId=correlation_id,
            resultJson=result_json, errorMessage=error_message, durationMs=duration_ms))

    async def cleanup_audit(self, days: int, dry_run: bool = False) -> dict[str, Any]:
        return await self._data("POST", "/agent/audit/cleanup",
                                 json={"days": days, "dryRun": dry_run})

    # ── Automations ─────────────────────────────────────────────────────
    async def list_automations(
        self, *, active: Optional[bool] = None, owner_id: Optional[int] = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/agent/automations", params=_params(
            active=active, ownerId=owner_id, limit=limit))

    async def create_automation(self, **fields: Any) -> dict[str, Any]:
        return await self._data("POST", "/agent/automations", json=_params(**fields))

    async def patch_automation(self, automation_id: int, **fields: Any) -> dict[str, Any]:
        return await self._data("PATCH", f"/agent/automations/{automation_id}",
                                 json=_params(**fields))

    async def delete_automation(self, automation_id: int) -> None:
        await self.request("DELETE", f"/agent/automations/{automation_id}")

    # ── Check-ins ───────────────────────────────────────────────────────
    async def import_checkin(
        self, *, user_id: int, project_id: int, work_date: str,
        hours: Any, description: str, task_id: Optional[int] = None,
    ) -> dict[str, Any]:
        return await self._data("POST", "/agent/checkins/import", json=_params(
            userId=user_id, projectId=project_id, taskId=task_id,
            workDate=work_date, hours=_to_float(hours),
            description=description))

    async def update_checkin(self, backlog_id: int, **fields: Any) -> dict[str, Any]:
        if "hours" in fields and fields["hours"] is not None:
            fields["hours"] = _to_float(fields["hours"])
        return await self._data("PATCH", f"/agent/checkins/{backlog_id}",
                                 json=_params(**fields))

    async def checkin_projects(self, user_id: int) -> list[dict[str, Any]]:
        return await self._data("GET", "/agent/checkins/projects",
                                 params={"userId": user_id})

    async def checkin_status(
        self, *, date: Optional[str] = None, project_id: Optional[int] = None,
        user_id: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/agent/checkins/status", params=_params(
            date=date, projectId=project_id, userId=user_id))

    async def missing_checkins(
        self, *, date: Optional[str] = None, project_id: Optional[int] = None,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/agent/checkins/missing", params=_params(
            date=date, projectId=project_id))

    async def project_daily_summary(
        self, project_id: int, *, date: Optional[str] = None,
    ) -> dict[str, Any]:
        return await self._data("GET", "/agent/checkins/project-daily-summary",
                                 params=_params(projectId=project_id, date=date))

    # ── Check-in sessions ───────────────────────────────────────────────
    async def start_checkin_session(
        self, *, user_id: int, gapo_user_id: str, thread_id: str, expires_at: str,
        last_message_id: Optional[str] = None,
    ) -> dict[str, Any]:
        return await self._data("POST", "/agent/checkin-sessions/start", json=_params(
            userId=user_id, gapoUserId=gapo_user_id, threadId=thread_id,
            expiresAt=expires_at, lastMessageId=last_message_id))

    async def current_checkin_session(self, user_id: int) -> Optional[dict[str, Any]]:
        return await self._data("GET", "/agent/checkin-sessions/current",
                                 params={"userId": user_id})

    async def patch_checkin_session(self, session_id: int, **fields: Any) -> dict[str, Any]:
        return await self._data("PATCH", f"/agent/checkin-sessions/{session_id}",
                                 json=_params(**fields))

    async def complete_checkin_session(self, session_id: int) -> dict[str, Any]:
        return await self._data("POST", f"/agent/checkin-sessions/{session_id}/complete",
                                 json={})

    # ── Memory ──────────────────────────────────────────────────────────
    async def post_memory(self, **fields: Any) -> dict[str, Any]:
        return await self._data("POST", "/agent/memory", json=_params(**fields))

    async def search_memory(
        self, *, q: Optional[str] = None, project_id: Optional[int] = None,
        task_id: Optional[int] = None, conversation_id: Optional[str] = None,
        days_back: Optional[int] = None, limit: int = 10,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/agent/memory/search", params=_params(
            q=q, projectId=project_id, taskId=task_id, conversationId=conversation_id,
            daysBack=days_back, limit=limit))

    # ── Follow-ups ──────────────────────────────────────────────────────
    async def post_follow_up(self, **fields: Any) -> dict[str, Any]:
        return await self._data("POST", "/agent/follow-up", json=_params(**fields))

    async def list_follow_ups(
        self, *, user_id: Optional[int] = None, task_id: Optional[int] = None,
        status: Optional[str] = None, days_back: Optional[int] = None, limit: int = 50,
    ) -> list[dict[str, Any]]:
        return await self._data("GET", "/agent/follow-ups", params=_params(
            userId=user_id, taskId=task_id, status=status, daysBack=days_back, limit=limit))

    async def patch_follow_up(
        self, follow_up_id: int, *, status: str, reply_text: Optional[str] = None,
    ) -> dict[str, Any]:
        return await self._data("PATCH", f"/agent/follow-up/{follow_up_id}",
                                 json=_params(status=status, replyText=reply_text))

    # ── Channel identity ────────────────────────────────────────────────
    async def channel_identity(self, user_id: int) -> list[dict[str, Any]]:
        return await self._data("GET", f"/agent/channel-identity/{user_id}")

    async def upsert_channel_identity(self, **fields: Any) -> dict[str, Any]:
        return await self._data("POST", "/agent/channel-identity", json=_params(**fields))

    # ── Reporting / NL-to-SQL ───────────────────────────────────────────
    async def report_schema(self) -> dict[str, Any]:
        return await self._data("GET", "/agent/report/schema")

    async def report_query(self, sql: str) -> dict[str, Any]:
        return await self._data("POST", "/agent/report/query", json={"sql": sql})
