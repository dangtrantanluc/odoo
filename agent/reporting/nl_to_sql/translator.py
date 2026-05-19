"""Natural-language → SQL translator (read-only reporting).

Ports bb-pm-tools/src/reporting/nl-to-sql/translator.ts (schema-doc path; the
OpenSearch knowledge base is omitted). Generated SQL is SELECT-only, scoped to
the caller's company, executed via the bb-pm `report.query` endpoint, with one
repair attempt on execution error.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Optional

from core.logging import log_event
from infrastructure.bbpm_client import BbPmClient
from infrastructure.llm_client import LlmClient

MAX_QUESTION_LEN = 1000
_SCOPED_TABLES = {
    "projects", "tasks", "users", "customers", "companies",
    "agent_audit_log", "agent_memory", "agent_follow_ups", "automations", "backlogs",
}
_MUTATION = re.compile(r"\b(insert|update|delete|drop|alter|truncate)\b", re.IGNORECASE)
_TABLES = re.compile(r"\b(?:from|join)\s+([a-z_][a-z0-9_]*)", re.IGNORECASE)
_COMPANY_SCOPE = re.compile(r"\bcompany_id\s*=\s*(\d+)", re.IGNORECASE)


def extract_tables(sql: str) -> list[str]:
    return [m.group(1).lower() for m in _TABLES.finditer(sql)]


def validate_generated_sql(sql: str, company_id: int) -> list[str]:
    errors: list[str] = []
    if not re.match(r"^\s*select\b", sql, re.IGNORECASE):
        errors.append("not_select")
    if _MUTATION.search(sql):
        errors.append("contains_mutation")
    tables = extract_tables(sql)
    scope = _COMPANY_SCOPE.search(sql)
    if any(t in _SCOPED_TABLES for t in tables) and not scope:
        errors.append("missing_company_scope")
    if scope and int(scope.group(1)) != company_id:
        errors.append("wrong_company_scope")
    return errors


def _base_rules(company_id: int, user_id: Optional[int]) -> str:
    return (
        "Bạn là SQL writer cho bb-pm Postgres database. Dịch câu hỏi thành 1 SELECT an toàn.\n"
        "QUY TẮC:\n"
        '1. Output JSON: {"sql":"<SELECT>","explanation":"<1 câu>"}.\n'
        "2. CHỈ SELECT; không DML/DDL.\n"
        f"3. Mọi bảng có company_id phải scope company_id = {company_id}.\n"
        f"4. Caller user_id = {user_id if user_id is not None else '(unknown)'}.\n"
        "5. snake_case; không SELECT *; LIMIT 50 nếu không aggregate.\n"
        "6. Overdue = status != 'DONE' AND deadline < NOW(); "
        "stale = updated_at < NOW() - INTERVAL '7 days'.\n"
        "7. Trả JSON thuần, không markdown."
    )


def _parse_json_loose(raw: str) -> dict[str, Any]:
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        pass
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError(f"translator output not valid JSON: {raw[:200]}")


def _parse_sql_payload(raw: str) -> tuple[str, Optional[str]]:
    parsed = _parse_json_loose(raw)
    sql = parsed.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        raise ValueError(f"translator output missing sql: {raw[:200]}")
    return sql.strip(), parsed.get("explanation")


class NlToSqlTranslator:
    def __init__(self, bbpm: BbPmClient, llm: LlmClient) -> None:
        self._bbpm = bbpm
        self._llm = llm
        self._schema_doc: Optional[str] = None
        self._schema_fetched_at = 0.0

    async def _schema(self) -> str:
        if self._schema_doc and (time.time() - self._schema_fetched_at) < 600:
            return self._schema_doc
        data = await self._bbpm.report_schema()
        self._schema_doc = data.get("schema", "") if isinstance(data, dict) else str(data)
        self._schema_fetched_at = time.time()
        return self._schema_doc

    async def _generate(self, question: str, system: str) -> tuple[str, Optional[str]]:
        res = await self._llm.chat(
            [{"role": "system", "content": system},
             {"role": "user", "content": question.strip()}],
            temperature=0.1, max_tokens=1200, response_format={"type": "json_object"},
        )
        return _parse_sql_payload(res.content or "")

    async def run(
        self, question: str, company_id: int, user_id: Optional[int] = None
    ) -> str:
        """Translate, validate, execute, repair once on error. Return VN text."""
        if not question or len(question) > MAX_QUESTION_LEN:
            return "Câu hỏi rỗng hoặc quá dài."
        schema = await self._schema()
        if not schema:
            return "Chưa lấy được schema để tra cứu, bạn thử lại sau nhé."

        system = f"{_base_rules(company_id, user_id)}\n\nSCHEMA REFERENCE:\n{schema}"
        try:
            sql, _ = await self._generate(question, system)
        except (ValueError, Exception) as err:  # noqa: BLE001
            log_event("nl_to_sql.generate_failed", level="warning", error=str(err))
            return "Mình chưa dịch được câu hỏi này thành truy vấn, bạn hỏi rõ hơn nhé."

        errors = validate_generated_sql(sql, company_id)
        if "not_select" in errors or "contains_mutation" in errors:
            log_event("nl_to_sql.rejected", level="warning", errors=errors, sql=sql[:200])
            return "Mình chỉ hỗ trợ truy vấn đọc dữ liệu, không thực hiện thay đổi."
        if "missing_company_scope" in errors or "wrong_company_scope" in errors:
            log_event("nl_to_sql.scope_violation", level="warning", errors=errors)
            return "Truy vấn không hợp lệ về phạm vi công ty, mình không chạy được."

        try:
            result = await self._bbpm.report_query(sql)
        except Exception as err:  # noqa: BLE001 — one repair attempt
            repaired = await self._repair(question, sql, str(err), system)
            if repaired is None:
                return "Truy vấn gặp lỗi khi chạy, bạn thử hỏi cách khác nhé."
            try:
                result = await self._bbpm.report_query(repaired)
            except Exception:  # noqa: BLE001
                return "Truy vấn gặp lỗi khi chạy, bạn thử hỏi cách khác nhé."

        return _format_rows(result)

    async def _repair(
        self, question: str, previous_sql: str, error: str, system: str
    ) -> Optional[str]:
        repair_system = (
            f"{system}\n\nSQL trước bị lỗi:\n{previous_sql}\n\n"
            f"Lỗi backend:\n{error}\n\nSửa SQL, trả JSON thuần."
        )
        try:
            sql, _ = await self._generate(question, repair_system)
        except Exception:  # noqa: BLE001
            return None
        errors = validate_generated_sql(sql, _company_from(system))
        if "not_select" in errors or "contains_mutation" in errors:
            return None
        return sql


def _company_from(system: str) -> int:
    match = re.search(r"company_id = (\d+)", system)
    return int(match.group(1)) if match else -1


def _format_rows(result: Any) -> str:
    rows = result.get("rows") if isinstance(result, dict) else result
    if not rows:
        return "Không có dữ liệu khớp câu hỏi của bạn."
    if not isinstance(rows, list):
        return str(rows)
    lines = [f"Tìm thấy {len(rows)} kết quả:", ""]
    for row in rows[:20]:
        if isinstance(row, dict):
            lines.append("• " + " | ".join(f"{k}: {v}" for k, v in row.items()))
        else:
            lines.append(f"• {row}")
    if len(rows) > 20:
        lines.append(f"… và {len(rows) - 20} dòng nữa.")
    return "\n".join(lines)
