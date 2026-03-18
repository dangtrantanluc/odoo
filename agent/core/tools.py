"""
Tools Registry: định nghĩa tool cho LLM + implementations thực thi.

Mỗi tool gồm 2 phần:
  1. TOOL_DEFINITIONS  — JSON schema mô tả tool cho OpenAI function calling
  2. execute_tool()    — dispatcher gọi function Python thực tế

LLM đọc TOOL_DEFINITIONS để biết khi nào và cách gọi tool.
execute_tool() thực thi và luôn trả về string (LLM chỉ đọc được text).
"""
from datetime import date, timedelta

from core.config import cfg
from core.database import db_cursor
from core.sql_engine import text_to_sql_and_run

# ─── 1. Tool definitions cho OpenAI function calling ─────────────────────────

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "sql_query",
            "description": (
                "Truy vấn dữ liệu dự án bằng ngôn ngữ tự nhiên — tự động sinh SQL. "
                "Dùng khi cần: danh sách task/dự án, thống kê, filter theo điều kiện cụ thể. "
                "KHÔNG dùng cho phân tích đa bước hay ước tính."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "Câu hỏi tiếng Việt về dữ liệu cần lấy",
                    }
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_scope_with_rates",
            "description": (
                "Lấy scope items của project kèm rate của từng thành viên. "
                "Dùng khi bắt đầu quy trình estimate cost."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {
                        "type": "integer",
                        "description": "ID của project cần xem scope",
                    }
                },
                "required": ["project_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_deadline_alerts",
            "description": (
                "Lấy danh sách tasks sắp đến deadline. "
                "Dùng khi cần tạo thông báo hoặc kiểm tra lịch làm việc."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": {
                        "type": "integer",
                        "description": "Số ngày nhìn trước (mặc định 3)",
                    },
                    "target_user_id": {
                        "type": "integer",
                        "description": "Lọc theo user cụ thể. Bỏ trống = theo role filter.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_budget_warnings",
            "description": (
                "Lấy danh sách project đang có nguy cơ vượt budget. "
                "Dùng khi manager muốn kiểm soát tài chính."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "threshold_pct": {
                        "type": "number",
                        "description": "Cảnh báo khi budget còn dưới X% (mặc định 20)",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate_estimate",
            "description": (
                "Tính estimated cost từ scope items. "
                "Gọi SAU khi đã có data từ get_scope_with_rates."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "scope_items": {
                        "type": "array",
                        "description": "List scope items với hours và rate",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name":  {"type": "string"},
                                "hours": {"type": "number"},
                                "rate":  {"type": "number"},
                            },
                        },
                    },
                    "buffer_pct": {
                        "type": "number",
                        "description": "% buffer thêm vào để dự phòng (mặc định 15)",
                    },
                },
                "required": ["scope_items"],
            },
        },
    },
]


# ─── 2. Dispatcher ────────────────────────────────────────────────────────────

def execute_tool(
    tool_name: str,
    tool_input: dict,
    user_id: int,
    role: str,
) -> str:
    """
    Nhận tên tool + input từ LLM, gọi function tương ứng.
    Luôn trả về string — LLM chỉ hiểu text.
    """
    try:
        if tool_name == "sql_query":
            return _run_sql_query(tool_input["question"], user_id, role)

        if tool_name == "get_scope_with_rates":
            return _get_scope_with_rates(tool_input["project_id"])

        if tool_name == "get_deadline_alerts":
            return _get_deadline_alerts(
                days_ahead=int(tool_input.get("days_ahead") or 3),
                target_user_id=tool_input.get("target_user_id"),
                caller_user_id=user_id,
                role=role,
            )

        if tool_name == "get_budget_warnings":
            return _get_budget_warnings(
                threshold_pct=float(tool_input.get("threshold_pct") or 20),
                caller_user_id=user_id,
                role=role,
            )

        if tool_name == "calculate_estimate":
            return _calculate_estimate(
                scope_items=tool_input["scope_items"],
                buffer_pct=float(tool_input.get("buffer_pct") or 15),
            )

        return f"Tool '{tool_name}' không tồn tại."

    except Exception as e:
        return f"Tool error [{tool_name}]: {e}"


