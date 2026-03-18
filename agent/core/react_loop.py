"""
ReAct Loop: prompt-based approach (không dùng OpenAI function calling).

Vì server không hỗ trợ --enable-auto-tool-choice, ta dùng ReAct cổ điển:
  LLM output format:
    Thought: <lý do>
    Action: <tool_name>
    Input: <json>
    --- hoặc ---
    Final Answer: <câu trả lời>

Flow:
  1. Lấy history từ Redis (working memory)
  2. Retrieve long-term memories → inject vào system prompt
  3. Gọi LLM → parse output → execute tool → tiếp tục
  4. Khi LLM output "Final Answer" → trả kết quả
  5. Cập nhật working memory + trigger memory extraction
"""
import json
import re
import threading

from openai import OpenAI

from core.config import cfg
from core.schema_context import SCHEMA_CONTEXT
from core.tools import execute_tool
from memory import manager as mem

_llm = OpenAI(
    api_key=cfg.LLM_API_KEY,
    base_url=cfg.LLM_BASE_URL,
)

# Mô tả tools dạng text để inject vào prompt
_TOOLS_DESCRIPTION = """
## Các tools có thể dùng

1. **sql_query** — Truy vấn data bằng câu hỏi tự nhiên
   Input: {"question": "câu hỏi cụ thể"}

2. **get_scope_with_rates** — Lấy scope items + rate thành viên của project
   Input: {"project_id": <int>}

3. **get_deadline_alerts** — Tasks sắp đến hạn
   Input: {"days_ahead": <int, mặc định 3>, "target_user_id": <int, tuỳ chọn>}

4. **get_budget_warnings** — Projects có nguy cơ vượt budget
   Input: {"threshold_pct": <float, mặc định 20>}

5. **calculate_estimate** — Tính estimated cost từ scope items
   Input: {"scope_items": [{"name": "...", "hours": N, "rate": N}], "buffer_pct": 15}
"""

_SYSTEM_TEMPLATE = """\
Bạn là BB Project Management AI Assistant của BlueBolt.
Vai trò người dùng: **{role}**

{schema}

{tools_desc}

{memory_ctx}

## Cách trả lời (BẮT BUỘC tuân theo format)

Nếu cần lấy thêm thông tin, output:
```
Thought: <lý do cần tool>
Action: <tên tool>
Input: <JSON input>
```

Khi đã đủ thông tin, output:
```
Final Answer: <câu trả lời đầy đủ bằng tiếng Việt>
```

Quy tắc:
- Tiếng Việt, format rõ ràng (dùng bullet/bảng khi phù hợp)
- Số tiền: VND có dấu phẩy (ví dụ: 1,500,000 VND)
- Ngày tháng: DD/MM/YYYY
- KHÔNG bịa số liệu — nếu không có data thì nói rõ
- Luôn kết thúc bằng "Final Answer:"
"""


def _parse_action(text: str):
    """
    Parse LLM output để tìm Action + Input.
    Trả về (tool_name, tool_input_dict) hoặc (None, None) nếu không tìm thấy.
    """
    # Tìm Action: ... và Input: ...
    action_match = re.search(r"Action\s*:\s*(\w+)", text, re.IGNORECASE)
    input_match  = re.search(r"Input\s*:\s*(\{.*?\})", text, re.DOTALL | re.IGNORECASE)

    if not action_match:
        return None, None

    tool_name = action_match.group(1).strip()

    tool_input = {}
    if input_match:
        try:
            tool_input = json.loads(input_match.group(1))
        except json.JSONDecodeError:
            # Thử làm sạch JSON bị lỗi format
            raw = input_match.group(1)
            raw = re.sub(r",\s*}", "}", raw)   # trailing comma
            raw = re.sub(r"'", '"', raw)        # single → double quotes
            try:
                tool_input = json.loads(raw)
            except Exception:
                tool_input = {}

    return tool_name, tool_input


def _extract_final_answer(text: str) -> str | None:
    """Trích Final Answer từ output nếu có."""
    match = re.search(r"Final Answer\s*:\s*(.*)", text, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return None


def run(
    user_query: str,
    user_id: int,
    role: str,
    session_id: str,
) -> str:
    """
    Chạy ReAct loop cho một câu hỏi.
    Trả về câu trả lời cuối cùng.
    """
    # ── Bước 1: Lấy history từ working memory ────────────────────────
    history: list[dict] = mem.wm_get(session_id, "history") or []

    # ── Bước 2: Retrieve long-term memories ──────────────────────────
    memory_ctx = mem.build_memory_context(user_query, user_id)

    # ── Bước 3: System prompt ─────────────────────────────────────────
    system = _SYSTEM_TEMPLATE.format(
        role=role,
        schema=SCHEMA_CONTEXT,
        tools_desc=_TOOLS_DESCRIPTION,
        memory_ctx=memory_ctx,
    )

    # ── Bước 4: Build messages ────────────────────────────────────────
    messages: list[dict] = [{"role": "system", "content": system}]

    for turn in history[-6:]:
        messages.append({"role": turn["role"], "content": turn["content"]})

    messages.append({"role": "user", "content": user_query})

    # ── Bước 5: ReAct loop ────────────────────────────────────────────
    final_text   = "Xin lỗi, tôi không thể xử lý yêu cầu này."
    tool_call_log = []

    for iteration in range(cfg.MAX_ITER):
        if cfg.DEBUG:
            print(f"\n[ReAct] Iteration {iteration + 1}/{cfg.MAX_ITER}")

        response = _llm.chat.completions.create(
            model=cfg.LLM_MODEL,
            temperature=cfg.LLM_TEMP,
            messages=messages,
            max_tokens=1024,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )

        output = response.choices[0].message.content or ""

        if cfg.DEBUG:
            print(f"[ReAct] Output:\n{output[:400]}")

        # Kiểm tra Final Answer
        answer = _extract_final_answer(output)
        if answer:
            final_text = answer
            break

        # Kiểm tra Action
        tool_name, tool_input = _parse_action(output)

        if not tool_name:
            # Không có action và không có final answer → coi toàn bộ output là answer
            final_text = output.strip()
            break

        # Execute tool
        result_str = execute_tool(
            tool_name=tool_name,
            tool_input=tool_input,
            user_id=user_id,
            role=role,
        )

        if cfg.DEBUG:
            print(f"  → Tool: {tool_name}({tool_input})")
            print(f"  → Result: {result_str[:200]}")

        tool_call_log.append({
            "tool":   tool_name,
            "input":  tool_input,
            "output": result_str[:300],
        })

        # Thêm observation vào conversation
        messages.append({"role": "assistant", "content": output})
        messages.append({
            "role":    "user",
            "content": f"Observation:\n{result_str}\n\nTiếp tục phân tích và đưa ra kết luận.",
        })

    # ── Bước 6: Cập nhật working memory ──────────────────────────────
    history.append({"role": "user",      "content": user_query})
    history.append({"role": "assistant", "content": final_text})
    mem.wm_set(session_id, "history", history[-10:])

    # ── Bước 7: Extract & store memories (background) ─────────────────
    if tool_call_log:
        threading.Thread(
            target=mem.extract_and_store,
            kwargs={
                "session_id": session_id,
                "user_id":    user_id,
                "turns": [
                    {"role": "user",      "content": user_query},
                    {"role": "assistant", "content": final_text},
                ],
                "outcome": final_text,
            },
            daemon=True,
        ).start()

    return final_text
