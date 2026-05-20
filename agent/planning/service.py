"""PlanningAgent — state machine /plan đa lượt.

States: COLLECTING_BRIEF → DRAFT_REVIEW. Mỗi lượt:
  - không có session: chỉ phản hồi nếu là lệnh /plan (kick off).
  - COLLECTING_BRIEF: text user = brief → sinh draft → DRAFT_REVIEW.
  - DRAFT_REVIEW: "ok"/"hủy"/yêu cầu sửa khác.

Draft lưu vào AgentMemory mỗi lần đổi (marker [PLAN_DRAFT v1 status=draft]).
Sau khi materialize, lưu thêm 1 row marker [PLAN_MATERIALIZED v1 projectId=N].
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from core.logging import log_event
from infrastructure.bbpm_client import BbPmApiError, BbPmClient
from infrastructure.llm_client import LlmClient
from planning.generator import PlanGenerationError, PlanGenerator
from planning.materializer import PlanMaterializer
from planning.models import MaterializeResult, PlanDraft
from planning.session import PlanningSession, PlanningSessionStore, PlanningState
from shared.text import normalize
from shared.types import ReplyBody, ReplyOption, TurnRequest


_PLAN_START_SLASH = re.compile(
    r"^\s*/(?:plan|newproject|new-project|kehoach|ke-hoach)\b", re.IGNORECASE
)
_PLAN_START_NL = re.compile(
    r"(?:l[ậaạ]p|l[êe]n)\s+k[êe]\s*ho[ạa]ch"
    r"|t[ạa]o\s+(?:d[ựu]\s*[áa]n|project)\s+m[ớo]i",
    re.IGNORECASE,
)
_CONFIRM = re.compile(
    r"^(?:ok|oke|okay|đ[uú]ng|dung|đ[ồo]ng\s*[yý]|dong\s*y|t[ạa]o\s+th[ậa]t|yes)$"
)
_CANCEL = re.compile(r"^(?:h[uủ]y|cancel|tho[áa]t|d[ừu]ng)$")

# AgentMemory.summary giới hạn 4000 ký tự (theo bb-pm route).
_MEMORY_SUMMARY_MAX = 3900   # chừa chỗ cho marker prefix
_DRAFT_MARKER = "[PLAN_DRAFT v1 status=draft]"
_MATERIALIZED_MARKER = "[PLAN_MATERIALIZED v1]"
_TOOL_DRAFT = "plan.draft.v1"
_TOOL_MATERIALIZED = "plan.materialized.v1"


class PlanningAgent:
    def __init__(
        self, *, bbpm: BbPmClient, llm: LlmClient, sessions: PlanningSessionStore
    ) -> None:
        self._bbpm = bbpm
        self._llm = llm
        self._sessions = sessions
        self._generator = PlanGenerator(llm, bbpm)
        self._materializer = PlanMaterializer(bbpm)

    # ── main entry ──────────────────────────────────────────────────────
    async def handle_turn(self, text: str, ctx: TurnRequest
                          ) -> tuple[str, Optional[ReplyBody], str]:
        """Trả về (reply_text, channel_reply, pattern)."""
        if not ctx.caller_user_id:
            return (
                "Mình chưa nhận diện được tài khoản. Nhờ admin map Gapo trước nhé.",
                None,
                "planning:no_caller",
            )

        stripped = text.strip()
        n = normalize(stripped)
        session = await self._sessions.get(ctx.caller_user_id)
        is_start = bool(_PLAN_START_SLASH.match(stripped) or _PLAN_START_NL.search(stripped))

        # /plan luôn ép khởi tạo lại (kể cả có session cũ).
        if is_start:
            if not await self._caller_is_manager(ctx):
                return (
                    "Chỉ Manager/Admin mới được tạo kế hoạch dự án mới.",
                    None,
                    "planning:rbac_denied",
                )
            return await self._start(ctx)

        if session is None:
            return (
                "Gõ /plan để bắt đầu lập kế hoạch dự án mới.",
                None,
                "planning:hint",
            )

        if _CANCEL.match(n):
            await self._sessions.delete(ctx.caller_user_id)
            return ("Đã hủy kế hoạch.", None, "planning:cancelled")

        if session.state == PlanningState.COLLECTING_BRIEF:
            return await self._on_brief(ctx, session, stripped)

        if session.state == PlanningState.DRAFT_REVIEW:
            if _CONFIRM.match(n):
                return await self._on_confirm(ctx, session)
            return await self._on_edit(ctx, session, stripped)

        return ("Trạng thái phiên kế hoạch không hợp lệ.", None, "planning:bad_state")

    # ── /plan kickoff ───────────────────────────────────────────────────
    async def _start(self, ctx: TurnRequest) -> tuple[str, Optional[ReplyBody], str]:
        sess = PlanningSession(
            user_id=ctx.caller_user_id or 0,
            conversation_id=ctx.conversation_id,
            state=PlanningState.COLLECTING_BRIEF,
        )
        # Lấy company_id nếu pipeline đã gắn vào metadata.
        meta = ctx.metadata or {}
        company_id = meta.get("company_id") if isinstance(meta.get("company_id"), int) else None
        sess.company_id = company_id
        await self._sessions.set(sess)
        log_event("planning.start", user_id=ctx.caller_user_id)
        text = (
            "Mình sẵn sàng lập kế hoạch. Bạn mô tả ngắn cho mình:\n"
            "  • Tên dự án + mục tiêu\n"
            "  • Thời gian dự kiến (bắt đầu / kết thúc)\n"
            "  • Team & deadline lớn nếu có\n\n"
            'Gõ "hủy" để dừng.'
        )
        return (text, None, "planning:start")

    # ── COLLECTING_BRIEF → sinh draft ───────────────────────────────────
    async def _on_brief(
        self, ctx: TurnRequest, sess: PlanningSession, brief: str
    ) -> tuple[str, Optional[ReplyBody], str]:
        sess.brief = brief
        try:
            draft = await self._generator.from_brief(brief, company_id=sess.company_id)
        except PlanGenerationError as err:
            log_event("planning.generate_failed", level="warning", error=str(err))
            return (
                "Mình chưa sinh được kế hoạch từ mô tả này. Bạn thử mô tả lại "
                "chi tiết hơn (mục tiêu, thời gian, team) hoặc gõ \"hủy\" để dừng.",
                None,
                "planning:generate_failed",
            )
        memory_id = await self._save_draft_memory(ctx, draft, user_text=brief,
                                                   reply=self._render(draft))
        sess.draft = draft
        sess.draft_memory_id = memory_id
        sess.state = PlanningState.DRAFT_REVIEW
        await self._sessions.set(sess)
        await self._audit(ctx, "planning.draft_generated",
                          {"taskCount": len(draft.tasks),
                           "epicCount": len(draft.epics)})
        return self._render_draft_reply(draft, edited=False)

    # ── DRAFT_REVIEW: yêu cầu sửa ───────────────────────────────────────
    async def _on_edit(
        self, ctx: TurnRequest, sess: PlanningSession, instruction: str
    ) -> tuple[str, Optional[ReplyBody], str]:
        if sess.draft is None:
            return ("Draft hiện không có — gõ /plan để bắt đầu lại.",
                    None, "planning:no_draft")
        try:
            new_draft = await self._generator.apply_edit(sess.draft, instruction)
        except PlanGenerationError as err:
            log_event("planning.edit_failed", level="warning", error=str(err))
            return (
                'Mình chưa hiểu rõ yêu cầu sửa. Bạn nói cụ thể hơn nhé, hoặc gõ "ok" '
                'để giữ nguyên / "hủy" để dừng.',
                None,
                "planning:edit_failed",
            )
        memory_id = await self._save_draft_memory(
            ctx, new_draft, user_text=instruction,
            reply=self._render(new_draft, edited=True),
        )
        sess.draft = new_draft
        sess.draft_memory_id = memory_id
        sess.edit_count += 1
        await self._sessions.set(sess)
        await self._audit(ctx, "planning.draft_edited",
                          {"editCount": sess.edit_count,
                           "taskCount": len(new_draft.tasks)})
        return self._render_draft_reply(new_draft, edited=True)

    # ── DRAFT_REVIEW: confirm → materialize ─────────────────────────────
    async def _on_confirm(
        self, ctx: TurnRequest, sess: PlanningSession
    ) -> tuple[str, Optional[ReplyBody], str]:
        if sess.draft is None:
            return ("Draft hiện không có — gõ /plan để bắt đầu lại.",
                    None, "planning:no_draft")
        try:
            result = await self._materializer.materialize(
                sess.draft, owner_user_id=ctx.caller_user_id or 0
            )
        except BbPmApiError as err:
            log_event("planning.materialize_failed", level="error", error=str(err))
            return (
                f"Không tạo được project: {err}. Bạn thử lại sau hoặc gõ /plan để làm lại.",
                None,
                "planning:materialize_failed",
            )

        sess.draft.materialized = True
        sess.draft.project_id = result.project_id
        await self._save_materialized_memory(ctx, sess.draft, result)
        await self._sessions.delete(ctx.caller_user_id or 0)
        await self._audit(ctx, "planning.materialized",
                          {"projectId": result.project_id,
                           "taskCount": len(result.task_ids),
                           "errors": len(result.errors)})
        return (self._render_materialized(result), None, "planning:materialized")

    # ── render helpers ──────────────────────────────────────────────────
    @staticmethod
    def _render(draft: PlanDraft, *, edited: bool = False) -> str:
        lines: list[str] = []
        title = "Dự án (sửa)" if edited else "Kế hoạch dự án"
        total = draft.estimated_total_hours or sum(t.estimate_hours for t in draft.tasks)
        head = f"{title}: {draft.project_name}"
        if total:
            head += f"  (≈{total:g}h"
            if draft.end_date:
                head += f", kết thúc {draft.end_date}"
            head += ")"
        lines.append(head)

        # nhóm task theo epic
        tasks_by_epic: dict[str, list] = {}
        for t in draft.tasks:
            tasks_by_epic.setdefault(t.epic_key, []).append(t)

        for epic in draft.epics:
            due = f" (due {epic.due_date})" if epic.due_date else ""
            lines.append(f"\n{epic.key}. {epic.name}{due}")
            for t in tasks_by_epic.get(epic.key, []):
                est = f"{t.estimate_hours:g}h"
                assignee = f" → {t.assignee_name}" if t.assignee_name else (
                    f" → user#{t.assignee_id}" if t.assignee_id else ""
                )
                pr = f" [{t.priority}]" if t.priority else ""
                deps = f"  ⟵ phụ thuộc {','.join(t.depends_on)}" if t.depends_on else ""
                lines.append(f"  {t.key}. {t.name}  {est}{assignee}{pr}{deps}")
        return "\n".join(lines)

    def _render_draft_reply(
        self, draft: PlanDraft, *, edited: bool
    ) -> tuple[str, Optional[ReplyBody], str]:
        body = self._render(draft, edited=edited)
        hint = (
            '\n\nTrả lời:'
            '\n  • "ok" / "tạo thật" — materialize project'
            '\n  • "chi tiết hơn" / "phân rã T3" — tách nhỏ task'
            '\n  • "gộp T1 và T2" / "gọn lại" — merge'
            '\n  • "đổi assignee T3 sang Hà" / "deadline T2 sang 2026-06-15"'
            '\n  • "hủy" — bỏ kế hoạch'
        )
        reply = ReplyBody(
            kind="quick_replies",
            text=body + hint,
            options=[
                ReplyOption(title="Tạo thật", payload="ok"),
                ReplyOption(title="Hủy", payload="hủy"),
            ],
        )
        return (body + hint, reply,
                "planning:draft_edited" if edited else "planning:draft_ready")

    @staticmethod
    def _render_materialized(result: MaterializeResult) -> str:
        parts = [
            f"Đã tạo dự án #{result.project_id}.",
            f"  • Epic: {len(result.milestone_ids)} | Task: {len(result.task_ids)}"
            f" | Estimate (scope): {len(result.scope_ids)}",
        ]
        if result.errors:
            parts.append(f"  • Có {len(result.errors)} bước fail (xem chi tiết trên web):")
            for e in result.errors[:5]:
                parts.append(f"     – {e}")
            if len(result.errors) > 5:
                parts.append(f"     – … ({len(result.errors) - 5} lỗi nữa)")
        return "\n".join(parts)

    # ── AgentMemory storage ─────────────────────────────────────────────
    async def _save_draft_memory(
        self, ctx: TurnRequest, draft: PlanDraft, *, user_text: str, reply: str
    ) -> Optional[int]:
        summary = self._encode_draft_summary(draft)
        try:
            res = await self._bbpm.post_memory(
                conversationId=ctx.conversation_id,
                source=self._memory_source(ctx),
                userText=user_text[:2000],
                replyText=reply[:2000],
                summary=summary,
                toolsUsed=[_TOOL_DRAFT],
                projectIds=[],
                taskIds=[],
                correlationId=ctx.correlation_id,
            )
            return int(res.get("id")) if isinstance(res, dict) and res.get("id") else None
        except Exception as err:  # noqa: BLE001 — không fail flow chỉ vì memory
            log_event("planning.memory_save_failed", level="warning", error=str(err))
            return None

    async def _save_materialized_memory(
        self, ctx: TurnRequest, draft: PlanDraft, result: MaterializeResult
    ) -> None:
        summary = (
            f"{_MATERIALIZED_MARKER} projectId={result.project_id}\n"
            + json.dumps({
                "project_name": draft.project_name,
                "milestones": result.milestone_ids,
                "tasks": result.task_ids,
                "scopes": result.scope_ids,
                "errors": result.errors[:10],
            }, ensure_ascii=False)
        )
        summary = summary[:_MEMORY_SUMMARY_MAX]
        try:
            await self._bbpm.post_memory(
                conversationId=ctx.conversation_id,
                source=self._memory_source(ctx),
                userText="ok",
                replyText=self._render_materialized(result)[:2000],
                summary=summary,
                toolsUsed=[_TOOL_MATERIALIZED],
                projectIds=[result.project_id],
                taskIds=list(result.task_ids.values()),
                correlationId=ctx.correlation_id,
            )
        except Exception as err:  # noqa: BLE001
            log_event("planning.memory_save_failed", level="warning", error=str(err))

    @staticmethod
    def _encode_draft_summary(draft: PlanDraft) -> str:
        body = draft.model_dump(exclude_none=True, exclude={"materialized", "project_id"})
        encoded = f"{_DRAFT_MARKER}\n{json.dumps(body, ensure_ascii=False)}"
        if len(encoded) <= _MEMORY_SUMMARY_MAX:
            return encoded
        # ── compact: cắt description ──
        for t in body.get("tasks", []):
            if t.get("description"):
                t["description"] = t["description"][:80]
        for e in body.get("epics", []):
            if e.get("description"):
                e["description"] = e["description"][:80]
        encoded = f"{_DRAFT_MARKER}\n{json.dumps(body, ensure_ascii=False)}"
        if len(encoded) <= _MEMORY_SUMMARY_MAX:
            return encoded
        # ── compact extreme: bỏ description hoàn toàn ──
        for t in body.get("tasks", []):
            t.pop("description", None)
        for e in body.get("epics", []):
            e.pop("description", None)
        body.pop("description", None)
        encoded = f"{_DRAFT_MARKER}\n{json.dumps(body, ensure_ascii=False)}"
        return encoded[:_MEMORY_SUMMARY_MAX]

    @staticmethod
    def _memory_source(ctx: TurnRequest) -> str:
        return "other" if ctx.source == "eval" else (ctx.source or "chat")

    async def _audit(self, ctx: TurnRequest, tool: str, args: dict[str, Any]) -> None:
        try:
            await self._bbpm.post_audit(
                tool=tool, args_json=args,
                source=self._memory_source(ctx),
                correlation_id=ctx.correlation_id,
            )
        except Exception:  # noqa: BLE001
            pass

    # ── RBAC ────────────────────────────────────────────────────────────
    async def _caller_is_manager(self, ctx: TurnRequest) -> bool:
        meta = ctx.metadata or {}
        role = meta.get("role") if isinstance(meta.get("role"), str) else None
        if role:
            return role.upper() in {"ADMIN", "MANAGER"}
        # Fallback: nếu pipeline chưa gắn role, tra qua user_by_channel.
        if not ctx.external_id:
            return False
        try:
            user = await self._bbpm.user_by_channel(
                channel="gapo", external_id=ctx.external_id,
                thread_id=(meta.get("thread_id") if isinstance(meta.get("thread_id"), str)
                           else None),
            )
        except Exception:  # noqa: BLE001
            return False
        if not user:
            return False
        role = (user.get("role") or "").upper()
        if user.get("isSuperAdmin"):
            return True
        return role in {"ADMIN", "MANAGER"}
