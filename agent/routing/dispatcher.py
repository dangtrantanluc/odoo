"""Dispatcher — biến IntentResult thành reply.

Đầu vào: IntentResult từ LlmIntentRouter + TurnRequest + ConversationContext.
Đầu ra: (reply_text, channel_reply, pattern).

Mỗi intent có handler riêng. Riêng `read`:
  - Nếu entities đủ rõ (vd topic=task + status=OVERDUE + caller) → gọi thẳng
    catalog tool (rẻ hơn, không LLM call thêm).
  - Còn lại → NL→SQL translator, nhồi entities + context vào prompt.
"""

from __future__ import annotations

from typing import Any, Optional

from checkin.service import CheckinService
from core.logging import log_event
from infrastructure.bbpm_client import BbPmApiError, BbPmClient
from planning.service import PlanningAgent
from reporting.nl_to_sql.translator import NlToSqlTranslator
from routing.action_router import ActionRouter
from routing.intent_models import CALLER, IntentResult
from shared.text import normalize
from shared.types import ReplyBody, ReplyOption, TurnRequest
from tools.catalog import ToolCatalog


_HELP_SHORT = (
    "Mình hỗ trợ:\n"
    "• /checkin — nhập worklog hôm nay\n"
    "• /mytasks /overdue /stale — xem task\n"
    "• /risk <project> — rủi ro 1 dự án\n"
    "• /plan — lập kế hoạch dự án (Manager)\n"
    "• Hỏi tự do: \"task của tôi quá hạn\", \"ai làm dự án X\"…"
)

_SMALLTALK_REPLIES = {
    "greeting": "Chào bạn 👋. Cần mình giúp gì? Gõ /help nếu cần danh sách lệnh.",
    "thanks":   "Không có gì, có gì cần cứ nhắn nha.",
    "goodbye":  "Hẹn gặp lại bạn 👋",
    "whoami":   ("Mình là PM Agent — trợ lý quản lý dự án. Hỗ trợ checkin, "
                 "lập kế hoạch, tra cứu task/worklog/blocker, cảnh báo risk."),
    "howru":    "Mình ổn. Hôm nay bạn cần track việc gì?",
    "default":  "Có gì mình giúp được không?",
}


