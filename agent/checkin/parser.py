"""Check-in update parser — LLM extraction with a deterministic regex fallback.

Faithful port of parseCheckin / regexFallback / extractHours and the
relative-time-range logic in bb-pm-tools/src/checkin/service.ts.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from checkin.models import ParsedBlocker, ParsedCheckin
from core.logging import log_event
from infrastructure.llm_client import LlmClient
from shared.text import normalize

_HCM = ZoneInfo("Asia/Ho_Chi_Minh")

_RELATIVE_NOW = re.compile(
    r"(?:^|\s)(?:từ|tu)\s*(\d{1,2})(?:(?::|h)(\d{2}))?\s*(?:h|giờ|gio)?\s*"
    r"(sáng|sang|chiều|chieu|tối|toi)?\s*(?:-|–|—|đến|den|tới|toi)\s*"
    r"(?:bây\s*giờ|bay\s*gio|hiện\s*tại|hien\s*tai|bây\s*h|bay\s*h)(?=\s|$)",
    re.IGNORECASE,
)
_RANGE = re.compile(
    r"\b(?:từ\s*)?(\d{1,2})(?:(?::|h)(\d{2}))?\s*(?:h|giờ|gio)?\s*"
    r"(sáng|sang|chiều|chieu|tối|toi)?\s*(?:-|–|—|đến|den|tới|toi)\s*"
    r"(\d{1,2})(?:(?::|h)(\d{2}))?\s*(?:h|giờ|gio)?\s*(sáng|sang|chiều|chieu|tối|toi)?\b",
    re.IGNORECASE,
)
_DONE = re.compile(r"\b(done|xong|hoàn thành|hoan thanh)\b|100%", re.IGNORECASE)
_REVIEW = re.compile(r"\b(review|pr|merge request|chờ duyệt|cho duyet)\b", re.IGNORECASE)
_IN_PROGRESS = re.compile(r"\b(đang làm|dang lam|in progress)\b", re.IGNORECASE)
_BLOCKER = re.compile(
    r"\b(blocker|vướng|vuong|kẹt|ket|chưa có|chua co|không có|khong co)\b", re.IGNORECASE
)
_BLOCKER_HIGH = re.compile(
    r"\b(gấp|gap|critical|nghiêm trọng|nghiem trong)\b", re.IGNORECASE
)

_PARSE_SYSTEM_PROMPT = (
    "Bạn là parser check-in PM. Trả JSON object với schema "
    '{"work_date":"YYYY-MM-DD","summary":"string","hours":1.5,'
    '"status":"IN_PROGRESS|REVIEW|DONE|null",'
    '"blocker":{"description":"string","severity":"LOW|MED|HIGH"}|null,'
    '"task_hint":"string|null","needs_clarification":false,'
    '"clarification_question":"string|null"}. '
    "Không bịa dữ liệu; nếu thiếu giờ thì dùng 1; "
    "nếu input mơ hồ không có tiến độ cụ thể thì needs_clarification=true. "
    "Nếu có CONTEXT từ turn trước (clarify question + worklog draft), "
    "COMBINE thông tin: câu user mới là câu trả lời cho clarify question, "
    "bổ sung vào summary/hours/status — KHÔNG yêu cầu user gõ lại từ đầu."
)


def _now() -> datetime:
    return datetime.now(_HCM)


def _today_iso() -> str:
    return _now().date().isoformat()


def _to_minutes(hour_raw: str, minute_raw: Optional[str], period_raw: Optional[str]) -> Optional[int]:
    try:
        hour = int(hour_raw)
        minute = int(minute_raw) if minute_raw else 0
    except (TypeError, ValueError):
        return None
    period = normalize(period_raw or "")
    if period in ("chieu", "toi") and 1 <= hour <= 11:
        hour += 12
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return None
    return hour * 60 + minute


def _hanoi_minutes(now: Optional[datetime] = None) -> int:
    dt = (now or _now()).astimezone(_HCM)
    return dt.hour * 60 + dt.minute


def has_relative_now_range(text: str) -> bool:
    return _RELATIVE_NOW.search(text or "") is not None


def _relative_now_range(text: str, now: Optional[datetime] = None) -> tuple[Optional[float], bool]:
    """Return (hours, needs_clarification)."""
    match = _RELATIVE_NOW.search(text or "")
    if not match:
        return None, False
    start = _to_minutes(match.group(1), match.group(2), match.group(3))
    if start is None:
        return None, False
    current = _hanoi_minutes(now)
    if current < start:
        return None, True
    return (current - start) / 60, False


def _range_hours(text: str) -> Optional[float]:
    match = _RANGE.search(text or "")
    if not match:
        return None
    start = _to_minutes(match.group(1), match.group(2), match.group(3))
    end = _to_minutes(match.group(4), match.group(5), match.group(6))
    if start is None or end is None:
        return None
    if end < start:
        end += 24 * 60
    duration = (end - start) / 60
    return duration if 0 < duration <= 24 else None


def extract_hours(text: str) -> float:
    rel, _ = _relative_now_range(text)
    if rel is not None:
        return rel
    rng = _range_hours(text)
    if rng is not None:
        return rng
    if re.search(r"\b(?:nửa|nua)\s*(?:giờ|gio|tiếng|tieng)\b", text, re.IGNORECASE):
        return 0.5
    half_suffix = re.search(r"(\d+)\s*(?:giờ|gio|tiếng|tieng)\s*(?:rưỡi|ruoi)\b", text, re.IGNORECASE)
    if half_suffix:
        return int(half_suffix.group(1)) + 0.5
    mixed = re.search(r"(\d+)\s*(?:giờ|gio|tiếng|tieng|h)\s*(\d+)\s*(?:phút|phut|p)\b", text, re.IGNORECASE)
    if mixed:
        return int(mixed.group(1)) + int(mixed.group(2)) / 60
    compact = re.search(r"\b(\d+)\s*h\s*(\d{1,2})\b", text, re.IGNORECASE)
    if compact:
        return int(compact.group(1)) + int(compact.group(2)) / 60
    duration = re.search(r"(\d+(?:[,.]\d+)?)\s*(h|giờ|gio|tiếng|tieng|hours?)\b", text, re.IGNORECASE)
    if duration:
        return float(duration.group(1).replace(",", "."))
    minutes = re.search(r"(\d+)\s*(?:phút|phut|minutes?|mins?|p)\b", text, re.IGNORECASE)
    if minutes:
        return int(minutes.group(1)) / 60
    return 1.0


def regex_fallback(text: str) -> ParsedCheckin:
    rel_hours, rel_needs_clarify = _relative_now_range(text)
    hours = rel_hours if rel_hours is not None else extract_hours(text)
    if _DONE.search(text):
        status: Optional[str] = "DONE"
    elif _REVIEW.search(text):
        status = "REVIEW"
    elif _IN_PROGRESS.search(text):
        status = "IN_PROGRESS"
    else:
        status = None
    blocker = None
    if _BLOCKER.search(text):
        blocker = ParsedBlocker(
            description=text.strip(),
            severity="HIGH" if _BLOCKER_HIGH.search(text) else "MED",
        )
    has_text = bool(text.strip())
    return ParsedCheckin(
        work_date=_today_iso(),
        summary=text.strip(),
        hours=hours,
        status=status,  # type: ignore[arg-type]
        blocker=blocker,
        task_hint=None,
        needs_clarification=(not has_text) or rel_needs_clarify,
        clarification_question=(
            "Bạn cập nhật cụ thể giúp mình nhé."
            if not has_text
            else "Khoảng thời gian này có vẻ đang qua ngày. "
            "Bạn nhập rõ số giờ hoặc mốc kết thúc giúp mình nhé."
            if rel_needs_clarify
            else None
        ),
    )


def _normalize_parsed(payload: dict, fallback: ParsedCheckin) -> ParsedCheckin:
    status = payload.get("status")
    status = status if status in ("IN_PROGRESS", "REVIEW", "DONE") else None
    raw_blocker = payload.get("blocker") or {}
    severity = raw_blocker.get("severity")
    severity = severity if severity in ("LOW", "MED", "HIGH") else "MED"

    try:
        llm_hours = float(payload.get("hours"))
    except (TypeError, ValueError):
        llm_hours = 0.0
    hours = (
        fallback.hours
        if has_relative_now_range(fallback.summary)
        else (llm_hours if llm_hours > 0 else fallback.hours)
    )
    summary = payload.get("summary")
    summary = summary.strip() if isinstance(summary, str) and summary.strip() else fallback.summary
    blocker = None
    if raw_blocker.get("description"):
        blocker = ParsedBlocker(description=str(raw_blocker["description"]), severity=severity)
    task_hint = payload.get("task_hint")
    task_hint = task_hint.strip() if isinstance(task_hint, str) and task_hint.strip() else None
    return ParsedCheckin(
        work_date=payload.get("work_date") if isinstance(payload.get("work_date"), str) else fallback.work_date,
        summary=summary,
        hours=hours,
        status=status,  # type: ignore[arg-type]
        blocker=blocker,
        task_hint=task_hint,
        needs_clarification=bool(payload.get("needs_clarification")),
        clarification_question=(
            payload.get("clarification_question")
            if isinstance(payload.get("clarification_question"), str)
            else None
        ),
    )


async def parse_checkin(
    text: str, llm: LlmClient, *,
    prev_question: Optional[str] = None,
    prev_partial: Optional[dict] = None,
) -> tuple[ParsedCheckin, bool]:
    """Return (parsed, used_llm). Falls back to regex on any LLM failure.

    Stateful: nếu `prev_question` được truyền (clarify ở turn trước), LLM sẽ
    combine câu trả lời mới với context để hoàn thiện worklog, thay vì hỏi
    lại từ đầu.
    """
    fallback = regex_fallback(text)
    if fallback.needs_clarification and has_relative_now_range(text):
        return fallback, False

    user_block = _build_user_block(text, prev_question, prev_partial)
    try:
        res = await llm.chat(
            [
                {"role": "system", "content": _PARSE_SYSTEM_PROMPT},
                {"role": "user", "content": user_block},
            ],
            temperature=0,
            max_tokens=350,
            response_format={"type": "json_object"},
        )
        payload = json.loads(res.content or "{}")
        return _normalize_parsed(payload, fallback), True
    except Exception as err:  # noqa: BLE001
        log_event("checkin.parse_fallback", level="warning", error=str(err))
        return fallback, False


def _build_user_block(
    text: str,
    prev_question: Optional[str],
    prev_partial: Optional[dict],
) -> str:
    """Render block input cho LLM — kèm clarify question + draft trước nếu có."""
    if not prev_question and not prev_partial:
        return text
    parts: list[str] = []
    if prev_question:
        parts.append(f"CONTEXT — clarify question đã hỏi: \"{prev_question}\"")
    if prev_partial:
        parts.append("CONTEXT — worklog draft (từ turn trước):")
        for k in ("summary", "hours", "status", "blocker", "task_hint"):
            v = prev_partial.get(k)
            if v:
                parts.append(f"  - {k}: {v}")
    parts.append("")
    parts.append(f"User trả lời mới: \"{text}\"")
    parts.append("Hãy COMBINE và trả ParsedCheckin hoàn thiện.")
    return "\n".join(parts)
