from __future__ import annotations

import json
import re
from datetime import date
from decimal import Decimal
from typing import Any

import httpx

from core.config import Settings
from domain.schemas import Blocker, ParsedCheckin, Severity, TaskStatus


CHECKIN_EXTRACT_SYSTEM_PROMPT = """
Bạn là PM assistant. Chuyển update tiếng Việt tự nhiên thành JSON.
Chỉ trả JSON, không markdown.
Schema:
{
  "work_date": "YYYY-MM-DD",
  "summary": "việc đã làm",
  "done_items": ["item"],
  "hours": 1.5,
  "task_status": "TODO|IN_PROGRESS|REVIEW|DONE|null",
  "blocker": {"description": "...", "severity": "LOW|MED|HIGH"} | null,
  "needs_clarification": false,
  "clarification_question": null
}
Không bịa dữ liệu. Nếu không thấy số giờ, để hours = 1.
Nếu có từ khóa blocker/vướng/chưa có/đang kẹt thì tạo blocker.
""".strip()


class LlmClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=settings.llm_base_url,
            timeout=httpx.Timeout(60.0),
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def parse_checkin(self, text: str) -> ParsedCheckin:
        fallback = ParsedCheckin(
            summary=text.strip(),
            hours=extract_hours(text) or Decimal("1.0"),
            blocker=extract_blocker(text),
            task_status=extract_status(text),
        )

        try:
            res = await self.client.post(
                "/chat/completions",
                json={
                    "model": self.settings.llm_model,
                    "temperature": 0,
                    "messages": [
                        {"role": "system", "content": CHECKIN_EXTRACT_SYSTEM_PROMPT},
                        {"role": "user", "content": text},
                    ],
                    "response_format": {"type": "json_object"},
                },
            )
            res.raise_for_status()
            content = res.json()["choices"][0]["message"]["content"]
            payload = json.loads(content)
            return ParsedCheckin.model_validate(normalize_llm_payload(payload, fallback))
        except Exception:
            return fallback


def normalize_llm_payload(payload: dict[str, Any], fallback: ParsedCheckin) -> dict[str, Any]:
    payload.setdefault("work_date", date.today().isoformat())
    payload.setdefault("summary", fallback.summary)
    payload.setdefault("done_items", [])
    payload.setdefault("hours", str(fallback.hours))
    payload.setdefault("task_status", fallback.task_status)
    payload.setdefault("blocker", fallback.blocker.model_dump() if fallback.blocker else None)
    payload.setdefault("needs_clarification", False)
    payload.setdefault("clarification_question", None)
    if payload["task_status"] == "null":
        payload["task_status"] = None
    return payload


def extract_hours(text: str) -> Decimal | None:
    match = re.search(r"(\d+(?:[,.]\d+)?)\s*(h|giờ|gio|hours?)\b", text, re.IGNORECASE)
    if not match:
        return None
    return Decimal(match.group(1).replace(",", "."))


def extract_status(text: str) -> TaskStatus | None:
    lowered = text.lower()
    if re.search(r"\b(done|xong|hoàn thành|hoan thanh)\b", lowered):
        return "DONE"
    if re.search(r"\b(review|pr|merge request|chờ duyệt|cho duyet)\b", lowered):
        return "REVIEW"
    if re.search(r"\b(đang làm|dang lam|in progress)\b", lowered):
        return "IN_PROGRESS"
    return None


def extract_blocker(text: str) -> Blocker | None:
    lowered = text.lower()
    if not re.search(r"\b(blocker|vướng|vuong|kẹt|ket|chưa có|chua co|không có|khong co)\b", lowered):
        return None
    severity: Severity = "HIGH" if re.search(r"\b(gấp|gap|critical|nghiêm trọng|nghiem trong)\b", lowered) else "MED"
    return Blocker(description=text.strip(), severity=severity)
