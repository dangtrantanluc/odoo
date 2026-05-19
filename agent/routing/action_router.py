"""Action router — natural-language writes with a confirm step.

Ports bb-pm-tools/src/routing/action/router.ts. Detects an action intent,
shows a preview, and waits for an explicit confirmation before executing via
structured tools (never raw SQL — keeps RBAC/validation/audit on the bb-pm
API). Pending state lives in Redis (TTL) so a restart cannot half-apply.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Optional

from core.config import settings
from core.logging import log_event
from infrastructure.redis import redis_client
from shared.text import normalize
from shared.types import TurnRequest
from tools.catalog import ToolCatalog

_CONFIRM = re.compile(r"^(?:ok|oke|okay|dung|đúng|dong y|đồng ý|yes|co|có|xac nhan|xác nhận)$")
_CANCEL = re.compile(r"^(?:huy|hủy|khong|không|no|thoi|thôi|cancel)$")

_STATUS_WORDS = {
    "done": "DONE", "xong": "DONE", "hoan thanh": "DONE",
    "review": "REVIEW", "cho duyet": "REVIEW",
    "dang lam": "IN_PROGRESS", "in progress": "IN_PROGRESS",
    "todo": "TODO",
}

_RE_STATUS = re.compile(
    r"(?:đánh dấu|danh dau|set|chuyển|chuyen)\s+task\s+#?(\d+)\s+(?:sang\s+|thành\s+|thanh\s+)?(.+)",
    re.IGNORECASE,
)
_RE_DEADLINE = re.compile(
    r"(?:đổi|doi|thay đổi|thay doi)\s+deadline\s+task\s+#?(\d+)\s+(?:sang|thành|thanh)\s+"
    r"(\d{4}-\d{2}-\d{2})",
    re.IGNORECASE,
)
_RE_CREATE_TASK = re.compile(
    r"(?:tạo|tao|thêm|them)\s+task\s+(.+?)\s+(?:trong|cho)\s+(?:dự án|du an|project)\s+(.+)",
    re.IGNORECASE,
)
_MEMORY_PENDING: dict[str, tuple[float, dict[str, Any]]] = {}


class ActionRouter:
    def __init__(self, catalog: ToolCatalog) -> None:
        self._catalog = catalog

    async def handle(self, text: str, ctx: TurnRequest) -> Optional[tuple[str, str]]:
        if not ctx.conversation_id:
            return None
        stripped = text.strip()
        n = normalize(stripped)

        pending = await self._get_pending(ctx.conversation_id)
        if pending is not None:
            if _CONFIRM.match(n):
                await self._clear_pending(ctx.conversation_id)
                return await self._execute(pending)
            if _CANCEL.match(n):
                await self._clear_pending(ctx.conversation_id)
                return "Đã hủy thao tác.", "action:cancelled"
            # An unrelated message drops the pending action silently.
            await self._clear_pending(ctx.conversation_id)

        detected = self._detect(stripped)
        if detected is None:
            return None
        action, preview = detected
        await self._set_pending(ctx.conversation_id, action)
        return f"{preview}\n\nXác nhận? (trả lời \"ok\" hoặc \"hủy\")", "action:preview"

    # ── detection ───────────────────────────────────────────────────────
    def _detect(self, text: str) -> Optional[tuple[dict[str, Any], str]]:
        m = _RE_DEADLINE.search(text)
        if m:
            task_id, deadline = int(m.group(1)), m.group(2)
            return ({"type": "deadline", "task_id": task_id, "deadline": deadline},
                    f"Đổi deadline task {task_id} sang {deadline}.")
        m = _RE_STATUS.search(text)
        if m:
            task_id = int(m.group(1))
            status = _resolve_status(m.group(2))
            if status:
                return ({"type": "status", "task_id": task_id, "status": status},
                        f"Đổi trạng thái task {task_id} sang {status}.")
        m = _RE_CREATE_TASK.search(text)
        if m:
            name, project = m.group(1).strip(), m.group(2).strip()
            return ({"type": "create_task", "name": name, "project": project},
                    f'Tạo task "{name}" trong dự án "{project}".')
        return None

    # ── execution ───────────────────────────────────────────────────────
    async def _execute(self, action: dict[str, Any]) -> tuple[str, str]:
        kind = action["type"]
        try:
            if kind == "deadline":
                await self._catalog.patch_task(action["task_id"], deadline=action["deadline"])
                return f"Đã đổi deadline task {action['task_id']}.", "action:deadline"
            if kind == "status":
                await self._catalog.transition_task(action["task_id"], action["status"])
                return f"Đã đổi trạng thái task {action['task_id']}.", "action:status"
            if kind == "create_task":
                project = await self._resolve_project(action["project"])
                if project is None:
                    return (f"Không tìm thấy dự án \"{action['project']}\".", "action:no_project")
                created = await self._catalog.create_task(project["id"], action["name"])
                return (f"Đã tạo task {created.get('id')} trong {project.get('name')}.",
                        "action:create_task")
        except Exception as err:  # noqa: BLE001
            log_event("action.execute_failed", level="warning", kind=kind, error=str(err))
            return "Thao tác gặp lỗi khi thực hiện, bạn thử lại sau nhé.", "action:error"
        return "Không rõ thao tác.", "action:unknown"

    async def _resolve_project(self, name: str) -> Optional[dict[str, Any]]:
        projects = await self._catalog._bbpm.list_projects(q=name)  # noqa: SLF001
        if not projects:
            return None
        q = normalize(name)
        return next((p for p in projects if normalize(p.get("name", "")) == q), projects[0])

    # ── pending state (Redis, in-memory fallback) ───────────────────────
    @staticmethod
    def _key(conversation_id: str) -> str:
        return f"action_pending:{conversation_id}"

    async def _get_pending(self, conversation_id: str) -> Optional[dict[str, Any]]:
        redis = redis_client.client
        key = self._key(conversation_id)
        if redis is not None:
            try:
                raw = await redis.get(key)
                return json.loads(raw) if raw else None
            except Exception:  # noqa: BLE001
                pass
        hit = _MEMORY_PENDING.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        _MEMORY_PENDING.pop(key, None)
        return None

    async def _set_pending(self, conversation_id: str, action: dict[str, Any]) -> None:
        redis = redis_client.client
        key = self._key(conversation_id)
        ttl = settings.action_pending_ttl_sec
        if redis is not None:
            try:
                await redis.set(key, json.dumps(action), ex=ttl)
                return
            except Exception:  # noqa: BLE001
                pass
        _MEMORY_PENDING[key] = (time.monotonic() + ttl, action)

    async def _clear_pending(self, conversation_id: str) -> None:
        key = self._key(conversation_id)
        redis = redis_client.client
        if redis is not None:
            try:
                await redis.delete(key)
            except Exception:  # noqa: BLE001
                pass
        _MEMORY_PENDING.pop(key, None)


def _resolve_status(raw: str) -> Optional[str]:
    n = normalize(raw)
    for word, status in _STATUS_WORDS.items():
        if word in n:
            return status
    return None
