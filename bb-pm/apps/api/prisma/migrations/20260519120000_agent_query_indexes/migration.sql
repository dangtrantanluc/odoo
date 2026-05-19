-- Phase 1.5 — Index tối ưu cho query pattern của PM Agent (bản Python mới).
--
-- Agent chạy lặp lại các truy vấn: overdue (deadline + status), stale
-- (updated_at), my-tasks (assignee + status), digest theo company. Trước đây
-- index trên `tasks` chỉ có (project_id,status), (assignee_id), (milestone_id)
-- nên các query trên rơi vào Sequential Scan khi bảng lớn.
--
-- Thay đổi:
--  * Bỏ index 1 cột (assignee_id) — đã được phủ bởi prefix của
--    (assignee_id, status).
--  * Thêm index phục vụ overdue / stale / my-tasks / company-scoped digest.
--  * backlogs: thêm (project_id, work_date) cho check-in status &
--    project-daily-summary.

-- tasks ----------------------------------------------------------------------
DROP INDEX IF EXISTS "tasks_assignee_id_idx";

CREATE INDEX IF NOT EXISTS "tasks_assignee_id_status_idx"
  ON "tasks" ("assignee_id", "status");

CREATE INDEX IF NOT EXISTS "tasks_company_id_status_idx"
  ON "tasks" ("company_id", "status");

CREATE INDEX IF NOT EXISTS "tasks_deadline_status_idx"
  ON "tasks" ("deadline", "status");

CREATE INDEX IF NOT EXISTS "tasks_updated_at_idx"
  ON "tasks" ("updated_at");

-- backlogs -------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "backlogs_project_id_work_date_idx"
  ON "backlogs" ("project_id", "work_date");
