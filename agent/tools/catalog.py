"""Tool catalog — query + action functions over the bb-pm API.

Ports bb-pm-tools/src/tools/catalog.ts. Each query tool returns Gapo-ready
Vietnamese text; action tools return a structured result. Used by the
fast-path router, the action router and the workflow registry.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from infrastructure.bbpm_client import BbPmClient
from shared.text import normalize
from tools import format as fmt


class ToolCatalog:
    def __init__(self, bbpm: BbPmClient) -> None:
        self._bbpm = bbpm

    # ── query tools (return VN text) ────────────────────────────────────
    async def my_tasks_today(self, user_id: int) -> str:
        tasks = await self._bbpm.list_tasks(assignee_id=user_id, page_size=100)
        open_tasks = [t for t in tasks if t.get("status") != "DONE"]
        return fmt.task_list("Task đang mở của bạn:", open_tasks,
                             empty="Bạn không có task nào đang mở. 🎉")

    async def deadlines_this_week(self, user_id: int) -> str:
        tasks = await self._bbpm.list_tasks(assignee_id=user_id, page_size=100)
        horizon = date.today() + timedelta(days=7)
        upcoming = [
            t for t in tasks
            if t.get("status") != "DONE" and t.get("deadline")
            and str(t["deadline"])[:10] <= horizon.isoformat()
        ]
        upcoming.sort(key=lambda t: str(t.get("deadline")))
        return fmt.task_list("Deadline trong 7 ngày tới:", upcoming,
                             empty="Không có deadline nào trong 7 ngày tới.")

    async def my_projects(self, user_id: int) -> str:
        try:
            projects = await self._bbpm.checkin_projects(user_id)
        except Exception:  # noqa: BLE001
            projects = []
        if not projects:
            return "Bạn chưa tham gia dự án nào đang chạy."
        return "Dự án của bạn:\n\n" + "\n".join(f"• {p.get('name', '?')}" for p in projects)

    async def overdue_tasks(self, project_id: int | None = None, days: int | None = None) -> str:
        tasks = await self._bbpm.list_overdue_tasks(project_id=project_id, days=days)
        return fmt.task_list("Task quá hạn:", tasks, empty="Không có task nào quá hạn. 👍")

    async def stale_tasks(self, days: int = 14) -> str:
        tasks = await self._bbpm.list_stale_tasks(days_since_update=days)
        return fmt.task_list(f"Task lâu chưa update (≥ {days} ngày):", tasks,
                             empty="Không có task nào bị stale.")

    async def data_hygiene(self, stale_days: int = 14) -> str:
        return fmt.hygiene(await self._bbpm.check_hygiene(stale_days=stale_days))

    async def daily_digest(self) -> str:
        return fmt.digest(await self._bbpm.digest())

    async def weekly_report(self, days: int = 7) -> str:
        return fmt.weekly(await self._bbpm.weekly_report(days=days))

    async def list_projects(self) -> str:
        return fmt.project_list(await self._bbpm.list_projects())

    async def list_automations(self) -> str:
        autos = await self._bbpm.list_automations(active=True)
        if not autos:
            return "Hiện không có automation nào đang bật."
        lines = ["Automation đang chạy:", ""]
        for a in autos:
            lines.append(f"• {a.get('name', '?')} — {a.get('workflow')} @ {a.get('schedule')}")
        return "\n".join(lines)

    async def project_snapshot(self, name: str) -> str:
        projects = await self._bbpm.list_projects(q=name)
        if not projects:
            return f'Không tìm thấy dự án nào khớp "{name}".'
        q = normalize(name)
        project = next((p for p in projects if normalize(p.get("name", "")) == q), projects[0])
        tasks = await self._bbpm.list_tasks(project_id=project["id"], page_size=100)
        open_count = sum(1 for t in tasks if t.get("status") != "DONE")
        done_count = sum(1 for t in tasks if t.get("status") == "DONE")
        return (
            f"Dự án {project.get('name')}:\n"
            f"• Tổng task: {len(tasks)} | Đang mở: {open_count} | Done: {done_count}\n"
            f"• Trạng thái: {project.get('status', '?')}"
        )

    async def search_tasks(self, keyword: str) -> str:
        tasks = await self._bbpm.list_tasks(q=keyword, page_size=50)
        return fmt.task_list(f'Task khớp "{keyword}":', tasks,
                             empty=f'Không tìm thấy task nào khớp "{keyword}".')

    async def users_workload(self) -> str:
        users = await self._bbpm.users_workload()
        if not users:
            return "Chưa có dữ liệu workload."
        lines = ["Khối lượng công việc:", ""]
        for u in users[:15]:
            lines.append(f"• {u.get('fullName', '?')}: {u.get('openTasks', 0)} task mở")
        return "\n".join(lines)

    async def person_tasks(self, name: str) -> str:
        users = await self._bbpm.list_users()
        q = normalize(name)
        user = next((u for u in users if q in normalize(u.get("fullName", ""))), None)
        if not user:
            return f'Không tìm thấy người nào tên "{name}".'
        tasks = await self._bbpm.list_tasks(assignee_id=user["id"], page_size=100)
        open_tasks = [t for t in tasks if t.get("status") != "DONE"]
        return fmt.task_list(f"Task đang mở của {user.get('fullName')}:", open_tasks,
                             empty=f"{user.get('fullName')} không có task nào đang mở.")

    # ── action tools (return structured result) ─────────────────────────
    async def create_task(self, project_id: int, name: str, **kw: Any) -> dict[str, Any]:
        return await self._bbpm.create_task(project_id, name, **kw)

    async def transition_task(self, task_id: int, status: str) -> dict[str, Any]:
        return await self._bbpm.transition_task(task_id, status)

    async def patch_task(self, task_id: int, **fields: Any) -> dict[str, Any]:
        return await self._bbpm.patch_task(task_id, **fields)

    async def create_project(self, **fields: Any) -> dict[str, Any]:
        return await self._bbpm.create_project(**fields)
