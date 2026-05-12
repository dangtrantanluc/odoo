"""
Intent Classifier: phân loại câu hỏi để chọn đúng execution path.

Kết quả:
  "simple_query"  → Text-to-SQL trực tiếp (nhanh, rẻ)
  "complex"       → ReAct full loop (chính xác hơn, đa bước)

Chiến lược 2 tầng:
  1. Rule-based keywords (không tốn API, < 1ms)
  2. Nếu chưa chắc → gọi LLM với Haiku-level prompt (max_tokens=5)
"""
from openai import OpenAI

from core.config import cfg

_llm = OpenAI(
    api_key=cfg.LLM_API_KEY,
    base_url=cfg.LLM_BASE_URL,
)

# Keywords → simple_query (chỉ cần lấy data, không cần reasoning)
_SIMPLE_KEYWORDS = [
    "danh sách", "liệt kê", "list", "cho tôi xem",
    "có bao nhiêu", "tổng số", "đếm",
    "task của tôi", "việc của tôi",
    "hôm nay", "tuần này", "tháng này",
    "trạng thái", "status",
    "deadline", "đến hạn",
    "ai đang làm", "assigned",
    "backlog", "work log",
]

# Keywords → complex (cần reasoning, nhiều bước, phân tích)
_COMPLEX_KEYWORDS = [
    "phân tích", "so sánh", "tại sao", "nguyên nhân",
    "ước tính", "estimate", "dự báo", "forecast",
    "có hợp lý không", "nên làm gì", "tư vấn", "đề xuất",
    "tổng hợp", "báo cáo", "summary",
    "budget có đủ không", "vượt budget", "rủi ro",
]


def classify(question: str) -> str:
    """
    Phân loại intent của câu hỏi.
    Trả về "simple_query" hoặc "complex".
    """
    q = question.lower().strip()

    # ── Tầng 1: rule-based (không tốn API) ──
    has_simple  = any(kw in q for kw in _SIMPLE_KEYWORDS)
    has_complex = any(kw in q for kw in _COMPLEX_KEYWORDS)

    # Rõ ràng là complex
    if has_complex:
        return "complex"

    # Rõ ràng là simple, không có từ khóa complex nào
    if has_simple and not has_complex:
        return "simple_query"

    # ── Tầng 2: hỏi LLM (chỉ khi rule-based chưa chắc) ──
    try:
        response = _llm.chat.completions.create(
            model=cfg.LLM_MODEL,
            temperature=0,
            max_tokens=5,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Phân loại câu hỏi về quản lý dự án. "
                        "Trả về đúng 1 từ: 'simple' hoặc 'complex'.\n"
                        "'simple'  = chỉ cần lấy data (list, count, filter)\n"
                        "'complex' = cần phân tích, ước tính, so sánh, nhiều bước"
                    ),
                },
                {"role": "user", "content": f"Câu hỏi: {question}"},
            ],
        )
        answer = response.choices[0].message.content.strip().lower()
        return "simple_query" if "simple" in answer else "complex"

    except Exception:
        # Nếu LLM lỗi → fallback về complex (an toàn hơn)
        return "complex"
