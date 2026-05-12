"""
SQL Schema Context — inject vào system prompt của LLM.

Chỉ expose đúng các bảng bb_project_* cần thiết.
Không expose toàn bộ Odoo DB (hàng trăm bảng hệ thống).
"""

SCHEMA_CONTEXT = """
Bạn có quyền truy cập PostgreSQL của hệ thống quản lý dự án BlueBolt.
Chỉ được dùng các bảng sau (tên thật trong DB):

=== BẢNG DỮ LIỆU ===

bb_project
  id, name, code,
  status        -- planned | in_progress | on_hold | completed | cancelled
  priority      -- low | medium | high | critical
  start_date, end_date,
  budget, total_cost, budget_remaining,
  currency_id,  -- FK res_currency
  owner_id,     -- FK res_users.id
  company_id,   -- FK res_company
  description

bb_project_task
  id, name,
  project_id,   -- FK bb_project.id
  assignee_id,  -- FK res_users.id
  status        -- todo | in_progress | review | done
  priority      -- low | medium | high | critical
  deadline,     -- DATE
  total_hours, total_cost,
  milestone_id  -- FK bb_project_milestone.id (nullable)

bb_project_backlog                     -- work log / timesheet
  id, task_id, project_id, user_id,
  work_date,                           -- DATE
  hours,                               -- số giờ đã làm
  cost_per_hour_snapshot,              -- giá tại thời điểm log
  total_cost_snapshot,                 -- hours * cost_per_hour_snapshot
  status        -- pending | approved | rejected
  description

bb_project_member                      -- thành viên của dự án
  id, project_id, user_id,
  role,                                -- developer | designer | pm | tester | ...
  current_rate                         -- giá hiện tại (VND/giờ)

bb_project_member_rate                 -- lịch sử thay đổi rate
  id, member_id,                       -- FK bb_project_member.id
  cost_per_hour,
  effective_from, effective_to         -- khoảng thời gian áp dụng

bb_project_scope                       -- scope item để ước tính
  id, project_id, name,
  assignee_id,                         -- FK res_users.id (nullable)
  estimated_hours,
  estimated_rate,
  estimated_cost                       -- estimated_hours * estimated_rate

bb_project_milestone
  id, project_id, name, due_date, done -- done: boolean

bb_project_tag
  id, name, color

res_users                              -- chỉ JOIN, không đọc password
  id, login, partner_id                -- KHÔNG có cột name trực tiếp

res_partner                            -- tên người dùng nằm ở đây
  id, name, email
  -- Để lấy tên: JOIN res_users u ON ... JOIN res_partner rp ON rp.id = u.partner_id

=== QUY TẮC VIẾT SQL ===
1. Chỉ viết câu SELECT — tuyệt đối không INSERT/UPDATE/DELETE/DROP
2. Luôn dùng alias rõ ràng (bp = bb_project, t = bb_project_task, ...)
3. Tiền tệ là VND
4. Ngày tháng: CURRENT_DATE cho hôm nay
5. Không subquery quá 2 tầng lồng nhau
6. Luôn có LIMIT (mặc định 50 nếu không có yêu cầu khác)
"""

# WHERE inject theo role — KHÔNG thể bị LLM override
# Được áp dụng tự động ở tầng sql_engine.py
ROLE_WHERE_TEMPLATES = {
    "admin": "",   # không filter

    "manager": (
        "AND bp.owner_id = {uid}"
    ),

    "member": (
        "AND EXISTS ("
        "  SELECT 1 FROM bb_project_member bpm_sec"
        "  WHERE bpm_sec.project_id = bp.id"
        "  AND   bpm_sec.user_id = {uid}"
        ")"
    ),

    "viewer": (
        "AND bp.id IN ("
        "  SELECT project_id FROM bb_project_member WHERE user_id = {uid}"
        ")"
    ),
}
