"""LLM-first intent classifier.

Mỗi turn free-text (không phải slash, không trong state machine) gọi Haiku 1
lần với prompt compact để phân loại intent + trích entities.

Output: IntentResult (Pydantic). Dispatcher đọc.

Cost ~$0.00025/turn. Validation 2 lớp: pydantic schema + retry 1 lượt khi sai.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from core.logging import log_event
from infrastructure.llm_client import LlmClient
from routing.intent_models import IntentEntities, IntentResult
from shared.types import TurnRequest


_SYSTEM_PROMPT = """Bạn là intent classifier cho PM bot tiếng Việt.
Phân loại câu user thành 1 trong 7 intent + trích entities. Trả JSON THUẦN
(không markdown).

INTENT:
- read: tra cứu dữ liệu (task/project/worklog/member/blocker/risk/report)
- action: đổi 1 task (deadline/status/assignee) hoặc tạo task lẻ
- checkin: ý định mở flow nhập worklog hôm nay (chưa nêu nội dung cụ thể)
- planning: ý định mở flow lập kế hoạch dự án MỚI
- help: hỏi cách dùng bot, có những gì
- smalltalk: chào hỏi, cảm ơn, tạm biệt, "bạn là ai", giao tiếp ngắn
- unknown: ngoài scope PM (không liên quan task/project/worklog)

ENTITIES (trích nếu có, để null nếu không):
- project_name (string), project_id (int), task_id (int)
- user_name: "CALLER" nếu user dùng "tôi/của mình", còn lại tên thật
- date_range: "today" | "yesterday" | "this_week" | "last_week" | "this_month"
- status: OVERDUE | DONE | IN_PROGRESS | REVIEW | TODO | STALE
- topic: task | project | worklog | member | blocker | risk | milestone | scope | estimate
- metric: count | list | summary | trend | list_with_filter
- extras: dict (vd new_deadline, new_status, new_assignee, action_type)

needs_context: true nếu câu có đại từ tham chiếu turn trước
  ("đó", "này", "vừa rồi", "cái đó", "anh ấy"…).
confidence: 0..1. confidence < 0.55 → caller sẽ hỏi clarification.

FEW-SHOT:
"task của tôi quá hạn" → {"intent":"read","entities":{"topic":"task","status":"OVERDUE","user_name":"CALLER"},"needs_context":false,"confidence":0.95,"reasoning":"hỏi task của caller quá hạn"}
"tạo task viết SRS cho dự án MTL" → {"intent":"action","entities":{"project_name":"MTL","topic":"task","extras":{"action_type":"create_task","name":"viết SRS"}},"needs_context":false,"confidence":0.92,"reasoning":"tạo task mới"}
"đổi deadline task #42 sang 2026-06-01" → {"intent":"action","entities":{"task_id":42,"extras":{"action_type":"patch_deadline","new_deadline":"2026-06-01"}},"needs_context":false,"confidence":0.97,"reasoning":"đổi deadline task cụ thể"}
"đánh dấu task #51 sang xong" → {"intent":"action","entities":{"task_id":51,"status":"DONE","extras":{"action_type":"transition","new_status":"DONE"}},"needs_context":false,"confidence":0.95,"reasoning":"đổi status task"}
"hôm nay đã làm gì chưa update" → {"intent":"checkin","entities":{},"needs_context":false,"confidence":0.7,"reasoning":"có thể là gợi ý mở checkin"}
"lập kế hoạch dự án Mobile v3" → {"intent":"planning","entities":{"project_name":"Mobile v3"},"needs_context":false,"confidence":0.95,"reasoning":"start planning flow"}
"hi" → {"intent":"smalltalk","entities":{},"needs_context":false,"confidence":0.99,"reasoning":"chào hỏi"}
"agent làm được gì" → {"intent":"help","entities":{},"needs_context":false,"confidence":0.9,"reasoning":"hỏi capability"}
"kể chuyện cười" → {"intent":"unknown","entities":{},"needs_context":false,"confidence":0.95,"reasoning":"ngoài scope PM"}
"tổng hợp những worklog đó" → {"intent":"read","entities":{"topic":"worklog","metric":"summary"},"needs_context":true,"confidence":0.85,"reasoning":"summarize worklog từ context trước"}
"dự án nào có worklog" → {"intent":"read","entities":{"topic":"project","metric":"list_with_filter"},"needs_context":false,"confidence":0.9,"reasoning":"list project có worklog"}
"có bao nhiêu worklog" → {"intent":"read","entities":{"topic":"worklog","metric":"count"},"needs_context":false,"confidence":0.9,"reasoning":"count worklog global"}
"ai làm dự án MTL" → {"intent":"read","entities":{"topic":"member","project_name":"MTL","metric":"list"},"needs_context":false,"confidence":0.95,"reasoning":"list member of project"}
"xem tiến độ dự án Mobile" → {"intent":"read","entities":{"topic":"project","project_name":"Mobile","metric":"summary"},"needs_context":false,"confidence":0.93,"reasoning":"project status"}
"task lâu chưa update" → {"intent":"read","entities":{"topic":"task","status":"STALE"},"needs_context":false,"confidence":0.92,"reasoning":"stale task"}
"""

_USER_TEMPLATE = """{context_block}Câu hỏi: "{text}"đổi

