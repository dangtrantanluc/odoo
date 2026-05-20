"""Biến PlanDraft thành Project + Milestone + Task + Scope thật trên bb-pm.

Thứ tự gọi API:
  1. POST /projects
  2. POST /milestones/by-project/:projectId  (mỗi epic)
  3. POST /tasks/by-project/:projectId       (mỗi task — KHÔNG kèm depends)
  4. PATCH /tasks/:id                        (gắn milestoneId, priority, description)
  5. PATCH /tasks/:id                        (ghi "Phụ thuộc: #X" nếu có)
  6. POST /scopes/by-project/:projectId      (lưu estimatedHours per task)

Nếu một bước fail, các entity đã tạo trước đó vẫn được giữ (không rollback —
giảm rủi ro chỉ rollback một phần); errors[] tích lũy để user xem trên web
và dọn nếu cần.
"""

from __future__ import annotations

from core.logging import log_event
from infrastructure.bbpm_client import BbPmApiError, BbPmClient
from planning.models import MaterializeResult, PlanDraft


class PlanMaterializer:
    def __init__(self, bbpm: BbPmClient) -> None:
        self._bbpm = bbpm

    async def materialize(self, draft: PlanDraft, *, owner_user_id: int
                          ) -> MaterializeResult:
        # ── 1. Project ──────────────────────────────────────────────────
        project = await self._bbpm.create_project(
            name=draft.project_name,
            code=draft.project_code,
            description=draft.description,
            startDate=draft.start_date,
            endDate=draft.end_date,
            estimatedTotalHours=draft.estimated_total_hours,
            ownerId=owner_user_id,
            status="PLANNED",
        )
        project_id = int(project["id"])
        result = MaterializeResult(project_id=project_id)

        # ── 1b. Add member: owner + mọi assignee unique trong draft ─────
        #    Nếu không add, user không thấy project và task assign về null
        #    trên UI dù assigneeId được set ở Task.
        unique_user_ids: set[int] = {owner_user_id}
        for t in draft.tasks:
            if t.assignee_id:
                unique_user_ids.add(int(t.assignee_id))
        for uid in unique_user_ids:
            try:
                await self._bbpm.add_member(
                    project_id, user_id=uid,
                    role="OWNER" if uid == owner_user_id else "MEMBER",
                )
            except BbPmApiError as err:
                # Member trùng (409) hoặc user không cùng company — chỉ log,
                # không fail toàn flow.
                log_event("planning.materialize.member_failed", level="warning",
                          user_id=uid, error=str(err))
                result.errors.append(f"member user_id={uid}: {err}")

        # ── 2. Milestones (epic) ────────────────────────────────────────
        for epic in draft.epics:
            try:
                ms = await self._bbpm.create_milestone(
                    project_id,
                    name=epic.name,
                    due_date=epic.due_date,
                    description=epic.description,
                )
                result.milestone_ids[epic.key] = int(ms["id"])
            except BbPmApiError as err:
                msg = f"epic {epic.key} ({epic.name}): {err}"
                log_event("planning.materialize.epic_failed", level="warning",
                          epic_key=epic.key, error=str(err))
                result.errors.append(msg)

        # ── 3. Tasks (pass 1 — không có dependency text) ────────────────
        for t in draft.tasks:
            try:
                created = await self._bbpm.create_task(
                    project_id, t.name,
                    assignee_id=t.assignee_id,
                    deadline=t.deadline,
                )
                task_id = int(created["id"])
                result.task_ids[t.key] = task_id
                # gắn milestone + priority + description ban đầu
                patch_fields: dict = {}
                ms_id = result.milestone_ids.get(t.epic_key)
                if ms_id is not None:
                    patch_fields["milestoneId"] = ms_id
                if t.priority:
                    patch_fields["priority"] = t.priority
                if t.description:
                    patch_fields["description"] = t.description
                if patch_fields:
                    await self._bbpm.patch_task(task_id, **patch_fields)
            except BbPmApiError as err:
                msg = f"task {t.key} ({t.name}): {err}"
                log_event("planning.materialize.task_failed", level="warning",
                          task_key=t.key, error=str(err))
                result.errors.append(msg)

        # ── 4. Dependency vào description (pass 2) ──────────────────────
        for t in draft.tasks:
            task_id = result.task_ids.get(t.key)
            if task_id is None or not t.depends_on:
                continue
            dep_ids = [
                f"#{result.task_ids[k]}" for k in t.depends_on
                if k in result.task_ids
            ]
            if not dep_ids:
                continue
            new_desc = (t.description or "").rstrip()
            new_desc = (new_desc + "\n\n" if new_desc else "") + \
                       f"Phụ thuộc: {', '.join(dep_ids)}"
            try:
                await self._bbpm.patch_task(task_id, description=new_desc)
            except BbPmApiError as err:
                result.errors.append(f"task {t.key} cập nhật phụ thuộc: {err}")

        # ── 5. Scope per task (mang estimatedHours) ─────────────────────
        for t in draft.tasks:
            task_id = result.task_ids.get(t.key)
            if task_id is None or t.estimate_hours <= 0:
                continue
            try:
                scope = await self._bbpm.create_scope(
                    project_id,
                    name=f"Estimate: {t.name}"[:200],
                    estimated_hours=t.estimate_hours,
                    task_id=task_id,
                    assignee_id=t.assignee_id,
                )
                result.scope_ids[t.key] = int(scope["id"])
            except BbPmApiError as err:
                result.errors.append(f"scope {t.key}: {err}")

        log_event("planning.materialized", project_id=project_id,
                  tasks=len(result.task_ids), milestones=len(result.milestone_ids),
                  scopes=len(result.scope_ids), errors=len(result.errors))
        return result
