import json
import logging
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

from odoo import fields, models

from ..utils.agent_tools import TOOL_DEFINITIONS, _compact_tool_result
from ..utils.intent_parser import extract_summary_time, parse_message
from ..utils.llm_client import _post_chat_completion, classify_intent, rewrite_reply, run_agent_loop
from ..utils.reply_renderer import (
    render_help,
    render_portfolio_summary,
    render_project_blockers,
    render_project_budget,
    render_project_status,
    render_task_list,
    render_today_summary,
)


_logger = logging.getLogger(__name__)


class BbProjectTelegramService(models.AbstractModel):
    _name = "bb.project.telegram.service"
    _description = "BB Project Telegram Service"

    _SESSION_TTL_MINUTES = 30
    _TELEGRAM_MAX_MESSAGE_LENGTH = 3500
    _AGENT_HISTORY_LIMIT = 20
    _AGENT_MAX_ITERATIONS = 5
    _AGENT_MEMORY_REFRESH_TURNS = 8
    _STRUCTURED_PROJECT_REF_PATTERN = re.compile(r"^[a-z0-9]+(?:[-_][a-z0-9]+)+$", re.IGNORECASE)

    def _project_model(self, user):
        return self.env["bb.project"].with_user(user)

    def _task_model(self, user):
        return self.env["bb.project.task"].with_user(user)

    def _backlog_model(self, user):
        return self.env["bb.project.backlog"].with_user(user)

    def _session_model(self):
        return self.env["bb.project.telegram.session"].sudo()

    def _log_model(self):
        return self.env["bb.project.telegram.message.log"].sudo()

    def _today(self):
        return fields.Date.today()

    def _now(self):
        return fields.Datetime.now()

    def _get_param(self, key, default=None):
        return self.env["ir.config_parameter"].sudo().get_param(key, default)

    def _llm_enabled(self):
        return str(self._get_param("bb_pm.telegram.enable_llm", "False")).lower() in {"1", "true", "yes"}

    def _serialize_tasks(self, tasks):
        return [
            {
                "id": task.id,
                "name": task.name,
                "project": task.project_id.name,
                "project_code": task.project_id.code,
                "project_id": task.project_id.id,
                "status": task.status,
                "priority": task.priority,
                "assignee": task.assignee_id.name,
                "deadline": str(task.deadline) if task.deadline else None,
                "issues": task.issues or "",
            }
            for task in tasks
        ]

    def _serialize_projects(self, projects):
        return [
            {
                "id": project.id,
                "name": project.name,
                "code": project.code,
                "status": project.status,
                "priority": project.priority,
                "owner": project.owner_id.name,
                "budget": project.budget,
                "total_cost": project.total_cost,
                "budget_remaining": project.budget_remaining,
                "start_date": str(project.start_date) if project.start_date else None,
                "end_date": str(project.end_date) if project.end_date else None,
            }
            for project in projects
        ]

    def resolve_project(self, user, project_ref):
        if not project_ref:
            return self.env["bb.project"]
        Project = self._project_model(user)
        return Project.search(
            [
                "|",
                ("code", "ilike", project_ref),
                ("name", "ilike", project_ref),
            ],
            limit=1,
        )

    def _resolve_project_from_context(self, link, project_ref=None, session=None):
        if project_ref:
            return self.resolve_project(link.user_id, project_ref)
        if session and session.last_project_id:
            return self._project_model(link.user_id).browse(session.last_project_id.id)
        return self.env["bb.project"]

    def _extract_context_project_id(self, payload):
        project_data = payload.get("project") or {}
        if project_data.get("id"):
            return project_data["id"]

        tasks = payload.get("tasks") or []
        if len(tasks) == 1 and tasks[0].get("project_id"):
            return tasks[0]["project_id"]

        projects = payload.get("projects") or []
        if len(projects) == 1 and projects[0].get("id"):
            return projects[0]["id"]

        return False

    def _session_expiry(self):
        return self._now() + timedelta(minutes=self._SESSION_TTL_MINUTES)

    def load_session(self, link):
        return self._session_model().search(
            [
                ("link_id", "=", link.id),
                ("expires_at", ">=", self._now()),
            ],
            limit=1,
        )

    def clear_session(self, link):
        self._session_model().search([("link_id", "=", link.id)]).unlink()

    def save_session(self, link, parsed, payload):
        session = self.load_session(link)
        project_id = self._extract_context_project_id(payload) or False
        values = {
            "link_id": link.id,
            "last_intent": parsed.get("intent"),
            "last_project_id": project_id,
            "last_period_key": parsed.get("period"),
            "context_json": json.dumps(
                {
                    "normalized_text": parsed.get("normalized_text"),
                    "intent": parsed.get("intent"),
                    "project_ref": parsed.get("project_ref"),
                },
                ensure_ascii=False,
            ),
            "expires_at": self._session_expiry(),
        }

        if session:
            session.write(values)
            return session
        return self._session_model().create(values)

    def _session_context(self, session):
        if not session:
            return {}
        raw_context = {}
        if session.context_json:
            try:
                raw_context = json.loads(session.context_json)
            except Exception:
                raw_context = {}
        return {
            "last_intent": session.last_intent,
            "last_project_id": session.last_project_id.id if session.last_project_id else None,
            "last_project_name": session.last_project_id.name if session.last_project_id else None,
            "last_period_key": session.last_period_key,
            "last_project_ref": raw_context.get("project_ref"),
            "last_normalized_text": raw_context.get("normalized_text"),
        }

    def _llm_project_candidates(self, link, limit=20):
        projects = self._project_model(link.user_id).search(
            [],
            order="priority desc, end_date asc, id desc",
            limit=limit,
        )
        return [
            {
                "code": project.code,
                "name": project.name,
                "status": project.status,
                "priority": project.priority,
            }
            for project in projects
        ]

    def _llm_runtime_config(self):
        base_url = self._get_param("bb_pm.llm.base_url")
        model = self._get_param("bb_pm.llm.model")
        if not base_url or not model:
            return None
        return {
            "base_url": base_url,
            "model": model,
            "api_key": self._get_param("bb_pm.llm.api_key"),
            "temperature": float(self._get_param("bb_pm.llm.temperature", 0.0) or 0.0),
            "timeout": int(self._get_param("bb_pm.llm.timeout", 30) or 30),
        }

    def _build_system_prompt(self, link):
        return (
            "You are BB PM Agent, an internal project management assistant.\n"
            "Respond in Vietnamese, concisely, never fabricate data.\n"
            f"Today: {self._today()}. Timezone: {link.timezone or 'Asia/Ho_Chi_Minh'}. User: {link.user_id.name or 'Unknown'}.\n\n"
            "== Long-term memory ==\n"
            f"{link.long_term_summary or 'No memory yet.'}\n\n"
            "== Projects ==\n"
            f"{json.dumps(self._llm_project_candidates(link), ensure_ascii=False)}\n\n"
            "== Rules ==\n"
            "- Always call a tool before answering quantitative questions.\n"
            "- 'du an do'/'no' may refer to the latest relevant project in conversation history.\n"
            "- Max 5 tool calls per reply.\n"
            "- /summary_on, /summary_off, /clear, /help are handled before you and never appear here."
        )

    def _load_conversation_history(self, session):
        if not session or not session.conversation_history_json:
            return []

        try:
            raw_history = json.loads(session.conversation_history_json)
        except Exception:
            return []

        history = []
        for item in raw_history or []:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            if role not in {"user", "assistant"}:
                continue
            if not isinstance(content, str) or not content.strip():
                continue
            history.append({"role": role, "content": content.strip()})
        return history[-self._AGENT_HISTORY_LIMIT:]

    def _extract_agent_context(self, messages):
        inferred_project_ref = None
        inferred_project_id = False

        for message in messages or []:
            if message.get("role") == "assistant":
                for tool_call in message.get("tool_calls") or []:
                    function_data = tool_call.get("function") or {}
                    raw_arguments = function_data.get("arguments") or "{}"
                    try:
                        arguments = json.loads(raw_arguments)
                    except Exception:
                        arguments = {}
                    if not inferred_project_ref and isinstance(arguments, dict):
                        project_ref = arguments.get("project_ref")
                        if project_ref:
                            inferred_project_ref = str(project_ref).strip()

            if message.get("role") != "tool":
                continue

            try:
                payload = json.loads(message.get("content") or "{}")
            except Exception:
                continue

            if not isinstance(payload, dict):
                continue

            inferred_project_id = inferred_project_id or self._extract_context_project_id(payload) or False
            project = payload.get("project") or {}
            if not inferred_project_ref and isinstance(project, dict):
                inferred_project_ref = project.get("code") or project.get("name")

        return inferred_project_ref, inferred_project_id

    def _execute_tool(self, link, name, args, session):
        args = args or {}
        tool_map = {
            "get_today_summary": lambda _args: self.get_today_summary(link),
            "get_my_tasks": lambda _args: self.get_my_tasks(link),
            "get_overdue_tasks": lambda _args: self.get_overdue_tasks(link),
            "get_all_tasks": lambda _args: self.get_all_tasks(link),
            "get_project_status": lambda _args: self.get_project_status(
                link, project_ref=_args.get("project_ref"), session=session
            ),
            "get_project_tasks": lambda _args: self.get_project_tasks(
                link, project_ref=_args.get("project_ref"), session=session
            ),
            "get_project_budget": lambda _args: self.get_project_budget(
                link, project_ref=_args.get("project_ref"), session=session
            ),
            "get_project_blockers": lambda _args: self.get_project_blockers(
                link, project_ref=_args.get("project_ref"), session=session
            ),
            "get_projects_at_risk": lambda _args: self.get_projects_at_risk(link),
            "get_portfolio_summary": lambda _args: self.get_portfolio_summary(link),
        }

        handler = tool_map.get(name)
        if not handler:
            return {"error": "Unknown tool"}

        try:
            return _compact_tool_result(handler(args))
        except Exception:
            _logger.exception("Agent tool execution failed: %s", name)
            return {"error": f"Failed to execute tool: {name}"}

    def _save_agent_session(self, link, session, user_text, reply_text, updated_messages):
        history = self._load_conversation_history(session)
        history.extend(
            [
                {"role": "user", "content": user_text},
                {"role": "assistant", "content": reply_text},
            ]
        )
        history = history[-self._AGENT_HISTORY_LIMIT:]

        inferred_intent = self._infer_intent_from_messages(updated_messages)
        inferred_project_ref, inferred_project_id = self._extract_agent_context(updated_messages)
        previous_project_id = session.last_project_id.id if session and session.last_project_id else False
        previous_context = {}
        if session and session.context_json:
            try:
                previous_context = json.loads(session.context_json)
            except Exception:
                previous_context = {}

        values = {
            "link_id": link.id,
            "last_intent": "agent",
            "last_project_id": inferred_project_id or previous_project_id or False,
            "last_period_key": session.last_period_key if session else False,
            "context_json": json.dumps(
                {
                    "normalized_text": user_text,
                    "intent": inferred_intent,
                    "project_ref": inferred_project_ref or previous_context.get("project_ref"),
                },
                ensure_ascii=False,
            ),
            "conversation_history_json": json.dumps(history, ensure_ascii=False),
            "turn_count": (session.turn_count if session else 0) + 1,
            "expires_at": self._session_expiry(),
        }

        if session:
            session.write(values)
            saved_session = session
        else:
            saved_session = self._session_model().create(values)

        link.sudo().write({"lifetime_turn_count": (link.lifetime_turn_count or 0) + 1})
        return saved_session

    def _call_summarise_memory(self, link, history):
        llm_config = self._llm_runtime_config()
        if not llm_config:
            return None

        prompt = (
            "Summarise this Telegram conversation memory in no more than 200 words.\n"
            "Merge it with the existing long-term memory.\n"
            "Focus on: frequently asked projects, preferred question style (budget/task/overview), and durable facts.\n"
            "Do not invent information. Return plain text only.\n\n"
            f"Existing long-term memory:\n{link.long_term_summary or 'No memory yet.'}\n\n"
            f"Recent conversation history:\n{json.dumps(history, ensure_ascii=False)}\n"
        )

        try:
            summary = _post_chat_completion(
                base_url=llm_config["base_url"],
                model=llm_config["model"],
                api_key=llm_config["api_key"],
                temperature=0.0,
                timeout=llm_config["timeout"],
                messages=[
                    {
                        "role": "system",
                        "content": "You maintain long-term memory for an internal PM Telegram agent. Return concise plain text only.",
                    },
                    {"role": "user", "content": prompt},
                ],
            )
        except Exception:
            _logger.exception("Failed to summarise Telegram long-term memory")
            return None

        summary = (summary or "").strip()
        return summary or None

    def _maybe_update_long_term_memory(self, link, session):
        if not session:
            return

        should_refresh = (session.turn_count or 0) >= self._AGENT_MEMORY_REFRESH_TURNS
        if not should_refresh and (link.lifetime_turn_count or 0):
            should_refresh = (link.lifetime_turn_count or 0) % 10 == 0
        if not should_refresh:
            return

        history = self._load_conversation_history(session)
        if not history:
            return

        summary = self._call_summarise_memory(link, history)
        if not summary:
            return

        link.sudo().write({"long_term_summary": summary})
        session.write({"turn_count": 0})

    def _infer_intent_from_messages(self, messages):
        intent_map = {
            "get_today_summary": "today_summary",
            "get_my_tasks": "my_tasks",
            "get_overdue_tasks": "overdue_tasks",
            "get_all_tasks": "all_tasks",
            "get_project_status": "project_status",
            "get_project_tasks": "project_tasks",
            "get_project_budget": "project_budget",
            "get_project_blockers": "project_blockers",
            "get_projects_at_risk": "projects_at_risk",
            "get_portfolio_summary": "portfolio_summary",
        }
        for message in messages or []:
            if message.get("role") != "assistant":
                continue
            for tool_call in message.get("tool_calls") or []:
                function_data = tool_call.get("function") or {}
                tool_name = function_data.get("name")
                if tool_name in intent_map:
                    return intent_map[tool_name]
        return "agent"

    def _handle_text_agent(self, link, text, rule_parsed):
        llm_config = self._llm_runtime_config()
        if not llm_config:
            raise RuntimeError("LLM configuration is incomplete")

        session = self.load_session(link)
        messages = [{"role": "system", "content": self._build_system_prompt(link)}]
        messages.extend(self._load_conversation_history(session))
        messages.append({"role": "user", "content": text})

        reply_text, updated_messages = run_agent_loop(
            base_url=llm_config["base_url"],
            model=llm_config["model"],
            api_key=llm_config["api_key"],
            temperature=llm_config["temperature"],
            timeout=llm_config["timeout"],
            messages=messages,
            tools=TOOL_DEFINITIONS,
            tool_executor=lambda name, args: self._execute_tool(link, name, args, session),
            max_iterations=self._AGENT_MAX_ITERATIONS,
        )
        reply_text = (reply_text or "").strip()
        if not reply_text:
            raise RuntimeError("Agent loop returned an empty reply")

        self._save_agent_session(link, session, text, reply_text, updated_messages)
        inferred_project_ref, _inferred_project_id = self._extract_agent_context(updated_messages)
        parsed = {
            "intent": self._infer_intent_from_messages(updated_messages),
            "project_ref": inferred_project_ref,
            "period": rule_parsed.get("period"),
            "normalized_text": rule_parsed.get("normalized_text"),
            "classification_source": "agent",
        }
        return {
            "parsed": parsed,
            "payload": {},
            "reply_text": reply_text,
        }

    def _build_task_payload(self, intent, title, Task, domain, limit=10):
        total_count = Task.search_count(domain)
        tasks = Task.search(domain, order="priority desc, deadline asc, id desc", limit=limit)
        return {
            "intent": intent,
            "title": title,
            "total_count": total_count,
            "tasks": self._serialize_tasks(tasks),
        }

    def get_all_tasks(self, link, limit=10):
        return self._build_task_payload(
            "all_tasks",
            "Danh sach task trong pham vi ban duoc xem",
            self._task_model(link.user_id),
            [],
            limit=limit,
        )

    def get_my_tasks(self, link, limit=10):
        user = link.user_id
        return self._build_task_payload(
            "my_tasks",
            "Task dang giao cho ban",
            self._task_model(user),
            [("assignee_id", "=", user.id), ("status", "!=", "done")],
            limit=limit,
        )

    def get_overdue_tasks(self, link, limit=10):
        today = self._today()
        return self._build_task_payload(
            "overdue_tasks",
            f"Task tre han tinh den {today}",
            self._task_model(link.user_id),
            [("deadline", "<", today), ("status", "!=", "done")],
            limit=limit,
        )

    def get_project_tasks(self, link, project_ref=None, session=None, limit=10):
        project = self._resolve_project_from_context(link, project_ref=project_ref, session=session)
        if not project:
            return {"error": "Project not found"}

        return self._build_task_payload(
            "project_tasks",
            f"Task cua project {project.name}",
            self._task_model(link.user_id),
            [("project_id", "=", project.id)],
            limit=limit,
        )

    def get_today_summary(self, link):
        user = link.user_id
        today = self._today()

        Task = self._task_model(user)
        Backlog = self._backlog_model(user)
        Project = self._project_model(user)

        task_groups = Task.read_group([], ["id:count"], ["status"], lazy=False)
        task_counts = {row["status"]: row.get("id_count", 0) for row in task_groups}

        overdue_count = Task.search_count([("deadline", "<", today), ("status", "!=", "done")])
        high_overdue_count = Task.search_count(
            [("deadline", "<", today), ("status", "!=", "done"), ("priority", "in", ["high", "critical"])]
        )
        approved_today = Backlog.read_group(
            [("work_date", "=", today), ("status", "=", "approved")],
            ["hours:sum"],
            [],
            lazy=False,
        )
        approved_hours_today = approved_today[0].get("hours", 0.0) if approved_today else 0.0
        pending_backlog_count = Backlog.search_count([("status", "=", "pending")])

        risky_projects = Project.search(
            [
                "|",
                ("status", "=", "on_hold"),
                "&",
                ("end_date", "!=", False),
                ("end_date", "<", today),
            ],
            limit=5,
        )

        return {
            "intent": "today_summary",
            "date": str(today),
            "task_counts": {
                "todo": task_counts.get("todo", 0),
                "in_progress": task_counts.get("in_progress", 0),
                "review": task_counts.get("review", 0),
                "done": task_counts.get("done", 0),
            },
            "overdue_count": overdue_count,
            "high_overdue_count": high_overdue_count,
            "approved_hours_today": approved_hours_today,
            "pending_backlog_count": pending_backlog_count,
            "top_risky_projects": risky_projects.mapped("name"),
        }

    def get_project_status(self, link, project_ref=None, session=None):
        user = link.user_id
        project = self._resolve_project_from_context(link, project_ref=project_ref, session=session)
        if not project:
            return {"error": "Project not found"}

        task_groups = self._task_model(user).read_group(
            [("project_id", "=", project.id)],
            ["id:count"],
            ["status"],
            lazy=False,
        )
        task_counts = {row["status"]: row.get("id_count", 0) for row in task_groups}
        overdue_count = self._task_model(user).search_count(
            [("project_id", "=", project.id), ("deadline", "<", self._today()), ("status", "!=", "done")]
        )
        approved_hours = self._backlog_model(user).read_group(
            [("project_id", "=", project.id), ("status", "=", "approved")],
            ["hours:sum"],
            [],
            lazy=False,
        )
        approved_hours_total = approved_hours[0].get("hours", 0.0) if approved_hours else 0.0

        return {
            "intent": "project_status",
            "project": self._serialize_projects(project)[0],
            "task_counts": {
                "todo": task_counts.get("todo", 0),
                "in_progress": task_counts.get("in_progress", 0),
                "review": task_counts.get("review", 0),
                "done": task_counts.get("done", 0),
            },
            "overdue_count": overdue_count,
            "approved_hours_total": approved_hours_total,
        }

    def get_project_budget(self, link, project_ref=None, session=None):
        project = self._resolve_project_from_context(link, project_ref=project_ref, session=session)
        if not project:
            return {"error": "Project not found"}

        approved_hours = self._backlog_model(link.user_id).read_group(
            [("project_id", "=", project.id), ("status", "=", "approved")],
            ["hours:sum"],
            [],
            lazy=False,
        )
        budget = float(project.budget or 0.0)
        total_cost = float(project.total_cost or 0.0)
        burn_pct = round((total_cost / budget) * 100, 2) if budget else 0.0

        return {
            "intent": "project_budget",
            "project": self._serialize_projects(project)[0],
            "approved_hours_total": approved_hours[0].get("hours", 0.0) if approved_hours else 0.0,
            "budget_burn_pct": burn_pct,
        }

    def get_project_blockers(self, link, project_ref=None, session=None, limit=10):
        project = self._resolve_project_from_context(link, project_ref=project_ref, session=session)
        if not project:
            return {"error": "Project not found"}

        tasks = self._task_model(link.user_id).search(
            [("project_id", "=", project.id), "|", ("issues", "!=", False), ("issues", "!=", "")],
            order="priority desc, deadline asc, id desc",
            limit=limit,
        )
        blockers = [
            {
                "task_name": task.name,
                "priority": task.priority,
                "deadline": str(task.deadline) if task.deadline else None,
                "issue": task.issues,
            }
            for task in tasks
        ]

        return {
            "intent": "project_blockers",
            "project": self._serialize_projects(project)[0],
            "blockers": blockers,
        }

    def get_projects_at_risk(self, link, limit=5):
        today = self._today()
        projects = self._project_model(link.user_id).search(
            [
                "|",
                ("status", "=", "on_hold"),
                "&",
                ("end_date", "!=", False),
                ("end_date", "<", today),
            ],
            order="priority desc, end_date asc, id desc",
            limit=limit,
        )
        return {
            "intent": "projects_at_risk",
            "title": "Project dang co rui ro",
            "metrics": {
                "project_count": len(projects),
            },
            "projects": self._serialize_projects(projects),
        }

    def get_portfolio_summary(self, link, limit=5):
        today = self._today()
        Project = self._project_model(link.user_id)
        project_count = Project.search_count([])
        in_progress_count = Project.search_count([("status", "=", "in_progress")])
        on_hold_count = Project.search_count([("status", "=", "on_hold")])
        completed_count = Project.search_count([("status", "=", "completed")])
        overdue_project_count = Project.search_count([("end_date", "!=", False), ("end_date", "<", today), ("status", "!=", "completed")])
        projects = Project.search([], order="priority desc, status, end_date asc, id desc", limit=limit)

        return {
            "intent": "portfolio_summary",
            "title": "Tong quan danh muc du an",
            "metrics": {
                "project_count": project_count,
                "in_progress_count": in_progress_count,
                "on_hold_count": on_hold_count,
                "completed_count": completed_count,
                "overdue_project_count": overdue_project_count,
            },
            "projects": self._serialize_projects(projects),
        }

    def _rewrite_reply_with_llm(self, parsed, payload, fallback_text):
        if not self._llm_enabled():
            return fallback_text

        base_url = self._get_param("bb_pm.llm.base_url")
        model = self._get_param("bb_pm.llm.model")
        api_key = self._get_param("bb_pm.llm.api_key")
        temperature = float(self._get_param("bb_pm.llm.temperature", 0.0) or 0.0)
        timeout = int(self._get_param("bb_pm.llm.timeout", 30) or 30)

        if not base_url or not model:
            return fallback_text

        return rewrite_reply(
            base_url=base_url,
            model=model,
            api_key=api_key,
            temperature=temperature,
            timeout=timeout,
            parsed=parsed,
            payload=payload,
            fallback_text=fallback_text,
        )

    def _llm_classify(self, link, text, session, rule_parsed=None):
        if not self._llm_enabled():
            return None

        base_url = self._get_param("bb_pm.llm.base_url")
        model = self._get_param("bb_pm.llm.model")
        api_key = self._get_param("bb_pm.llm.api_key")
        temperature = float(self._get_param("bb_pm.llm.temperature", 0.0) or 0.0)
        timeout = int(self._get_param("bb_pm.llm.timeout", 30) or 30)

        if not base_url or not model:
            return None

        return classify_intent(
            base_url=base_url,
            model=model,
            api_key=api_key,
            temperature=temperature,
            timeout=timeout,
            text=text,
            session_context=self._session_context(session),
            rule_based_guess=rule_parsed,
            project_candidates=self._llm_project_candidates(link),
        )

    def _should_try_llm(self, rule_parsed):
        if not self._llm_enabled():
            return False
        if (rule_parsed or {}).get("explicit_command"):
            return False
        return (rule_parsed or {}).get("match_strength") != "high"

    def _is_structured_project_ref(self, value):
        return bool(value and self._STRUCTURED_PROJECT_REF_PATTERN.fullmatch(str(value).strip()))

    def _merge_intent_predictions(self, rule_parsed, llm_parsed):
        if not isinstance(llm_parsed, dict) or not llm_parsed.get("intent"):
            return rule_parsed

        merged = dict(rule_parsed or {})
        rule_intent = merged.get("intent")
        rule_strength = merged.get("match_strength", "low")
        llm_intent = llm_parsed.get("intent")
        llm_confidence = llm_parsed.get("confidence", "medium")
        llm_project_ref = llm_parsed.get("project_ref")
        llm_period = llm_parsed.get("period")
        llm_summary_time = llm_parsed.get("summary_time")
        generic_rule = rule_intent in {"help", "project_status", "all_tasks"}
        can_enrich_project = bool(llm_project_ref) and not merged.get("project_ref")
        can_upgrade_project_ref = (
            bool(llm_project_ref)
            and bool(merged.get("project_ref"))
            and llm_project_ref != merged.get("project_ref")
            and not self._is_structured_project_ref(merged.get("project_ref"))
            and self._is_structured_project_ref(llm_project_ref)
        )
        can_enrich_period = bool(llm_period) and merged.get("period") in {None, "current"}
        can_enrich_summary_time = bool(llm_summary_time) and not merged.get("summary_time")

        if rule_strength == "low":
            merged.update(llm_parsed)
            merged["classification_source"] = "llm"
            return merged

        if llm_intent == rule_intent:
            if can_enrich_project:
                merged["project_ref"] = llm_project_ref
            if can_upgrade_project_ref:
                merged["project_ref"] = llm_project_ref
            if can_enrich_period:
                merged["period"] = llm_period
            if can_enrich_summary_time:
                merged["summary_time"] = llm_summary_time
            if can_enrich_project or can_upgrade_project_ref or can_enrich_period or can_enrich_summary_time:
                merged["classification_source"] = "hybrid"
            return merged

        if generic_rule and llm_intent != "help" and llm_confidence in {"high", "medium"}:
            merged.update(llm_parsed)
            merged["classification_source"] = "llm"
            return merged

        if rule_strength == "medium" and llm_confidence == "high" and llm_intent != "help":
            merged.update(llm_parsed)
            merged["classification_source"] = "llm"
            return merged

        if can_enrich_project:
            merged["project_ref"] = llm_project_ref
        if can_upgrade_project_ref:
            merged["project_ref"] = llm_project_ref
        if can_enrich_period:
            merged["period"] = llm_period
        if can_enrich_summary_time:
            merged["summary_time"] = llm_summary_time
        if can_enrich_project or can_upgrade_project_ref or can_enrich_period or can_enrich_summary_time:
            merged["classification_source"] = "hybrid"
        return merged

    def _finalize_response(self, link, parsed, payload, fallback_text, save_context=True):
        reply_text = self._rewrite_reply_with_llm(parsed, payload, fallback_text)
        if save_context and payload:
            self.save_session(link, parsed, payload)
        return {
            "parsed": parsed,
            "payload": payload,
            "reply_text": reply_text,
        }

    def route_intent(self, link, parsed, session):
        intent = parsed.get("intent")

        if intent == "clear_context":
            self.clear_session(link)
            return {
                "parsed": parsed,
                "payload": {},
                "reply_text": "Da xoa bo nho hoi thoai gan nhat.",
            }

        if intent == "summary_on":
            summary_time = extract_summary_time(parsed.get("summary_time") or link.summary_time or "08:00") or "08:00"
            link.sudo().write(
                {
                    "summary_enabled": True,
                    "summary_time": summary_time,
                    "next_summary_at": self._compute_next_summary_at(link, summary_time=summary_time),
                }
            )
            timezone_name = link.timezone or "Asia/Ho_Chi_Minh"
            return {
                "parsed": parsed,
                "payload": {},
                "reply_text": f"Da bat Telegram summary hang ngay luc {summary_time} ({timezone_name}).",
            }

        if intent == "summary_off":
            link.sudo().write({"summary_enabled": False, "next_summary_at": False})
            return {
                "parsed": parsed,
                "payload": {},
                "reply_text": "Da tat Telegram summary hang ngay cho tai khoan nay.",
            }

        if intent == "today_summary":
            payload = self.get_today_summary(link)
            return self._finalize_response(link, parsed, payload, render_today_summary(payload))

        if intent == "all_tasks":
            payload = self.get_all_tasks(link)
            return self._finalize_response(link, parsed, payload, render_task_list(payload))

        if intent == "my_tasks":
            payload = self.get_my_tasks(link)
            return self._finalize_response(link, parsed, payload, render_task_list(payload))

        if intent == "overdue_tasks":
            payload = self.get_overdue_tasks(link)
            return self._finalize_response(link, parsed, payload, render_task_list(payload))

        if intent == "project_tasks":
            payload = self.get_project_tasks(link, project_ref=parsed.get("project_ref"), session=session)
            if payload.get("error"):
                return {
                    "parsed": parsed,
                    "payload": payload,
                    "reply_text": "Khong tim thay project ban dang hoi.",
                }
            return self._finalize_response(link, parsed, payload, render_task_list(payload))

        if intent == "project_budget":
            payload = self.get_project_budget(link, project_ref=parsed.get("project_ref"), session=session)
            if payload.get("error"):
                return {
                    "parsed": parsed,
                    "payload": payload,
                    "reply_text": "Khong tim thay project de xem budget.",
                }
            return self._finalize_response(link, parsed, payload, render_project_budget(payload))

        if intent == "project_blockers":
            payload = self.get_project_blockers(link, project_ref=parsed.get("project_ref"), session=session)
            if payload.get("error"):
                return {
                    "parsed": parsed,
                    "payload": payload,
                    "reply_text": "Khong tim thay project de kiem tra blocker.",
                }
            return self._finalize_response(link, parsed, payload, render_project_blockers(payload))

        if intent == "projects_at_risk":
            payload = self.get_projects_at_risk(link)
            return self._finalize_response(link, parsed, payload, render_portfolio_summary(payload))

        if intent == "portfolio_summary":
            payload = self.get_portfolio_summary(link)
            return self._finalize_response(link, parsed, payload, render_portfolio_summary(payload))

        if intent == "project_status" and parsed.get("project_ref"):
            payload = self.get_project_status(link, project_ref=parsed.get("project_ref"), session=session)
            if payload.get("error"):
                return {
                    "parsed": parsed,
                    "payload": payload,
                    "reply_text": "Khong tim thay project ban dang hoi.",
                }
            return self._finalize_response(link, parsed, payload, render_project_status(payload))

        if intent == "project_status":
            project = self._resolve_project_from_context(link, session=session)
            if project:
                payload = self.get_project_status(link, session=session)
                return self._finalize_response(link, parsed, payload, render_project_status(payload))
            return {
                "parsed": parsed,
                "payload": {},
                "reply_text": "Ban hay gui ma hoac ten project, vi du: cho toi xem tinh hinh project MCK-LPS",
            }

        return {
            "parsed": parsed,
            "payload": {},
            "reply_text": render_help(),
        }

    def handle_text(self, link, text):
        rule_parsed = parse_message(text)
        if rule_parsed.get("explicit_command"):
            return self.route_intent(link, rule_parsed, session=self.load_session(link))

        if self._llm_enabled():
            try:
                return self._handle_text_agent(link, text, rule_parsed)
            except Exception:
                _logger.exception("Agent loop failed, falling back to rule-based Telegram flow")

        session = self.load_session(link)
        parsed = rule_parsed
        if self._should_try_llm(rule_parsed):
            llm_parsed = self._llm_classify(link, text, session, rule_parsed=rule_parsed)
            parsed = self._merge_intent_predictions(rule_parsed, llm_parsed)
        return self.route_intent(link, parsed, session)

    def _find_link_by_telegram(self, telegram_user_id, chat_id):
        return self.env["bb.project.telegram.link"].sudo().search(
            [
                "|",
                ("telegram_user_id", "=", str(telegram_user_id)),
                ("telegram_chat_id", "=", str(chat_id)),
            ],
            limit=1,
        )

    def _split_message(self, text):
        text = text or ""
        if len(text) <= self._TELEGRAM_MAX_MESSAGE_LENGTH:
            return [text]

        chunks = []
        current = []
        current_len = 0
        for line in text.splitlines() or [text]:
            line = line or " "
            extra = len(line) + (1 if current else 0)
            if current and current_len + extra > self._TELEGRAM_MAX_MESSAGE_LENGTH:
                chunks.append("\n".join(current))
                current = [line]
                current_len = len(line)
            else:
                current.append(line)
                current_len += extra

        if current:
            chunks.append("\n".join(current))
        return chunks

    def _send_telegram_message(self, chat_id, text):
        token = self._get_param("bb_pm.telegram.bot_token")
        if not token:
            raise RuntimeError("Telegram bot token is missing")

        url = f"https://api.telegram.org/bot{token}/sendMessage"
        for chunk in self._split_message(text):
            response = requests.post(url, json={"chat_id": chat_id, "text": chunk}, timeout=15)
            response.raise_for_status()
            data = response.json()
            if not data.get("ok"):
                raise RuntimeError(data.get("description") or "Telegram API returned an error")

    def _log_message(self, vals):
        try:
            return self._log_model().create(vals)
        except Exception:
            _logger.exception("Failed to create Telegram message log")
            return False

    def _is_duplicate_update(self, update_id):
        if not update_id:
            return False
        return bool(
            self._log_model().search_count(
                [("telegram_update_id", "=", str(update_id)), ("direction", "=", "in")]
            )
        )

    def handle_update(self, update):
        update_id = update.get("update_id")
        if self._is_duplicate_update(update_id):
            return

        message = update.get("message") or {}
        text = message.get("text")
        chat = message.get("chat") or {}
        from_user = message.get("from") or {}

        if not text:
            return

        telegram_user_id = from_user.get("id")
        chat_id = chat.get("id")
        username = from_user.get("username")

        link = self._find_link_by_telegram(telegram_user_id, chat_id)
        if not link:
            try:
                self._send_telegram_message(chat_id, "Tai khoan Telegram nay chua duoc lien ket voi Odoo.")
            except Exception:
                _logger.exception("Failed to send unlinked-account Telegram reply")
            return

        link.sudo().write(
            {
                "telegram_username": username or link.telegram_username,
                "last_seen_at": self._now(),
            }
        )

        self._log_message(
            {
                "link_id": link.id,
                "telegram_update_id": str(update_id),
                "direction": "in",
                "raw_text": text,
                "state": "done",
            }
        )

        try:
            result = self.handle_text(link, text)
            parsed = result.get("parsed") or {}
            payload = result.get("payload") or {}

            self._send_telegram_message(chat_id, result["reply_text"])
            try:
                if parsed.get("classification_source") == "agent":
                    session = self.load_session(link)
                    if session:
                        self._maybe_update_long_term_memory(link, session)
            except Exception:
                _logger.exception("Long-term memory update failed")
            self._log_message(
                {
                    "link_id": link.id,
                    "direction": "out",
                    "response_text": result["reply_text"],
                    "parsed_intent": parsed.get("intent"),
                    "parsed_params_json": json.dumps(parsed, ensure_ascii=False),
                    "resolved_project_id": self._extract_context_project_id(payload) or False,
                    "used_llm": parsed.get("classification_source") in {"llm", "hybrid", "agent"},
                    "state": "done",
                }
            )
        except Exception as exc:
            _logger.exception("Telegram update handling failed")
            error_text = "He thong dang ban, vui long thu lai sau."
            self._log_message(
                {
                    "link_id": link.id,
                    "direction": "out",
                    "response_text": error_text,
                    "state": "error",
                    "error_message": str(exc),
                }
            )
            try:
                self._send_telegram_message(chat_id, error_text)
            except Exception:
                _logger.exception("Failed to send Telegram error reply")

    def _compute_next_summary_at(self, link, from_dt=None, summary_time=None):
        tz_name = link.timezone or "Asia/Ho_Chi_Minh"
        try:
            tzinfo = ZoneInfo(tz_name)
        except Exception:
            tzinfo = ZoneInfo("UTC")

        from_dt = from_dt or datetime.now(timezone.utc)
        if from_dt.tzinfo is None:
            from_dt = from_dt.replace(tzinfo=timezone.utc)

        try:
            hour_str, minute_str = (summary_time or link.summary_time or "08:00").split(":")
            hour = int(hour_str)
            minute = int(minute_str)
        except Exception:
            hour, minute = 8, 0

        local_now = from_dt.astimezone(tzinfo)
        candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= local_now:
            candidate += timedelta(days=1)
        return candidate.astimezone(timezone.utc).replace(tzinfo=None)

    def cron_send_daily_summary(self):
        now_utc = self._now()
        links = self.env["bb.project.telegram.link"].sudo().search(
            [
                ("state", "=", "linked"),
                ("summary_enabled", "=", True),
                "|",
                ("next_summary_at", "=", False),
                ("next_summary_at", "<=", now_utc),
            ]
        )

        for link in links:
            try:
                if not link.next_summary_at:
                    link.sudo().write({"next_summary_at": self._compute_next_summary_at(link, from_dt=datetime.now(timezone.utc))})
                    continue

                parsed = {"intent": "today_summary", "period": "today", "normalized_text": "daily summary"}
                payload = self.get_today_summary(link)
                reply_text = self._rewrite_reply_with_llm(parsed, payload, render_today_summary(payload))
                self._send_telegram_message(link.telegram_chat_id, reply_text)
                self._log_message(
                    {
                        "link_id": link.id,
                        "direction": "out",
                        "response_text": reply_text,
                        "parsed_intent": "today_summary",
                        "state": "done",
                    }
                )
                link.sudo().write(
                    {
                        "last_seen_at": now_utc,
                        "next_summary_at": self._compute_next_summary_at(link, from_dt=datetime.now(timezone.utc)),
                    }
                )
            except Exception as exc:
                _logger.exception("Failed to send scheduled Telegram summary")
                self._log_message(
                    {
                        "link_id": link.id,
                        "direction": "out",
                        "parsed_intent": "today_summary",
                        "state": "error",
                        "error_message": str(exc),
                    }
                )
