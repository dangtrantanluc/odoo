---
name: pm-odoo
description: Query and update BBSW Odoo project management data (bb_test_db). Use for project progress, tasks, milestones, backlog, members. Connects via psql inside Docker container.
---

# BBSW Odoo Project Management DB

Query và cập nhật dữ liệu quản lý dự án từ database `bb_test_db` trên Odoo 17 của BBSW.

## Kết nối DB

```bash
# Chạy query (thay <SQL> bằng câu lệnh thực tế)
docker exec $(docker ps -q -f name=db) psql -U admin -d bb_test_db -c "<SQL>"

# Chế độ tương tác
docker exec -it $(docker ps -q -f name=db) psql -U admin -d bb_test_db
```

## Schema chính

### bb_project — Dự án

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id, name, code | | Định danh |
| status | varchar | `planned` / `in_progress` / `on_hold` / `completed` / `cancelled` |
| priority | varchar | Độ ưu tiên |
| start_date, end_date | date | Thời hạn |
| budget, total_cost, budget_remaining | numeric | Ngân sách |
| total_hours | float | Tổng giờ làm |
| owner_id | FK → res_users | PM phụ trách |
| customer_id | FK → res_partner | Khách hàng |

### bb_project_task — Task

| Cột | Kiểu | Ghi chú |
|---|---|---|
| project_id | FK → bb_project | |
| assignee_id | FK → res_users | Người thực hiện |
| status | varchar | `todo` / `in_progress` / `review` / `done` |
| deadline | date | |
| result, issues | text | Kết quả & vấn đề |
| total_hours, total_cost | | Thực tế |

### bb_project_milestone — Milestone

| Cột | Kiểu | Ghi chú |
|---|---|---|
| project_id | FK → bb_project | |
| name, description | | |
| deadline | date | |
| is_done | boolean | Đã hoàn thành chưa |

### bb_project_scope — Phạm vi / hạng mục

| Cột | Kiểu | Ghi chú |
|---|---|---|
| project_id | FK → bb_project | |
| milestone_id | FK → bb_project_milestone | |
| task_id | FK → bb_project_task | |
| assignee_id | FK → res_users | |
| name | | Tên hạng mục |
| estimated_hours, estimated_rate, estimated_cost | numeric | Ước tính |

### bb_project_backlog — Log giờ làm

| Cột | Kiểu | Ghi chú |
|---|---|---|
| task_id | FK → bb_project_task | |
| project_id | FK → bb_project | |
| user_id | FK → res_users | Người log |
| approver_id | FK → res_users | Người duyệt |
| status | varchar | `pending` / `approved` / `rejected` |
| work_date | date | Ngày làm |
| hours | numeric | Số giờ |
| cost_per_hour_snapshot, total_cost_snapshot | numeric | Chi phí tại thời điểm log |

### bb_project_member — Thành viên dự án

| Cột | Kiểu | Ghi chú |
|---|---|---|
| project_id | FK → bb_project | |
| user_id | FK → res_users | |
| role | varchar | `PM` / `LEAD` / `LEAD DEV` / `DEV` / `ANALYST` / `DATA ENG` |
| joined_at | timestamp | |

## Các query thường dùng

### Tổng quan tiến độ dự án

```sql
SELECT
  p.code, p.name, p.status,
  p.start_date, p.end_date,
  COUNT(DISTINCT t.id) AS total_tasks,
  COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'done') AS done_tasks,
  ROUND(
    100.0 * COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'done')
    / NULLIF(COUNT(DISTINCT t.id), 0), 1
  ) AS progress_pct,
  p.budget, p.total_cost, p.budget_remaining
FROM bb_project p
LEFT JOIN bb_project_task t ON t.project_id = p.id
WHERE p.status NOT IN ('cancelled')
GROUP BY p.id
ORDER BY p.status, p.end_date;
```

### Tasks theo dự án + người thực hiện

```sql
SELECT
  t.name AS task, t.status, t.deadline,
  u.name AS assignee,
  t.total_hours, t.issues
FROM bb_project_task t
JOIN bb_project p ON p.id = t.project_id
LEFT JOIN res_users ru ON ru.id = t.assignee_id
LEFT JOIN res_partner u ON u.id = ru.partner_id
WHERE p.code = 'MAR-002'   -- thay bằng code dự án
ORDER BY t.status, t.deadline;
```

### Milestones của dự án

```sql
SELECT
  m.name, m.deadline, m.is_done,
  COUNT(s.id) AS scope_count
FROM bb_project_milestone m
JOIN bb_project p ON p.id = m.project_id
LEFT JOIN bb_project_scope s ON s.milestone_id = m.id
WHERE p.code = 'MAR-002'
GROUP BY m.id
ORDER BY m.deadline;
```

### Backlog giờ làm chờ duyệt

```sql
SELECT
  b.work_date, u.name AS member, t.name AS task,
  b.hours, b.status,
  b.total_cost_snapshot
FROM bb_project_backlog b
JOIN bb_project_task t ON t.id = b.task_id
JOIN res_users ru ON ru.id = b.user_id
JOIN res_partner u ON u.id = ru.partner_id
WHERE b.status = 'pending'
ORDER BY b.work_date DESC;
```

### Thành viên dự án

```sql
SELECT
  u.name AS member, m.role, m.joined_at
FROM bb_project_member m
JOIN bb_project p ON p.id = m.project_id
JOIN res_users ru ON ru.id = m.user_id
JOIN res_partner u ON u.id = ru.partner_id
WHERE p.code = 'MAR-002'
ORDER BY m.role;
```

## Cập nhật dữ liệu (UPDATE)

Luôn xác nhận với người dùng trước khi chạy UPDATE/INSERT.

```sql
-- Cập nhật trạng thái task
UPDATE bb_project_task
SET status = 'done', write_date = NOW()
WHERE id = <task_id>;

-- Cập nhật trạng thái dự án
UPDATE bb_project
SET status = 'completed', write_date = NOW()
WHERE id = <project_id>;

-- Duyệt backlog
UPDATE bb_project_backlog
SET status = 'approved', approver_id = <user_id>, write_date = NOW()
WHERE id = <backlog_id>;

-- Đánh dấu milestone hoàn thành
UPDATE bb_project_milestone
SET is_done = true, write_date = NOW()
WHERE id = <milestone_id>;
```

## Lưu ý

- Sau UPDATE quan trọng, restart Odoo để đảm bảo cache được clear: `docker compose restart web`
- `res_users.partner_id` → `res_partner.name` để lấy tên người dùng
- `write_date` nên cập nhật kèm khi UPDATE để Odoo track đúng
- DB: `bb_test_db` (không dùng `project_management` — schema bị broken)