# ─── 3. Tool implementations ──────────────────────────────────────────────────

def _run_sql_query(question: str, user_id: int, role: str) -> str:
    result = text_to_sql_and_run(question=question, user_id=user_id, role=role)

    if "error" in result:
        return f"Lỗi truy vấn: {result['error']}"

    rows = result["rows"]
    if not rows:
        return "Không tìm thấy dữ liệu phù hợp."

    # Format thành bảng text
    cols  = result["columns"]
    lines = [" | ".join(cols)]
    lines.append("-" * len(lines[0]))
    for row in rows[:20]:
        lines.append(" | ".join(str(v) if v is not None else "" for v in row.values()))

    footer = f"\nTổng: {result['count']} dòng"
    if result["count"] > 20:
        footer += f" (hiển thị 20/{result['count']})"

    return "\n".join(lines) + footer


def _get_scope_with_rates(project_id: int) -> str:
    with db_cursor() as cur:
        cur.execute("""
            SELECT
                s.name                              AS scope_item,
                rp.name                             AS assignee,
                COALESCE(m.role, 'chưa xác định')  AS role,
                COALESCE(s.estimated_hours, 0)      AS hours,
                COALESCE(
                    (SELECT r.cost_per_hour
                     FROM bb_project_member_rate r
                     WHERE r.member_id = m.id
                     ORDER BY r.effective_from DESC
                     LIMIT 1),
                    s.estimated_rate, 0
                )                                   AS rate_per_hour,
                COALESCE(s.estimated_cost, 0)       AS estimated_cost
            FROM bb_project_scope s
            LEFT JOIN res_users u    ON u.id = s.assignee_id
            LEFT JOIN res_partner rp ON rp.id = u.partner_id
            LEFT JOIN bb_project_member m
                ON m.project_id = s.project_id AND m.user_id = s.assignee_id
            WHERE s.project_id = %s
            ORDER BY s.estimated_cost DESC NULLS LAST
        """, (project_id,))
        rows = cur.fetchall()

    if not rows:
        return f"Không tìm thấy scope items cho project ID={project_id}."

    lines = [
        "Scope Item | Người thực hiện | Role | Giờ | Rate (VND/h) | Chi phí ước tính",
        "-" * 85,
    ]
    total_hours = total_cost = 0
    missing_rate = []

    for r in rows:
        hours = float(r["hours"] or 0)
        rate  = float(r["rate_per_hour"] or 0)
        cost  = float(r["estimated_cost"] or 0)
        total_hours += hours
        total_cost  += cost
        if rate == 0:
            missing_rate.append(r["scope_item"])
        lines.append(
            f"{r['scope_item']} | {r['assignee'] or 'Chưa assign'} | "
            f"{r['role']} | {hours:.1f}h | {rate:,.0f} | {cost:,.0f} VND"
        )

    lines.append("-" * 85)
    lines.append(f"TỔNG | | | {total_hours:.1f}h | | {total_cost:,.0f} VND")

    if missing_rate:
        lines.append(f"\n⚠️  Chưa có rate: {', '.join(missing_rate)}")

    return "\n".join(lines)


def _get_deadline_alerts(
    days_ahead: int,
    target_user_id,
    caller_user_id: int,
    role: str,
) -> str:
    today  = date.today()
    cutoff = today + timedelta(days=days_ahead)

    # Member chỉ thấy task của chính mình
    if role == "member":
        filter_uid = caller_user_id
    else:
        filter_uid = int(target_user_id) if target_user_id else None

    params     = [today, cutoff]
    extra_where = ""
    if filter_uid:
        extra_where = "AND t.assignee_id = %s"
        params.append(filter_uid)

    with db_cursor() as cur:
        cur.execute(f"""
            SELECT
                p.name                              AS project,
                t.name                              AS task,
                t.status,
                t.priority,
                t.deadline,
                rp.name                             AS assignee,
                (t.deadline - CURRENT_DATE)         AS days_left
            FROM bb_project_task t
            JOIN bb_project p        ON p.id = t.project_id
            LEFT JOIN res_users u    ON u.id = t.assignee_id
            LEFT JOIN res_partner rp ON rp.id = u.partner_id
            WHERE t.deadline BETWEEN %s AND %s
              AND t.status NOT IN ('done', 'cancelled')
              {extra_where}
            ORDER BY t.deadline ASC, t.priority DESC
        """, params)
        rows = cur.fetchall()

    if not rows:
        return f"✅ Không có task nào đến hạn trong {days_ahead} ngày tới."

    lines = [f"⚠️  Tasks đến hạn trong {days_ahead} ngày (tính từ {today.strftime('%d/%m/%Y')}):\n"]
    for r in rows:
        days = int(r["days_left"])
        if days <= 0:
            icon = "🔴 QUÁ HẠN"
        elif days <= 1:
            icon = "🔴"
        elif days <= 3:
            icon = "🟡"
        else:
            icon = "🟢"

        lines.append(
            f"{icon} [{r['project']}] {r['task']}\n"
            f"     Người làm: {r['assignee'] or 'Chưa assign'} | "
            f"Deadline: {r['deadline'].strftime('%d/%m/%Y')} "
            f"(còn {days} ngày) | "
            f"Ưu tiên: {r['priority']}"
        )

    return "\n".join(lines)


