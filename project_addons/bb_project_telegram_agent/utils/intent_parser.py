import re
import unicodedata


_PROJECT_CODE_PATTERN = re.compile(r"\b([a-z0-9]+(?:[-_][a-z0-9]+)+)\b")
_PROJECT_CUE_PATTERN = re.compile(r"\b(?:project|du an)\b(?P<tail>.+)")
_PROJECT_LEADING_FILLER_PATTERN = re.compile(
    r"^(?:(?:nay la|nay nhe|do nhe|cho toi|giup toi|dum toi|ho toi|xem giup|xem cho toi|kiem tra|check|coi|ma|ten|code|la|ve|cua|nay|do|kia|ay|xem)\s+)+"
)
_PROJECT_TRAILING_PERIOD_PATTERN = re.compile(r"\b(?:hom nay|hom qua|tuan nay|thang nay)\b.*$")
_GENERIC_PROJECT_TAILS = {
    "",
    "nay",
    "do",
    "kia",
    "ay",
    "nao",
    "gi",
    "la gi",
    "la sao",
}
_SUMMARY_ENABLE_KEYWORDS = [
    "bat bao cao",
    "bat summary",
    "bat tong hop",
    "gui cho toi",
    "gui toi",
    "nhac toi",
    "bao toi",
    "dat lich",
    "schedule",
]
_SUMMARY_DELIVERY_KEYWORDS = [
    "gui",
    "nhac",
    "bao",
]
_SUMMARY_DISABLE_KEYWORDS = [
    "tat bao cao",
    "tat summary",
    "tat tong hop",
    "dung gui",
    "ngung gui",
    "ngung bao cao",
    "dung bao cao",
]
_SUMMARY_CONTENT_KEYWORDS = [
    "tong hop",
    "bao cao",
    "summary",
    "tien do",
    "cap nhat",
    "tong quan",
]
_SUMMARY_RECURRENCE_KEYWORDS = [
    "moi ngay",
    "hang ngay",
    "hang sang",
    "hang chieu",
    "hang toi",
    "luc ",
    "vao ",
]
_TIME_PATTERNS = [
    re.compile(r"(?<![\w-])(?P<hour>\d{1,2})\s*:\s*(?P<minute>\d{1,2})\s*(?P<suffix>am|pm|sang|chieu|toi|dem)?\b"),
    re.compile(r"(?<![\w-])(?P<hour>\d{1,2})\s*h(?:\s*(?P<minute>\d{1,2}))?\s*(?P<suffix>am|pm|sang|chieu|toi|dem)?\b"),
    re.compile(r"(?<![\w-])(?P<hour>\d{1,2})\s*gio(?:\s*(?P<minute>\d{1,2}))?\s*(?P<suffix>am|pm|sang|chieu|toi|dem)?\b"),
    re.compile(r"(?<![\w-])(?P<hour>\d{1,2})\s*(?P<suffix>am|pm)\b"),
]


def normalize_text(text):
    text = (text or "").strip().lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = text.replace("đ", "d")
    return " ".join(text.split())


def _contains_any(text, keywords):
    return any(keyword in text for keyword in keywords)


def _parse_period(text):
    if "hom nay" in text:
        return "today"
    if "hom qua" in text:
        return "yesterday"
    if "tuan nay" in text:
        return "this_week"
    if "thang nay" in text:
        return "this_month"
    return "current"


def _strip_project_tail(tail):
    tail = (tail or "").strip(" ,.:;-")
    previous = None
    while tail and tail != previous:
        previous = tail
        tail = _PROJECT_LEADING_FILLER_PATTERN.sub("", tail).strip(" ,.:;-")
    tail = _PROJECT_TRAILING_PERIOD_PATTERN.sub("", tail).strip(" ,.:;-")
    return " ".join(tail.split())


def _extract_project_ref(text):
    code_match = _PROJECT_CODE_PATTERN.search(text or "")
    if code_match:
        token = code_match.group(1)
        if not re.fullmatch(r"\d+(?:[-_]\d+)+", token):
            return token

    cue_match = _PROJECT_CUE_PATTERN.search(text or "")
    if not cue_match:
        return None

    project_tail = _strip_project_tail(cue_match.group("tail"))
    if project_tail in _GENERIC_PROJECT_TAILS:
        return None
    return project_tail or None


def _normalize_summary_time(hour, minute=0, suffix=None):
    hour = int(hour)
    minute = int(minute or 0)
    suffix = (suffix or "").strip().lower()

    if minute < 0 or minute > 59:
        return None

    if suffix in {"am", "sang"}:
        if hour == 12:
            hour = 0
    elif suffix in {"pm", "chieu", "toi"}:
        if hour < 12:
            hour += 12
    elif suffix == "dem" and hour == 12:
        hour = 0

    if hour < 0 or hour > 23:
        return None
    return f"{hour:02d}:{minute:02d}"


