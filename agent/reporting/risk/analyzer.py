"""Phân tích risk từ worklog + task estimate.

Tín hiệu (per task):
  - OVERDUE      : deadline < today và status != DONE                   → HIGH
  - OVER_ESTIMATE: totalHours > scope.estimatedHours × 1.5 → HIGH, ×1.2 → MED
  - HIGH_BLOCKER : tồn tại TaskBlocker chưa resolve, severity = HIGH    → HIGH
  - STALE        : IN_PROGRESS và không có Backlog APPROVED ≥ STALE_DAYS → MED
  - NO_CHECKIN   : IN_PROGRESS và assignee không checkin hôm nay         → LOW

Score per task = max severity_weight (LOW=1, MED=3, HIGH=8) trong các tín hiệu.
Score project = sum task scores. Phân loại: <5 GREEN, <15 YELLOW, else RED.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Optional

from core.logging import log_event
from infrastructure.bbpm_client import BbPmApiError, BbPmClient
from infrastructure.llm_client import LlmClient


STALE_DAYS = 3
OVER_RATIO_MED = 1.2
OVER_RATIO_HIGH = 1.5

_SEVERITY_WEIGHT = {"LOW": 1, "MED": 3, "HIGH": 8}
_GREEN_MAX = 5
_YELLOW_MAX = 15


@dataclass
class TaskRisk:
    task_id: int
    task_name: str
    assignee_name: Optional[str]
    status: str
    signals: list[str] = field(default_factory=list)
    severity: str = "LOW"
    score: int = 0
    note: Optional[str] = None       # ví dụ "30h/16h" hoặc "stale 4d"


@dataclass
class ProjectRisk:
    project_id: int
    project_name: str
    overall: str                     # GREEN | YELLOW | RED
    score: int
    tasks: list[TaskRisk] = field(default_factory=list)
    narrative: Optional[str] = None
    error: Optional[str] = None


class RiskAnalyzer:
    def __init__(self, bbpm: BbPmClient, llm: Optional[LlmClient] = None) -> None:
        self._bbpm = bbpm
        self._llm = llm

    # ── public ──────────────────────────────────────────────────────────
    async def analyze_project(
        self, project_id: int, *, with_narrative: bool = False
    ) -> ProjectRisk:
        try:
            project = await self._bbpm.get_project(project_id)
        except BbPmApiError as err:
            return ProjectRisk(project_id=project_id, project_name=f"#{project_id}",
                               overall="GREEN", score=0, error=str(err))

        tasks = await self._bbpm.list_tasks(project_id=project_id, page_size=300)
        scopes = await self._safe_scopes(project_id)
        scope_by_task: dict[int, dict[str, Any]] = {}
        for s in scopes:
            tid = s.get("taskId")
            if tid:
                scope_by_task[int(tid)] = s

        worklog_dates = self._date_window(days=STALE_DAYS + 1)
        worklog_by_task = await self._fetch_worklogs(project_id, worklog_dates)
        today_iso = date.today().isoformat()
        worklogs_today = worklog_by_task.get(today_iso, [])
        assignees_checked_in_today = {
            (w.get("user") or {}).get("id") for w in worklogs_today
            if w.get("user")
        }

        task_risks: list[TaskRisk] = []
        for t in tasks:
            tr = self._task_risk(t, scope_by_task, worklog_by_task, assignees_checked_in_today)
            if tr.signals:
                task_risks.append(tr)

        total_score = sum(t.score for t in task_risks)
        overall = self._classify(total_score)
        report = ProjectRisk(
            project_id=project_id,
            project_name=project.get("name", f"#{project_id}"),
            overall=overall,
            score=total_score,
            tasks=task_risks,
        )

        if with_narrative and self._llm is not None and worklog_by_task:
            report.narrative = await self._narrate(project, worklog_by_task)

        return report

    async def analyze_company(self) -> list[ProjectRisk]:
        try:
            projects = await self._bbpm.list_projects(page_size=200)
        except BbPmApiError as err:
            log_event("risk.list_projects_failed", level="warning", error=str(err))
            return []
        active = [p for p in projects if p.get("status") == "IN_PROGRESS"]
        out: list[ProjectRisk] = []
        for p in active:
            try:
                out.append(await self.analyze_project(int(p["id"])))
            except Exception as err:  # noqa: BLE001
                log_event("risk.analyze_failed", level="warning",
                          project_id=p.get("id"), error=str(err))
        return out

    # ── computing per task ──────────────────────────────────────────────
    def _task_risk(
        self,
        task: dict[str, Any],
        scope_by_task: dict[int, dict[str, Any]],
        worklog_by_task: dict[str, list[dict[str, Any]]],
        checked_in_today: set,
    ) -> TaskRisk:
        task_id = int(task["id"])
        status = (task.get("status") or "").upper()
        assignee = task.get("assignee") or {}
        tr = TaskRisk(
            task_id=task_id, task_name=task.get("name", ""),
            assignee_name=assignee.get("fullName"),
            status=status,
        )

        # OVERDUE
        deadline = (task.get("deadline") or "")[:10]
        today = date.today().isoformat()
        if deadline and status != "DONE" and deadline < today:
            tr.signals.append("OVERDUE")

        # OVER_ESTIMATE
        scope = scope_by_task.get(task_id)
        if scope and scope.get("estimatedHours"):
            est = _to_float(scope.get("estimatedHours"))
            actual = _to_float(task.get("totalHours"))
            if est and est > 0:
                ratio = actual / est
                if ratio >= OVER_RATIO_HIGH:
                    tr.signals.append("OVER_ESTIMATE_HIGH")
                    tr.note = f"{actual:g}h/{est:g}h"
                elif ratio >= OVER_RATIO_MED:
                    tr.signals.append("OVER_ESTIMATE")
                    tr.note = f"{actual:g}h/{est:g}h"

        # HIGH_BLOCKER
        for b in (task.get("blockers") or []):
            if not b.get("resolvedAt") and (b.get("severity") or "").upper() == "HIGH":
                tr.signals.append("HIGH_BLOCKER")
                break

        # STALE — không có worklog APPROVED N ngày
        if status == "IN_PROGRESS":
            last = self._last_worklog_date(task_id, worklog_by_task)
            if last is None:
                tr.signals.append("STALE")
            else:
                gap = (date.today() - last).days
                if gap >= STALE_DAYS:
                    tr.signals.append("STALE")
                    tr.note = (tr.note + " · " if tr.note else "") + f"stale {gap}d"

        # NO_CHECKIN — IN_PROGRESS + assignee không checkin hôm nay
        if status == "IN_PROGRESS" and assignee.get("id") \
                and assignee["id"] not in checked_in_today:
            tr.signals.append("NO_CHECKIN")

        # Severity = max
        weight = 0
        sev = "LOW"
        for sig in tr.signals:
            sig_sev = _signal_severity(sig)
            w = _SEVERITY_WEIGHT[sig_sev]
            if w > weight:
                weight, sev = w, sig_sev
        tr.severity, tr.score = sev, weight
        return tr

    # ── helpers ─────────────────────────────────────────────────────────
    @staticmethod
    def _classify(score: int) -> str:
        if score < _GREEN_MAX:
            return "GREEN"
        if score < _YELLOW_MAX:
            return "YELLOW"
        return "RED"

    @staticmethod
    def _date_window(*, days: int) -> list[str]:
        today = date.today()
        return [(today - timedelta(days=i)).isoformat() for i in range(days + 1)]

    async def _safe_scopes(self, project_id: int) -> list[dict[str, Any]]:
        try:
            return await self._bbpm.list_scopes(project_id)
        except BbPmApiError as err:
            log_event("risk.scopes_failed", level="warning",
                      project_id=project_id, error=str(err))
            return []

    async def _fetch_worklogs(
        self, project_id: int, dates: list[str]
    ) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {}
        for d in dates:
            try:
                rows = await self._bbpm.checkin_status(date=d, project_id=project_id)
            except BbPmApiError as err:
                log_event("risk.checkin_failed", level="warning",
                          project_id=project_id, date=d, error=str(err))
                rows = []
            out[d] = rows
        return out

    @staticmethod
    def _last_worklog_date(
        task_id: int, worklog_by_date: dict[str, list[dict[str, Any]]]
    ) -> Optional[date]:
        latest: Optional[date] = None
        for d, rows in worklog_by_date.items():
            for w in rows:
                wt_id = (w.get("task") or {}).get("id") or w.get("taskId")
                if wt_id != task_id:
                    continue
                if (w.get("status") or "").upper() == "REJECTED":
                    continue
                try:
                    wd = datetime.fromisoformat(d).date()
                except ValueError:
                    continue
                if latest is None or wd > latest:
                    latest = wd
        return latest

    async def _narrate(
        self, project: dict[str, Any], worklog_by_date: dict[str, list[dict[str, Any]]]
    ) -> Optional[str]:
        if self._llm is None:
            return None
        descriptions: list[str] = []
        for d in sorted(worklog_by_date.keys(), reverse=True):
            for w in worklog_by_date[d]:
                desc = (w.get("description") or "").strip()
                if not desc:
                    continue
                user = (w.get("user") or {}).get("fullName") or "?"
                descriptions.append(f"[{d}] {user}: {desc[:200]}")
                if len(descriptions) >= 30:
                    break
            if len(descriptions) >= 30:
                break
        if not descriptions:
            return None
        joined = "\n".join(descriptions)
        try:
            res = await self._llm.chat(
                [
                    {"role": "system", "content":
                        "Bạn là PM. Tóm tắt 3 ngày làm việc gần đây của 1 dự án "
                        "thành 3-5 dòng tiếng Việt, nêu: tiến độ chính, vướng mắc, "
                        "đề xuất hành động."},
                    {"role": "user", "content":
                        f"Dự án: {project.get('name','?')}\n\nWorklog:\n{joined}"},
                ],
                temperature=0.3,
            )
            return (res.content or "").strip() or None
        except Exception as err:  # noqa: BLE001
            log_event("risk.narrate_failed", level="warning", error=str(err))
            return None


# ── formatting helpers (dùng cho /risk + workflow) ─────────────────────
def format_risk_report(report: ProjectRisk) -> str:
    if report.error:
        return f"Không lấy được risk của dự án #{report.project_id}: {report.error}"
    badge = {"GREEN": "🟢", "YELLOW": "🟡", "RED": "🔴"}.get(report.overall, "•")
    lines = [
        f"{badge} Risk — {report.project_name}  "
        f"(score={report.score}, {report.overall})",
    ]
    if not report.tasks:
        lines.append("Không phát hiện task có vấn đề.")
    else:
        lines.append("\nTask có vấn đề:")
        for t in sorted(report.tasks, key=lambda x: -x.score)[:15]:
            sig = ", ".join(t.signals)
            who = f" → {t.assignee_name}" if t.assignee_name else ""
            note = f"  ({t.note})" if t.note else ""
            lines.append(f"• #{t.task_id} {t.task_name} — {sig}{who}{note}")
        if len(report.tasks) > 15:
            lines.append(f"… và {len(report.tasks) - 15} task khác.")
    if report.narrative:
        lines.append(f"\nTóm tắt:\n{report.narrative}")
    return "\n".join(lines)


# ── private utilities ──────────────────────────────────────────────────
def _to_float(value: Any) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _signal_severity(signal: str) -> str:
    if signal in {"OVERDUE", "OVER_ESTIMATE_HIGH", "HIGH_BLOCKER"}:
        return "HIGH"
    if signal in {"OVER_ESTIMATE", "STALE"}:
        return "MED"
    return "LOW"