def _get_budget_warnings(threshold_pct: float, caller_user_id: int, role: str) -> str:
    params      = [threshold_pct / 100]
    extra_where = ""

    # Manager chỉ thấy project của mình
    if role == "manager":
        extra_where = "AND p.owner_id = %s"
        params.append(caller_user_id)

    with db_cursor() as cur:
        cur.execute(f"""
            SELECT
                p.name,
                p.budget,
                p.total_cost,
                p.budget_remaining,
                ROUND(
                    (p.budget_remaining::numeric / NULLIF(p.budget, 0)) * 100,
                    1
                )           AS pct_remaining,
                rp.name     AS owner
            FROM bb_project p
            JOIN res_users u    ON u.id = p.owner_id
            JOIN res_partner rp ON rp.id = u.partner_id
            WHERE p.status = 'in_progress'
              AND p.budget > 0
              AND (p.budget_remaining::numeric / NULLIF(p.budget, 0)) < %s
              {extra_where}
            ORDER BY pct_remaining ASC
        """, params)
        rows = cur.fetchall()

    if not rows:
        return f"✅ Không có project nào có budget còn dưới {threshold_pct:.0f}%."

    lines = [f"💰 Cảnh báo budget (ngưỡng < {threshold_pct:.0f}% còn lại):\n"]
    for r in rows:
        pct = float(r["pct_remaining"] or 0)
        icon = "🔴" if pct < 5 else "🟡"
        lines.append(
            f"{icon} {r['name']} (owner: {r['owner']})\n"
            f"     Budget: {float(r['budget']):>15,.0f} VND\n"
            f"     Đã dùng: {float(r['total_cost']):>14,.0f} VND\n"
            f"     Còn lại: {float(r['budget_remaining']):>14,.0f} VND ({pct}%)"
        )

    return "\n".join(lines)


def _calculate_estimate(scope_items: list, buffer_pct: float) -> str:
    if not scope_items:
        return "Không có scope items để tính estimate."

    subtotal    = sum(
        float(i.get("hours", 0)) * float(i.get("rate", 0))
        for i in scope_items
    )
    total_hours = sum(float(i.get("hours", 0)) for i in scope_items)
    buffer_amt  = subtotal * (buffer_pct / 100)
    total       = subtotal + buffer_amt

    missing = [i["name"] for i in scope_items if not i.get("rate")]

    lines = [
        "📊 KẾT QUẢ ƯỚC TÍNH CHI PHÍ",
        "=" * 45,
        f"  Subtotal (không buffer): {subtotal:>15,.0f} VND",
        f"  Buffer {buffer_pct:.0f}%:            {buffer_amt:>15,.0f} VND",
        "  " + "-" * 43,
        f"  TỔNG CỘNG:               {total:>15,.0f} VND",
        f"  Tổng số giờ:             {total_hours:>14.1f} giờ",
        "=" * 45,
    ]

    if missing:
        lines.append(f"\n⚠️  Scope chưa có rate (cần bổ sung): {', '.join(missing)}")
        lines.append("   → Số liệu trên có thể thấp hơn thực tế.")

    return "\n".join(lines)