class Dispatcher:
    def __init__(
        self,
        *,
        catalog: ToolCatalog,
        translator: NlToSqlTranslator,
        action: ActionRouter,
        checkin: CheckinService,
        planning: PlanningAgent,
        bbpm: BbPmClient,
    ) -> None:
        self._catalog = catalog
        self._translator = translator
        self._action = action
        self._checkin = checkin
        self._planning = planning
        self._bbpm = bbpm

    async def dispatch(
        self,
        result: IntentResult,
        text: str,
        request: TurnRequest,
        company_id: Optional[int],
        memory: Optional[dict[str, Any]] = None,
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        """Trả về (reply, channel_reply, mode, sql_used, row_count).

        sql_used + row_count để caller update ConversationMemory.
        """
        # Threshold cao hơn cho intent destructive (action/planning) — tránh
        # tự khởi flow tạo task / project khi LLM đoán mơ hồ.
        threshold = 0.75 if result.intent in {"action", "planning"} else 0.55
        if result.confidence < threshold:
            return (
                self._clarification(result),
                None, "clarify", f"intent:lowconf:{result.intent}",
                None, None,
            )

        intent = result.intent
        if intent == "checkin":
            return await self._handle_checkin(text, request)
        if intent == "planning":
            return await self._handle_planning(text, request)
        if intent == "action":
            return await self._handle_action(result, text, request)
        if intent == "smalltalk":
            return self._handle_smalltalk(result)
        if intent == "help":
            return self._handle_help(result)
        if intent == "unknown":
            return self._handle_unknown(result)
        # default: read
        return await self._handle_read(result, text, request, company_id, memory)

    # ── READ ────────────────────────────────────────────────────────────
    async def _handle_read(
        self, result: IntentResult, text: str, request: TurnRequest,
        company_id: Optional[int], memory: Optional[dict[str, Any]],
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        e = result.entities
        topic, metric, status = e.topic, e.metric, (e.status or "").upper()
        caller_id = request.caller_user_id

        # Fast-path 1: "task của tôi" (mở)
        if (topic == "task" and e.is_caller_self()
                and not e.project_name and status not in {"OVERDUE", "STALE", "DONE"}
                and caller_id):
            reply = await self._catalog.my_tasks_today(caller_id)
            return (reply, None, "read", "tool:my_tasks_today", None)

        # Fast-path 2: overdue
        if topic == "task" and status == "OVERDUE":
            proj_id = await self._resolve_project_id(e.project_name)
            reply = await self._catalog.overdue_tasks(project_id=proj_id)
            return (reply, None, "read", "tool:overdue_tasks", None)

        # Fast-path 3: stale
        if topic == "task" and status == "STALE":
            reply = await self._catalog.stale_tasks()
            return (reply, None, "read", "tool:stale_tasks", None)

        # Fast-path 4: list projects (generic, no filter)
        if topic == "project" and metric in {"list", None} and not e.project_name:
            reply = await self._catalog.list_projects()
            return (reply, None, "read", "tool:list_projects", None)

        # Fast-path 5: project snapshot
        if (topic == "project" and metric == "summary" and e.project_name):
            reply = await self._catalog.project_snapshot(e.project_name)
            return (reply, None, "read", "tool:project_snapshot", None)

        # Fast-path 6: digest
        if topic == "task" and metric == "summary" and not e.project_name:
            reply = await self._catalog.daily_digest()
            return (reply, None, "read", "tool:daily_digest", None)

        # Fast-path 7: risk
        if topic == "risk" and e.project_name:
            reply = await self._catalog.risk_snapshot(e.project_name)
            return (reply, None, "read", "tool:risk", None)

        # Fallback: NL→SQL với entities + context
        if company_id is None:
            return ("Mình chưa xác định được công ty của bạn để tra cứu, "
                    "nhờ admin map account giúp.",
                    None, "read", "read:no_company", None)
        ctx_dict = memory if result.needs_context else None
        ent_dict = self._entities_for_translator(e, caller_id)
        reply, sql, row_count = await self._translator.run(
            text, company_id, caller_id,
            context=ctx_dict, entities=ent_dict,
        )
        return (reply, None, "read", "read:text_to_sql", row_count)

    @staticmethod
    def _entities_for_translator(e, caller_id: Optional[int]) -> dict[str, Any]:
        d = e.model_dump(exclude_none=True, exclude_defaults=False)
        # Resolve CALLER → user_id để translator tránh chế bậy.
        if d.get("user_name") == CALLER and caller_id:
            d["user_id"] = caller_id
        return d

    async def _resolve_project_id(self, name: Optional[str]) -> Optional[int]:
        if not name:
            return None
        try:
            projects = await self._bbpm.list_projects(q=name)
        except BbPmApiError:
            return None
        if not projects:
            return None
        q = normalize(name)
        match = next(
            (p for p in projects if normalize(p.get("name", "")) == q),
            projects[0],
        )
        return int(match["id"])

    # ── ACTION ──────────────────────────────────────────────────────────
    async def _handle_action(
        self, result: IntentResult, _text: str, request: TurnRequest,
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        e = result.entities
        extras = e.extras or {}
        action_type = extras.get("action_type")

        # Map intent.action → payload tương thích với ActionRouter._execute
        payload: Optional[dict[str, Any]] = None
        if action_type == "patch_deadline" or extras.get("new_deadline"):
            if e.task_id and extras.get("new_deadline"):
                payload = {"type": "deadline", "task_id": e.task_id,
                           "deadline": extras["new_deadline"]}
        elif action_type == "transition" or extras.get("new_status"):
            new_status = extras.get("new_status") or e.status
            if e.task_id and new_status:
                payload = {"type": "status", "task_id": e.task_id,
                           "status": new_status.upper()}
        elif action_type == "create_task" or extras.get("name"):
            name = extras.get("name") or extras.get("task_name")
            project = e.project_name
            if name and project:
                payload = {"type": "create_task", "name": name, "project": project}

        if payload is None:
            return (
                "Mình chưa rõ thao tác bạn muốn làm. Bạn nói cụ thể hơn nhé: "
                "task nào, đổi gì sang giá trị nào?",
                None, "action", "action:incomplete", None,
            )
        preview = await self._action.preview_and_pend(payload, request)
        if preview is None:
            return (
                "Mình chưa lưu được lệnh, bạn thử lại sau giây lát.",
                None, "action", "action:no_conv", None,
            )
        return (preview[0], None, "action", preview[1], None)

    # ── CHECKIN ─────────────────────────────────────────────────────────
    async def _handle_checkin(
        self, text: str, request: TurnRequest,
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        # Đẩy text như slash /checkin để CheckinService nhận diện start.
        result = await self._checkin.handle_turn("/checkin", request)
        if result is None:
            log_event("dispatcher.checkin_start_failed",
                      level="warning", text=text[:80])
            return ("Mình chưa mở được flow checkin, bạn thử /checkin nhé.",
                    None, "checkin", "checkin:dispatcher_fail", None)
        return (result.reply, result.channel_reply, "checkin",
                result.pattern, None)

    # ── PLANNING ────────────────────────────────────────────────────────
    async def _handle_planning(
        self, _text: str, request: TurnRequest,
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        # Đẩy "/plan" — PlanningAgent.handle_turn sẽ kiểm RBAC + start.
        reply, channel_reply, pattern = await self._planning.handle_turn(
            "/plan", request,
        )
        return (reply, channel_reply, "planning", pattern, None)

    # ── HELP / SMALLTALK / UNKNOWN ──────────────────────────────────────
    def _handle_help(
        self, result: IntentResult,
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        hint = ""
        topic = result.entities.topic
        if topic == "task":
            hint = "\n\nGợi ý: /mytasks, /overdue, hoặc \"task của tôi\""
        elif topic == "worklog":
            hint = "\n\nGợi ý: /checkin để nhập, \"có bao nhiêu worklog\""
        elif topic == "risk":
            hint = "\n\nGợi ý: /risk <tên project>"
        elif topic == "project":
            hint = "\n\nGợi ý: /projects, \"tiến độ dự án X\""
        return (_HELP_SHORT + hint, None, "help", "intent:help", None)

    def _handle_smalltalk(
        self, result: IntentResult,
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        # Phân nhóm thô từ reasoning của LLM
        reasoning = (result.reasoning or "").lower()
        if any(k in reasoning for k in ("chào", "greet", "hi", "hello", "hỏi thăm")):
            kind = "greeting"
        elif any(k in reasoning for k in ("cảm ơn", "thank", "tks", "thx")):
            kind = "thanks"
        elif any(k in reasoning for k in ("tạm biệt", "bye", "goodbye")):
            kind = "goodbye"
        elif any(k in reasoning for k in ("là ai", "giới thiệu", "capability", "whoami")):
            kind = "whoami"
        elif any(k in reasoning for k in ("ổn", "khỏe", "how", "thế nào")):
            kind = "howru"
        else:
            kind = "default"
        return (_SMALLTALK_REPLIES[kind], None, "smalltalk", f"intent:smalltalk:{kind}",
                None)

    def _handle_unknown(
        self, result: IntentResult,
    ) -> tuple[str, Optional[ReplyBody], str, Optional[str], Optional[int]]:
        reason = result.reasoning or "ngoài scope"
        return (
            f"Mình chưa hỗ trợ yêu cầu này ({reason}). Bạn thử /help, "
            "hoặc hỏi về task/worklog/dự án nhé.",
            None, "unknown", "intent:unknown", None,
        )

    def _clarification(self, result: IntentResult) -> str:
        return (
            "Mình chưa chắc ý bạn. Có thể bạn muốn:\n"
            "  • Xem dữ liệu (task/worklog/project)?\n"
            "  • Nhập worklog hôm nay (/checkin)?\n"
            "  • Đổi/tạo task cụ thể?\n"
            "Bạn nói rõ hơn giúp mình nhé."
        )
