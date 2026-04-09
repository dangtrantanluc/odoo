def render_today_summary(payload: dict) -> str:
    counts = payload["task_counts"]
    risky = payload.get("top_risky_projects") or []
    risky_text = ", ".join(risky[:3]) if risky else "Khong co"

    return (
        f"BB PM - Tong hop hom nay ({payload['date']})\n"
        f"- Todo: {counts['todo']}\n"
        f"- In progress: {counts['in_progress']}\n"
        f"- Review: {counts['review']}\n"
        f"- Done: {counts['done']}\n"
        f"- Overdue: {payload['overdue_count']}\n"
        f"- High/Critical overdue: {payload['high_overdue_count']}\n"
        f"- Approved hours today: {payload['approved_hours_today']}\n"
        f"- Pending backlog: {payload['pending_backlog_count']}\n"
        f"- Project can chu y: {risky_text}"
    )


def render_task_list(payload: dict) -> str:
    tasks = payload.get("tasks") or []
    if not tasks:
        return f"{payload['title']}\nKhong co task phu hop."

    lines = [f"{payload['title']} (hien {len(tasks)}/{payload['total_count']})"]
    for task in tasks:
        deadline = task.get("deadline") or "-"
        assignee = task.get("assignee") or "-"
        lines.append(
            f"- [{task['status']}] {task['name']} | {task['project']} | {assignee} | deadline: {deadline}"
        )

    if payload["total_count"] > len(tasks):
        lines.append(f"- Con {payload['total_count'] - len(tasks)} task nua, hay hoi cu the hon de loc tiep.")

    return "\n".join(lines)


def render_project_budget(payload: dict) -> str:
    project = payload["project"]
    return (
        f"Budget project: {project['name']} [{project.get('code') or '-'}]\n"
        f"- Budget: {project['budget']}\n"
        f"- Cost: {project['total_cost']}\n"
        f"- Remaining: {project['budget_remaining']}\n"
        f"- Approved hours: {payload['approved_hours_total']}\n"
        f"- Burn rate: {payload['budget_burn_pct']}%"
    )


def render_project_blockers(payload: dict) -> str:
    blockers = payload.get("blockers") or []
    if not blockers:
        return f"Project {payload['project']['name']} hien khong co blocker ro rang."

    lines = [f"Blocker cua project {payload['project']['name']}"]
    for blocker in blockers:
        lines.append(
            f"- [{blocker['priority']}] {blocker['task_name']} | deadline: {blocker['deadline'] or '-'} | van de: {blocker['issue']}"
        )
    return "\n".join(lines)


def render_portfolio_summary(payload: dict) -> str:
    metrics = payload.get("metrics") or {}
    projects = payload.get("projects") or []
    lines = [
        f"{payload['title']}",
        f"- Tong project: {metrics.get('project_count', 0)}",
        f"- Dang chay: {metrics.get('in_progress_count', 0)}",
        f"- On hold: {metrics.get('on_hold_count', 0)}",
        f"- Hoan thanh: {metrics.get('completed_count', 0)}",
        f"- Qua han: {metrics.get('overdue_project_count', 0)}",
    ]
    if projects:
        lines.append("- Project can chu y:")
        for project in projects:
            lines.append(
                f"  {project['name']} [{project.get('code') or '-'}] | status: {project['status']} | remaining: {project['budget_remaining']}"
            )
    return "\n".join(lines)


def render_project_status(payload: dict) -> str:
    project = payload["project"]
    counts = payload["task_counts"]

    return (
        f"Project: {project['name']} [{project.get('code') or '-'}]\n"
        f"- Status: {project['status']}\n"
        f"- Priority: {project['priority']}\n"
        f"- Owner: {project['owner']}\n"
        f"- Todo: {counts['todo']}\n"
        f"- In progress: {counts['in_progress']}\n"
        f"- Review: {counts['review']}\n"
        f"- Done: {counts['done']}\n"
        f"- Overdue: {payload['overdue_count']}\n"
        f"- Approved hours: {payload['approved_hours_total']}\n"
        f"- Budget: {project['budget']}\n"
        f"- Cost: {project['total_cost']}\n"
        f"- Remaining: {project['budget_remaining']}"
    )


def render_help() -> str:
    return (
        "Ban co the hoi:\n"
        "- toi muon tong hop ve tien do task hom nay\n"
        "- cho toi xem tinh hinh project MCK-LPS\n"
        "- task nao dang tre han\n"
        "- cho toi xem tat ca task trong account nay\n"
        "- task cua toi la gi\n"
        "- budget project Mobile Banking App\n"
        "- project nao dang co rui ro\n"
        "- moi ngay 5h gui cho toi tong hop tien do project\n"
        "- /summary_on 08:00 | /summary_off | /clear"
    )