def extract_summary_time(text):
    normalized = normalize_text(text)
    for pattern in _TIME_PATTERNS:
        match = pattern.search(normalized or "")
        if not match:
            continue
        normalized_time = _normalize_summary_time(
            hour=match.group("hour"),
            minute=match.group("minute") or 0,
            suffix=match.group("suffix"),
        )
        if normalized_time:
            return normalized_time
    return None


def _is_summary_enable_request(normalized, summary_time=None):
    if normalized.startswith("/summary_on"):
        return True
    has_enable_keyword = _contains_any(normalized, _SUMMARY_ENABLE_KEYWORDS)
    has_content_keyword = _contains_any(normalized, _SUMMARY_CONTENT_KEYWORDS)
    has_recurrence_keyword = _contains_any(normalized, _SUMMARY_RECURRENCE_KEYWORDS)
    has_delivery_keyword = _contains_any(normalized, _SUMMARY_DELIVERY_KEYWORDS)
    return bool(
        has_content_keyword
        and (
            has_enable_keyword
            or (summary_time and has_delivery_keyword)
            or has_recurrence_keyword
        )
    )


def _is_summary_disable_request(normalized):
    if normalized.startswith("/summary_off"):
        return True
    return _contains_any(normalized, _SUMMARY_DISABLE_KEYWORDS)


def _intent_payload(intent, normalized_text, project_ref=None, period=None, match_strength="medium"):
    return {
        "intent": intent,
        "project_ref": project_ref,
        "period": period,
        "normalized_text": normalized_text,
        "classification_source": "rule",
        "match_strength": match_strength,
        "explicit_command": normalized_text.startswith("/"),
        "summary_time": None,
    }


def parse_message(text):
    normalized = normalize_text(text)
    period = _parse_period(normalized)
    project_ref = _extract_project_ref(normalized)
    summary_time = extract_summary_time(normalized)

    if normalized in {"/help", "help"}:
        return _intent_payload("help", normalized, period=None, match_strength="high")

    if normalized in {"/clear", "clear"}:
        return _intent_payload("clear_context", normalized, period=None, match_strength="high")

    if normalized in {"/summary_on", "summary on", "bat bao cao", "bat summary"} or _is_summary_enable_request(normalized, summary_time):
        payload = _intent_payload("summary_on", normalized, period=None, match_strength="high")
        payload["summary_time"] = summary_time
        return payload

    if normalized in {"/summary_off", "summary off", "tat bao cao", "tat summary"} or _is_summary_disable_request(normalized):
        return _intent_payload("summary_off", normalized, period=None, match_strength="high")

    if _contains_any(normalized, ["tre han", "qua han", "overdue"]):
        return _intent_payload("overdue_tasks", normalized, period=period, match_strength="medium")

    if _contains_any(normalized, ["task cua toi", "viec cua toi", "cong viec cua toi", "task toi", "viec toi"]):
        return _intent_payload("my_tasks", normalized, period=period, match_strength="medium")

    if _contains_any(normalized, ["tong hop", "hom nay", "bao cao hom nay", "task hom nay"]) and not (
        project_ref or "project" in normalized or "du an" in normalized
    ):
        return _intent_payload(
            "today_summary",
            normalized,
            period=period if period != "current" else "today",
            match_strength="medium",
        )

    if _contains_any(normalized, ["risk", "rui ro", "nguy co", "project nao dang do", "du an nao dang do"]):
        return _intent_payload("projects_at_risk", normalized, period=period, match_strength="medium")

    if _contains_any(normalized, ["tong quan du an", "tong hop du an", "tong quan portfolio", "tong quan project", "portfolio"]):
        return _intent_payload("portfolio_summary", normalized, period=period, match_strength="medium")

    if _contains_any(normalized, ["blocker", "vuong mac", "dang vuong", "dang bi vuong", "task bi vuong"]):
        return _intent_payload(
            "project_blockers" if project_ref else "projects_at_risk",
            normalized,
            project_ref=project_ref,
            period=period,
            match_strength="medium",
        )

    if _contains_any(normalized, ["budget", "ngan sach", "chi phi", "cost"]) and (
        project_ref or "project" in normalized or "du an" in normalized
    ):
        return _intent_payload(
            "project_budget",
            normalized,
            project_ref=project_ref,
            period=period,
            match_strength="medium",
        )

    if _contains_any(normalized, [
        "tat ca task",
        "danh sach task",
        "list task",
        "xem task",
        "xem tat ca task",
        "toan bo task",
        "task trong account",
        "task co trong account",
        "task trong tai khoan",
    ]):
        return _intent_payload("all_tasks", normalized, period=period, match_strength="medium")

    if _contains_any(normalized, ["task cua project", "task du an", "task trong project", "task trong du an"]):
        return _intent_payload(
            "project_tasks",
            normalized,
            project_ref=project_ref,
            period=period,
            match_strength="medium",
        )

    if project_ref or "project" in normalized or "du an" in normalized:
        return _intent_payload(
            "project_status",
            normalized,
            project_ref=project_ref,
            period=period,
            match_strength="low",
        )

    if "task" in normalized:
        return _intent_payload("all_tasks", normalized, period=period, match_strength="low")

    return _intent_payload("help", normalized, period=None, match_strength="low")
