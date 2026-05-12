"""
SQL Engine: Text-to-SQL dùng model gpt-oss-20b (OpenAI-compatible API).

Flow:
  1. LLM (gpt-oss-20b) nhận câu hỏi + schema → sinh SQL
  2. Validator kiểm tra SQL an toàn (chỉ SELECT, bảng được phép)
  3. Security inject WHERE theo role (không thể bypass)
  4. Execute trên Odoo PostgreSQL
  5. Trả về dict với columns, rows, count
"""
import re

from openai import OpenAI

from core.config import cfg
from core.database import db_cursor
from core.schema_context import SCHEMA_CONTEXT, ROLE_WHERE_TEMPLATES

# ── OpenAI-compatible client trỏ tới https://apimodel.berp.vn/v1 ─────────────
_llm = OpenAI(
    api_key=cfg.LLM_API_KEY,
    base_url=cfg.LLM_BASE_URL,
)

# Các bảng hợp lệ (lowercase)
_ALLOWED_TABLES = {
    "bb_project",
    "bb_project_task",
    "bb_project_backlog",
    "bb_project_member",
    "bb_project_member_rate",
    "bb_project_scope",
    "bb_project_milestone",
    "bb_project_tag",
    "res_users",
    "res_partner",
}

# Keyword nguy hiểm tuyệt đối không cho qua
_FORBIDDEN = [
    "drop", "delete", "update", "insert", "truncate",
    "alter", "create", "exec", "execute", "pg_", "information_schema",
    "--", "/*", "xp_",
]


# ─── Validator ────────────────────────────────────────────────────────────────

def _validate(sql: str) -> tuple[bool, str]:
    """
    Kiểm tra SQL trước khi chạy.
    Trả về (ok, error_message).
    """
    sql_stripped = sql.strip()
    sql_upper    = sql_stripped.upper()

    # Phải bắt đầu bằng SELECT
    if not sql_upper.startswith("SELECT"):
        return False, "Chỉ cho phép câu SELECT."

    # Kiểm tra keyword nguy hiểm
    for kw in _FORBIDDEN:
        if kw in sql_stripped.lower():
            return False, f"Không cho phép từ khoá: '{kw}'."

    # Kiểm tra các bảng được dùng có hợp lệ không
    tables_in_sql = set(re.findall(
        r'\b(?:FROM|JOIN)\s+(\w+)',
        sql_upper,
    ))
    unknown = tables_in_sql - {t.upper() for t in _ALLOWED_TABLES}
    if unknown:
        return False, f"Bảng không được phép: {unknown}."

    return True, ""


# ─── Security WHERE injection ─────────────────────────────────────────────────

def _inject_security(sql: str, user_id: int, role: str) -> str:
    """
    Append role-based WHERE vào SQL.
    Chạy sau validate, trước execute.
    LLM không thể bỏ qua bước này.
    """
    template = ROLE_WHERE_TEMPLATES.get(role, "")
    if not template:
        return sql  # admin: không filter thêm

    clause = template.format(uid=user_id)

    sql_upper = sql.upper()

    # Nếu đã có WHERE → thêm AND vào sau WHERE
    if "WHERE" in sql_upper:
        where_pos = sql_upper.index("WHERE") + len("WHERE")
        return sql[:where_pos] + " " + clause.lstrip("AND").lstrip() + " AND " + sql[where_pos:]

    # Chưa có WHERE → chèn trước ORDER/GROUP/LIMIT/HAVING hoặc cuối câu
    for keyword in ("ORDER BY", "GROUP BY", "HAVING", "LIMIT"):
        if keyword in sql_upper:
            pos = sql_upper.index(keyword)
            clean = clause.lstrip("AND").lstrip()
            return sql[:pos] + f"\nWHERE {clean}\n" + sql[pos:]

    # Không có các keyword trên → append vào cuối
    clean = clause.lstrip("AND").lstrip()
    return sql.rstrip("; ") + f"\nWHERE {clean}"


# ─── LLM: sinh SQL từ câu hỏi ────────────────────────────────────────────────

def _generate_sql(question: str, max_rows: int = 50) -> str:
    """
    Gọi gpt-oss-20b để convert câu hỏi → SQL.
    Trả về SQL string thuần túy (đã strip markdown).
    """
    system_prompt = (
        f"{SCHEMA_CONTEXT}\n\n"
        "Chỉ trả về câu SQL thuần túy.\n"
        "Không có markdown (```), không giải thích, không text thừa.\n"
        f"Luôn có LIMIT {max_rows} trừ khi câu hỏi yêu cầu khác."
    )

    response = _llm.chat.completions.create(
        model=cfg.LLM_MODEL,
        temperature=cfg.LLM_TEMP,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": f"Viết SQL để trả lời: {question}"},
        ],
        max_tokens=512,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
    )

    raw = response.choices[0].message.content.strip()

    # Strip markdown code block nếu model vẫn thêm vào
    raw = re.sub(r"```sql\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"```",       "", raw)

    # Nếu model trả về thinking text, extract phần SELECT
    # Tìm SELECT đầu tiên đến hết câu (kết thúc bằng ';' hoặc cuối string)
    match = re.search(r"(SELECT\s.+?)(?:;|\Z)", raw, re.DOTALL | re.IGNORECASE)
    if match:
        raw = match.group(1).strip()

    return raw.strip()


# ─── Public API ───────────────────────────────────────────────────────────────

def text_to_sql_and_run(
    question: str,
    user_id: int,
    role: str,
    max_rows: int = 50,
) -> dict:
    """
    Convert câu hỏi → SQL → execute an toàn trên Odoo DB.

    Trả về:
        {
            "columns": [...],
            "rows":    [...],   # list of dicts
            "count":   int,
            "sql":     str,     # SQL đã inject security (để debug)
        }
    hoặc:
        {
            "error": "...",
            "sql":   str,
        }
    """
    # Bước 1: Sinh SQL
    try:
        sql = _generate_sql(question, max_rows)
    except Exception as e:
        return {"error": f"LLM error: {e}", "sql": ""}

    if cfg.DEBUG:
        print(f"[SQL Engine] Generated SQL:\n{sql}")

    # Bước 2: Validate
    ok, err = _validate(sql)
    if not ok:
        return {"error": f"SQL không hợp lệ: {err}", "sql": sql}

    # Bước 3: Inject security WHERE
    safe_sql = _inject_security(sql, user_id, role)

    if cfg.DEBUG:
        print(f"[SQL Engine] Safe SQL (after security inject):\n{safe_sql}")

    # Bước 4: Execute
    try:
        with db_cursor() as cur:
            cur.execute(safe_sql)
            rows    = cur.fetchall()
            columns = [desc[0] for desc in cur.description] if cur.description else []
            return {
                "columns": columns,
                "rows":    [dict(r) for r in rows],
                "count":   len(rows),
                "sql":     safe_sql,
            }
    except Exception as e:
        return {"error": f"DB error: {e}", "sql": safe_sql}
