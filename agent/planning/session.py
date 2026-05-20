"""State phiên planning — Redis với fallback in-memory.

Cấu trúc giống cách action_router xử lý pending action: ưu tiên Redis (đa
worker an toàn), nếu Redis không khả dụng thì rơi về dict process-local.
"""

from __future__ import annotations

import json
import time
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from infrastructure.redis import redis_client
from planning.models import PlanDraft


class PlanningState(str, Enum):
    COLLECTING_BRIEF = "COLLECTING_BRIEF"
    DRAFT_REVIEW = "DRAFT_REVIEW"


class PlanningSession(BaseModel):
    user_id: int
    company_id: Optional[int] = None
    conversation_id: Optional[str] = None
    state: PlanningState = PlanningState.COLLECTING_BRIEF
    brief: Optional[str] = None
    draft: Optional[PlanDraft] = None
    draft_memory_id: Optional[int] = None     # id row AgentMemory lưu draft
    edit_count: int = 0                       # số lần đã sửa draft


_TTL_SEC = 30 * 60
_MEMORY: dict[str, tuple[float, str]] = {}    # key → (expires_at_monotonic, json)


class PlanningSessionStore:
    @staticmethod
    def _key(user_id: int) -> str:
        return f"planning:session:{user_id}"

    async def exists(self, user_id: int) -> bool:
        return (await self.get(user_id)) is not None

    async def get(self, user_id: int) -> Optional[PlanningSession]:
        raw = await self._raw_get(self._key(user_id))
        if not raw:
            return None
        try:
            return PlanningSession.model_validate_json(raw)
        except Exception:  # noqa: BLE001
            await self.delete(user_id)
            return None

    async def set(self, sess: PlanningSession) -> None:
        await self._raw_set(self._key(sess.user_id), sess.model_dump_json(), _TTL_SEC)

    async def delete(self, user_id: int) -> None:
        await self._raw_delete(self._key(user_id))

    # ── transport ───────────────────────────────────────────────────────
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
