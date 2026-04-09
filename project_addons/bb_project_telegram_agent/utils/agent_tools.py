TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "get_today_summary",
            "description": "Lay tong quan hom nay ve task, gio lam viec va project rui ro.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_my_tasks",
            "description": "Lay danh sach task dang giao cho nguoi dung hien tai.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_overdue_tasks",
            "description": "Lay danh sach task dang tre han.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_all_tasks",
            "description": "Lay danh sach task trong pham vi nguoi dung duoc xem.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project_status",
            "description": "Lay tinh hinh tong quan cua mot project cu the.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_ref": {
                        "type": "string",
                        "description": "Ma hoac ten project.",
                    },
                },
                "required": ["project_ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project_tasks",
            "description": "Lay danh sach task cua mot project cu the.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_ref": {
                        "type": "string",
                        "description": "Ma hoac ten project.",
                    },
                },
                "required": ["project_ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project_budget",
            "description": "Lay thong tin budget, chi phi va muc do burn cua mot project cu the.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_ref": {
                        "type": "string",
                        "description": "Ma hoac ten project.",
                    },
                },
                "required": ["project_ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_project_blockers",
            "description": "Lay cac blocker hien tai cua mot project cu the.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_ref": {
                        "type": "string",
                        "description": "Ma hoac ten project.",
                    },
                },
                "required": ["project_ref"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_projects_at_risk",
            "description": "Lay danh sach project dang co rui ro cao.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_portfolio_summary",
            "description": "Lay tong quan danh muc project ma nguoi dung duoc xem.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
]


def _compact_tool_result(result):
    if not isinstance(result, dict) or result.get("error"):
        return result

    compacted = {}
    for key in (
        "intent",
        "title",
        "date",
        "task_counts",
        "metrics",
        "overdue_count",
        "high_overdue_count",
        "approved_hours_today",
        "pending_backlog_count",
        "approved_hours_total",
        "budget_burn_pct",
        "total_count",
        "top_risky_projects",
    ):
        if key in result:
            compacted[key] = result[key]

    project = result.get("project")
    if isinstance(project, dict):
        compacted["project"] = {
            "id": project.get("id"),
            "name": project.get("name"),
            "code": project.get("code"),
            "status": project.get("status"),
            "priority": project.get("priority"),
            "budget": project.get("budget"),
            "total_cost": project.get("total_cost"),
            "budget_remaining": project.get("budget_remaining"),
            "end_date": project.get("end_date"),
        }

    tasks = result.get("tasks")
    if isinstance(tasks, list):
        compacted["tasks"] = [
            {
                "name": task.get("name"),
                "status": task.get("status"),
                "priority": task.get("priority"),
                "deadline": task.get("deadline"),
                "assignee": task.get("assignee"),
                "issues": task.get("issues") or None,
                "project": task.get("project"),
                "project_code": task.get("project_code"),
                "project_id": task.get("project_id"),
            }
            for task in tasks
        ]

    blockers = result.get("blockers")
    if isinstance(blockers, list):
        compacted["blockers"] = [
            {
                "task_name": blocker.get("task_name"),
                "priority": blocker.get("priority"),
                "deadline": blocker.get("deadline"),
                "issue": blocker.get("issue"),
            }
            for blocker in blockers
        ]

    projects = result.get("projects")
    if isinstance(projects, list):
        compacted["projects"] = [
            {
                "id": project.get("id"),
                "name": project.get("name"),
                "code": project.get("code"),
                "status": project.get("status"),
                "priority": project.get("priority"),
                "budget_remaining": project.get("budget_remaining"),
                "end_date": project.get("end_date"),
            }
            for project in projects
        ]

    return compacted or result
