"""Short-term conversation memory per conversation_id.

Lưu ngữ cảnh ngắn (~30 phút) của 1 cuộc trò chuyện để agent xử lý đại từ
("đó", "này", "vừa rồi"). Stored in Redis + in-memory fallback.

Mỗi turn read/action/planning xong sẽ cập nhật. Khi user gõ câu mới có
pronoun, agent đọc lại context để biết:
- project nào vừa được nói tới
- câu hỏi/SQL gần nhất
- số rows trả về
"""

from __future__ import annotations

import json
import time
from typing import Any, Optional

from pydantic import BaseModel, Field  # noqa: F401

from infrastructure.redis import redis_client


_TTL_SEC = 30 * 60
_MEMORY: dict[str, tuple[float, str]] = {}


class ConversationContext(BaseModel):
    conversation_id: str
    updated_at: float = 0.0
    last_intent: Optional[str] = None        # read | action | checkin | planning
    last_text: Optional[str] = None          # câu user gõ trước
    last_reply_summary: Optional[str] = None  # 120 ký tự tóm tắt reply
    last_sql: Optional[str] = None
    last_row_count: Optional[int] = None
    last_project_id: Optional[int] = None
    last_project_name: Optional[str] = None
    last_task_id: Optional[int] = None
    # Entities trích từ LLM intent classifier ở turn trước — dispatcher dùng
    # để giải pronoun ("tổng hợp lại" → topic=worklog từ turn trước).
    last_entities: dict[str, Any] = Field(default_factory=dict)
    last_pattern: Optional[str] = None       # cho rephrase detection
    last_mode: Optional[str] = None


class ConversationMemory:
    @staticmethod
    def _key(conv_id: str) -> str:
        return f"conv:context:{conv_id}"

    async def get(self, conv_id: Optional[str]) -> Optional[ConversationContext]:
        if not conv_id:
            return None
        raw = await self._raw_get(self._key(conv_id))
        if not raw:
            return None
        try:
            return ConversationContext.model_validate_json(raw)
        except Exception:  # noqa: BLE001
            return None

    async def update(
        self,
        conv_id: Optional[str],
        *,
        intent: Optional[str] = None,
        text: Optional[str] = None,
        reply_summary: Optional[str] = None,
        sql: Optional[str] = None,
        row_count: Optional[int] = None,
        project_id: Optional[int] = None,
        project_name: Optional[str] = None,
        task_id: Optional[int] = None,
        entities: Optional[dict[str, Any]] = None,
        pattern: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> None:
        if not conv_id:
            return
        cur = await self.get(conv_id) or ConversationContext(conversation_id=conv_id)
        cur.updated_at = time.time()
        if intent is not None:
            cur.last_intent = intent
        if text is not None:
            cur.last_text = text[:400]
        if reply_summary is not None:
            cur.last_reply_summary = reply_summary[:300]
        if sql is not None:
            cur.last_sql = sql[:600]
        if row_count is not None:
            cur.last_row_count = row_count
        if project_id is not None:
            cur.last_project_id = project_id
        if project_name is not None:
            cur.last_project_name = project_name
        if task_id is not None:
            cur.last_task_id = task_id
        if entities is not None:
            # Lưu dict gọn (loại None) — tránh giữ noise trong Redis.
            cur.last_entities = {
                k: v for k, v in entities.items()
                if v is not None and v != "" and v != {}
            }
        if pattern is not None:
            cur.last_pattern = pattern
        if mode is not None:
            cur.last_mode = mode
        await self._raw_set(self._key(conv_id), cur.model_dump_json(), _TTL_SEC)

    async def clear(self, conv_id: Optional[str]) -> None:
        if not conv_id:
            return
        await self._raw_delete(self._key(conv_id))

    # ── transport (Redis + in-memory fallback) ────────────────────────
    async def _raw_get(self, key: str) -> Optional[str]:
        redis = redis_client.client
        if redis is not None:
            try:
                return await redis.get(key)
            except Exception:  # noqa: BLE001
                pass
        hit = _MEMORY.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        _MEMORY.pop(key, None)
        return None

    async def _raw_set(self, key: str, value: str, ttl: int) -> None:
        redis = redis_client.client
        if redis is not None:
            try:
                await redis.set(key, value, ex=ttl)
                return
            except Exception:  # noqa: BLE001
                pass
        _MEMORY[key] = (time.monotonic() + ttl, value)

    async def _raw_delete(self, key: str) -> None:
        redis = redis_client.client
        if redis is not None:
            try:
                await redis.delete(key)
            except Exception:  # noqa: BLE001
                pass
        _MEMORY.pop(key, None)


PRONOUN_REGEX = __import__("re").compile(
    r"\b(đó|nó|này|kia|vừa rồi|trên|ban nãy|ban này|trước đó|lúc nãy|"
    r"that|this|those|these)\b",
    __import__("re").IGNORECASE,
)


def has_pronoun_reference(text: str) -> bool:
    """Câu có đại từ tham chiếu nội dung trước đó không."""
    return bool(PRONOUN_REGEX.search(text))
