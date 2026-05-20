"""Pydantic models — PlanDraft và các thành phần con.

PlanDraft là DTO trung gian giữa LLM (sinh/sửa kế hoạch) và materializer
(tạo Project/Milestone/Task/Scope thật). Mọi key (epic_key, task key) là
chuỗi ổn định trong phạm vi draft, dùng cho dependency và mapping sau khi
materialize.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator


class PlanEpic(BaseModel):
    key: str                          # "E1", "E2", ...
    name: str
    description: Optional[str] = None
    due_date: Optional[str] = None    # YYYY-MM-DD

    @field_validator("key")
    @classmethod
    def _strip_key(cls, v: str) -> str:
        return v.strip()


class PlannedTask(BaseModel):
    key: str                          # "T1", "T2", ...
    name: str
    description: Optional[str] = None
    estimate_hours: float = 0.0
    epic_key: str                     # tham chiếu PlanEpic.key
    depends_on: list[str] = Field(default_factory=list)
    assignee_id: Optional[int] = None
    assignee_name: Optional[str] = None
    priority: Optional[str] = None    # LOW | MEDIUM | HIGH | URGENT
    deadline: Optional[str] = None    # YYYY-MM-DD

    @field_validator("key")
    @classmethod
    def _strip_key(cls, v: str) -> str:
        return v.strip()


class PlanDraft(BaseModel):
    project_name: str
    project_code: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    estimated_total_hours: Optional[float] = None
    epics: list[PlanEpic] = Field(default_factory=list)
    tasks: list[PlannedTask] = Field(default_factory=list)

    # Trạng thái sau materialize — vẫn lưu trong draft để truy vết.
    materialized: bool = False
    project_id: Optional[int] = None

    # ── validation cross-field ─────────────────────────────────────────
    def validate_references(self) -> list[str]:
        """Trả về list lỗi tham chiếu (rỗng = hợp lệ)."""
        errs: list[str] = []
        epic_keys = {e.key for e in self.epics}
        task_keys = {t.key for t in self.tasks}
        if len(epic_keys) != len(self.epics):
            errs.append("epic.key bị trùng")
        if len(task_keys) != len(self.tasks):
            errs.append("task.key bị trùng")
        for t in self.tasks:
            if t.epic_key not in epic_keys:
                errs.append(f"task {t.key} trỏ tới epic không tồn tại: {t.epic_key}")
            for d in t.depends_on:
                if d not in task_keys:
                    errs.append(f"task {t.key} depends_on key không tồn tại: {d}")
                if d == t.key:
                    errs.append(f"task {t.key} phụ thuộc chính nó")
        return errs


class MaterializeResult(BaseModel):
    """Kết quả sau khi materialize PlanDraft thành entity thật trên bb-pm."""
    project_id: int
    milestone_ids: dict[str, int] = Field(default_factory=dict)  # epic_key → id
    task_ids: dict[str, int] = Field(default_factory=dict)       # task.key → id
    scope_ids: dict[str, int] = Field(default_factory=dict)      # task.key → id
    errors: list[str] = Field(default_factory=list)
