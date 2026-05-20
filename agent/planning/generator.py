"""Sinh PlanDraft từ brief tự nhiên (LLM) và apply edit dạng câu.

Trả JSON mode `json_object` để LLM bị ép tạo JSON. Có 1 lượt repair nếu
validate fail — gửi lỗi lại cho LLM để chỉnh.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from core.logging import log_event
from infrastructure.bbpm_client import BbPmClient
from infrastructure.llm_client import LlmClient
from planning.models import PlanDraft


_EXPAND_PATTERNS = re.compile(
    r"chi\s*ti[êe]t\s*h[ơo]n"
    r"|c[ụu]\s*th[êe]\s*h[ơo]n"
    r"|chia\s*nh[ỏo]\s*h[ơo]n"
    r"|ph[âa]n\s*r[ãa]"
    r"|t[ăa]ch\s*nh[ỏo]"
    r"|th[êe]m\s*task|th[êe]m\s*chi\s*ti[êe]t"
    r"|expand|break\s*down",
    re.IGNORECASE,
)
_SHRINK_PATTERNS = re.compile(
    r"g[ọo]n\s*l[ạa]i|t[ốo]m\s*l[ạa]i|g[ộo]p|merge|simplify|r[úu]t\s*g[ọo]n",
    re.IGNORECASE,
)


_SCHEMA_SKETCH = (
    'PlanDraft schema (tất cả trường ngày là "YYYY-MM-DD"):\n'
    '{\n'
    '  "project_name": str,\n'
    '  "project_code": str | null,\n'
    '  "description": str | null,\n'
    '  "start_date": str | null,\n'
    '  "end_date": str | null,\n'
    '  "estimated_total_hours": number | null,\n'
    '  "epics": [{"key": "E1", "name": str, "description": str|null, "due_date": str|null}],\n'
    '  "tasks": [{\n'
    '    "key": "T1", "name": str, "description": str|null,\n'
    '    "estimate_hours": number, "epic_key": "E1",\n'
    '    "depends_on": ["T0", ...],\n'
    '    "assignee_id": number|null, "assignee_name": str|null,\n'
    '    "priority": "LOW"|"MEDIUM"|"HIGH"|"URGENT"|null,\n'
    '    "deadline": str|null\n'
    '  }]\n'
    '}\n'
)


class PlanGenerationError(RuntimeError):
    """Raised khi LLM trả JSON sai mà repair vẫn fail."""


class PlanGenerator:
    def __init__(self, llm: LlmClient, bbpm: BbPmClient) -> None:
        self._llm = llm
        self._bbpm = bbpm

    # ── public API ──────────────────────────────────────────────────────
    async def from_brief(self, brief: str, *, company_id: Optional[int] = None
                         ) -> PlanDraft:
        # company_id giữ làm hook tương lai (lọc roster theo company khi
        # users_workload hỗ trợ tham số đó). Ghi vào audit context để
        # truy vết.
        roster = await self._roster()
        sys = self._sys_prompt_generate(roster)
        user = f"Brief:\n{brief.strip()}"
        log_event("planning.generate.begin", company_id=company_id,
                  roster_size=len(roster))
        return await self._chat_until_valid(sys, user, op="generate")

    async def apply_edit(self, draft: PlanDraft, instruction: str) -> PlanDraft:
        roster = await self._roster()
        sys = self._sys_prompt_edit(roster)
        guidance = self._edit_guidance(instruction, draft)
        user = (
            "Draft hiện tại (JSON):\n"
            f"{draft.model_dump_json(exclude_none=True)}\n\n"
            f"Yêu cầu chỉnh sửa:\n{instruction.strip()}\n"
            f"{guidance}"
        )
        return await self._chat_until_valid(sys, user, op="edit")

    @staticmethod
    def _edit_guidance(instruction: str, draft: PlanDraft) -> str:
        """Bổ sung hướng dẫn cụ thể cho LLM khi instruction mơ hồ.

        Nếu user gõ "chi tiết hơn", LLM có xu hướng chỉ đổi câu chữ —
        không phân rã thật. Câu guidance dưới buộc LLM tăng số task,
        giảm estimate trung bình, giữ key cũ và đặt key mới tiếp nối.
        """
        n_tasks = len(draft.tasks)
        n_epics = len(draft.epics)
        max_task_key = max((_int_suffix(t.key) for t in draft.tasks), default=0)

        if _EXPAND_PATTERNS.search(instruction):
            return (
                "\nHướng dẫn thêm (phân rã chi tiết hơn):\n"
                f"- Hiện có {n_epics} epic và {n_tasks} task. "
                "Phân rã mỗi task lớn (estimate_hours ≥ 16) thành 2-4 task con "
                "estimate_hours = 4-12h mỗi task.\n"
                f"- Đặt key task mới bắt đầu từ T{max_task_key + 1}.\n"
                "- GIỮ NGUYÊN key của epic và task cũ nếu vẫn còn ý nghĩa; "
                "không đổi tên hàng loạt.\n"
                "- Nếu task con thay thế task cha cũ, có thể bỏ task cha "
                "đó hoặc giữ làm placeholder (estimate 0).\n"
                "- Cập nhật depends_on cho task con kế tiếp.\n"
                "- estimated_total_hours phải ≈ tổng mới."
            )
        if _SHRINK_PATTERNS.search(instruction):
            return (
                "\nHướng dẫn thêm (gọn lại):\n"
                "- Gộp các task tương đồng/quá nhỏ thành 1 task lớn hơn.\n"
                "- GIỮ key của task chính, bỏ task con/phụ.\n"
                "- Hợp nhất depends_on khi gộp."
            )
        return ""

    # ── implementation ──────────────────────────────────────────────────
    async def _roster(self) -> list[dict[str, Any]]:
        try:
            users = await self._bbpm.users_workload(limit=50)
        except Exception as err:  # noqa: BLE001 — roster optional
            log_event("planning.roster_failed", level="warning", error=str(err))
            return []
        roster: list[dict[str, Any]] = []
        for u in users:
            roster.append({
                "id": u.get("id"),
                "name": u.get("fullName"),
                "department": u.get("department"),
                "position": u.get("position"),
                "open_tasks": u.get("openTaskCount") or u.get("openTasks") or 0,
            })
        return roster

    async def _chat_until_valid(self, system: str, user: str, *, op: str
                                ) -> PlanDraft:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        # ── lần 1 ───
        raw = await self._call(messages)
        draft, err = self._try_parse(raw)
        if draft is not None and not err:
            return draft

        # ── lần 2 (repair) ───
        messages.append({"role": "assistant", "content": raw})
        messages.append({
            "role": "user",
            "content": (
                "JSON vừa rồi bị lỗi:\n" + (err or "không parse được") +
                "\nSửa lại và trả về MỘT JSON hợp lệ duy nhất, không kèm text."
            ),
        })
        raw2 = await self._call(messages)
        draft, err = self._try_parse(raw2)
        if draft is not None and not err:
            log_event("planning.repaired", op=op)
            return draft
        log_event("planning.generation_failed", level="warning", op=op, error=err)
        raise PlanGenerationError(err or "LLM không trả được PlanDraft hợp lệ")

    async def _call(self, messages: list[dict[str, Any]]) -> str:
        res = await self._llm.chat(
            messages,
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        return (res.content or "").strip()

    @staticmethod
    def _try_parse(raw: str) -> tuple[Optional[PlanDraft], Optional[str]]:
        if not raw:
            return None, "rỗng"
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as err:
            return None, f"JSONDecodeError: {err.msg}"
        try:
            draft = PlanDraft.model_validate(payload)
        except Exception as err:  # noqa: BLE001 — pydantic ValidationError
            return None, f"ValidationError: {err}"
        ref_errs = draft.validate_references()
        if ref_errs:
            return None, "; ".join(ref_errs)
        return draft, None

    # ── prompts ─────────────────────────────────────────────────────────
    @staticmethod
    def _sys_prompt_generate(roster: list[dict[str, Any]]) -> str:
        return (
            "Bạn là PM Agent. Sinh kế hoạch dự án từ brief.\n"
            "Yêu cầu:\n"
            "- Trả về DUY NHẤT một JSON theo schema PlanDraft, không kèm text khác.\n"
            "- Mỗi task có epic_key trỏ đúng vào một epic.\n"
            "- depends_on chỉ dùng key của task khác trong cùng draft, không tự phụ thuộc.\n"
            "- estimate_hours là số giờ ước tính, hợp lý với scope task.\n"
            "- assignee_id ưu tiên người có open_tasks thấp, khớp department/position.\n"
            "- Nếu brief không nói về assignee, có thể để null.\n"
            "- estimated_total_hours ≈ tổng estimate_hours các task.\n\n"
            f"{_SCHEMA_SKETCH}\n"
            f"Roster sẵn có (chọn assignee_id từ đây hoặc null):\n"
            f"{json.dumps(roster, ensure_ascii=False)}"
        )

    @staticmethod
    def _sys_prompt_edit(roster: list[dict[str, Any]]) -> str:
        return (
            "Bạn là PM Agent. Sửa PlanDraft theo yêu cầu manager.\n"
            "Yêu cầu:\n"
            "- Trả về DUY NHẤT JSON PlanDraft sau khi áp yêu cầu, không kèm text khác.\n"
            "- Giữ nguyên key của epic/task cũ nếu không bị xóa hoặc gộp.\n"
            "- Khi thêm task/epic mới, đặt key tiếp nối (T<n+1>, E<n+1>).\n"
            "- Cập nhật estimated_total_hours nếu tổng estimate thay đổi.\n"
            "- Nếu instruction nói 'chi tiết hơn / phân rã / chia nhỏ', PHẢI tăng số task "
            "  (không chỉ đổi câu chữ): mỗi task estimate ≥ 16h tách thành 2-4 task con "
            "  estimate 4-12h, depends_on cập nhật theo thứ tự công việc.\n"
            "- Nếu instruction nói 'gọn lại / gộp', giảm số task bằng cách merge.\n\n"
            f"{_SCHEMA_SKETCH}\n"
            f"Roster sẵn có:\n{json.dumps(roster, ensure_ascii=False)}"
        )


def _int_suffix(key: str) -> int:
    """T12 → 12, E3 → 3, fallback 0."""
    m = re.search(r"(\d+)$", key or "")
    return int(m.group(1)) if m else 0