Trả JSON theo schema (intent, entities, needs_context, confidence, reasoning)."""


class LlmIntentRouter:
    def __init__(self, llm: LlmClient) -> None:
        self._llm = llm

    async def classify(
        self, text: str, ctx: TurnRequest, *, memory: Optional[dict] = None
    ) -> IntentResult:
        ctx_block = _format_context_block(memory) if memory else ""
        user_msg = _USER_TEMPLATE.format(context_block=ctx_block, text=text.strip())

        # Lần 1
        raw = await self._call(user_msg)
        parsed, err = self._try_parse(raw)
        if parsed is not None:
            log_event("routing.intent_classified",
                      intent=parsed.intent, confidence=parsed.confidence,
                      needs_context=parsed.needs_context, reasoning=parsed.reasoning[:80])
            return parsed

        # Lần 2 (repair)
        log_event("routing.intent_repair", level="warning", error=err)
        repair_msg = (
            user_msg
            + f"\n\nLỖI: {err or 'JSON sai'}. Trả lại JSON HỢP LỆ duy nhất."
        )
        raw2 = await self._call(repair_msg)
        parsed, err = self._try_parse(raw2)
        if parsed is not None:
            log_event("routing.intent_repaired", intent=parsed.intent)
            return parsed

        # Fail → unknown an toàn
        log_event("routing.intent_failed", level="warning", error=err)
        return IntentResult(
            intent="unknown", confidence=0.0,
            reasoning=f"classifier_failed: {err or 'parse error'}",
        )

    async def _call(self, user_msg: str) -> str:
        try:
            res = await self._llm.chat(
                [{"role": "system", "content": _SYSTEM_PROMPT},
                 {"role": "user", "content": user_msg}],
                temperature=0.0,
                max_tokens=300,
                response_format={"type": "json_object"},
            )
        except Exception as err:  # noqa: BLE001
            log_event("routing.intent_llm_error", level="warning", error=str(err))
            return ""
        return (res.content or "").strip()

    @staticmethod
    def _try_parse(raw: str) -> tuple[Optional[IntentResult], Optional[str]]:
        if not raw:
            return None, "empty_response"
        # Trích JSON đầu tiên (đề phòng LLM kèm text)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
            if not m:
                return None, "no_json_found"
            try:
                payload = json.loads(m.group(0))
            except json.JSONDecodeError as err:
                return None, f"json_decode: {err.msg}"

        if not isinstance(payload, dict):
            return None, "not_object"

        # Coerce entities thành IntentEntities object nếu cần
        entities_raw = payload.get("entities") or {}
        if not isinstance(entities_raw, dict):
            entities_raw = {}
        try:
            entities = IntentEntities.model_validate(entities_raw)
        except Exception:  # noqa: BLE001
            entities = IntentEntities()

        payload["entities"] = entities
        try:
            return IntentResult.model_validate(payload), None
        except Exception as err:  # noqa: BLE001 — pydantic ValidationError
            return None, f"validation: {err}"


def _format_context_block(memory: dict) -> str:
    """Render conversation context (từ ConversationContext) thành block tóm tắt."""
    lines: list[str] = ["CONTEXT (turn gần nhất):"]
    if memory.get("last_intent"):
        lines.append(f"- last_intent: {memory['last_intent']}")
    if memory.get("last_text"):
        lines.append(f'- last_text: "{memory["last_text"]}"')
    if memory.get("last_project_name") or memory.get("last_project_id"):
        pid = memory.get("last_project_id")
        pname = memory.get("last_project_name") or "?"
        lines.append(f"- last_project: {pname}" + (f" (id={pid})" if pid else ""))
    if memory.get("last_task_id"):
        lines.append(f"- last_task_id: {memory['last_task_id']}")
    if memory.get("last_row_count") is not None:
        lines.append(f"- last_row_count: {memory['last_row_count']}")
    last_entities = memory.get("last_entities") or {}
    if isinstance(last_entities, dict) and last_entities:
        lines.append(f"- last_entities: {json.dumps(last_entities, ensure_ascii=False)}")
    if len(lines) == 1:
        return ""
    return "\n".join(lines) + "\n\n"
