"""Vietnamese rendering helpers for tool / fast-path replies.

Ports the formatter logic in bb-pm-tools/src/routing/fast-path/formatters.ts.
Output is plain text (Gapo Work does not render markdown).
"""

from __future__ import annotations

from typing import Any


def _date(value: Any) -> str:
    if not value:
        return "—"
    return str(value)[:10]


def task_line(task: dict[str, Any]) -> str:
    name = task.get("name", "?")
    project = (task.get("project") or {}).get("name")
    assignee = (task.get("assignee") or {}).get("fullName")
    bits = [f"• {name}"]
    if project:
        bits.append(f"({project})")
    if task.get("deadline"):
        bits.append(f"— hạn {_date(task['deadline'])}")
    if assignee:
        bits.append(f"— {assignee}")
    if task.get("status"):
        bits.append(f"[{task['status']}]")
    return " ".join(bits)


def task_list(title: str, tasks: list[dict[str, Any]], *, empty: str, limit: int = 10) -> str:
    if not tasks:
        return empty
    lines = [title, ""]
    lines += [task_line(t) for t in tasks[:limit]]
    if len(tasks) > limit:
        lines.append(f"… và {len(tasks) - limit} task nữa.")
    return "\n".join(lines)


def project_list(projects: list[dict[str, Any]]) -> str:
    if not projects:
        return "Hiện chưa có dự án nào đang chạy."
    lines = ["Dự án đang chạy:", ""]
    for p in projects[:15]:
        done = p.get("doneTaskCount")
        total = p.get("taskCount")
        progress = f" — {done}/{total}" if done is not None and total is not None else ""
        lines.append(f"• {p.get('name', '?')}{progress}")
    return "\n".join(lines)


def digest(d: dict[str, Any]) -> str:
    totals = d.get("totals", {})
    lines = [
        "📊 Digest hôm nay",
        "",
        f"• Dự án active: {totals.get('activeProjects', 0)}",
        f"• Task mở: {totals.get('openTasks', 0)} | Quá hạn: {totals.get('overdueTasks', 0)}"
        f" | Lâu chưa update: {totals.get('staleTasks', 0)} | Chưa gán: {totals.get('unassignedTasks', 0)}",
    ]
    projects = d.get("projects", [])[:5]
    if projects:
        lines += ["", "Dự án:"]
        for p in projects:
            pct = p.get("completionPct")
            pct_s = f"{round(pct)}%" if pct is not None else "—"
            lines.append(f"• {p.get('name', '?')}: {p.get('doneTaskCount', 0)}/{p.get('taskCount', 0)} ({pct_s})")
    return "\n".join(lines)


def weekly(r: dict[str, Any]) -> str:
    totals = r.get("totals", {})
    window = r.get("window", {})
    lines = [
        f"📆 Weekly Report ({_date(window.get('start'))} → {_date(window.get('end'))})",
        "",
        f"• Task done: {totals.get('tasksDone', 0)} | Task mới: {totals.get('newTasks', 0)}"
        f" | Blocker mới: {totals.get('newBlockers', 0)}",
        f"• Giờ duyệt: {totals.get('hoursApproved', 0)}h",
    ]
    return "\n".join(lines)


def hygiene(r: dict[str, Any]) -> str:
    mo = r.get("missingOwner", [])
    md = r.get("missingDeadline", [])
    ss = r.get("staleStatus", [])
    lines = [
        "🧹 Data Hygiene Check",
        "",
        f"• Thiếu owner: {len(mo)}",
        f"• Thiếu deadline: {len(md)}",
        f"• Stale: {len(ss)}",
    ]
    return "\n".join(lines)
