-- Sprint 8 follow-up — Audit log retention support.
-- Standalone index trên agent_audit_log.created_at cho fast DELETE
-- WHERE created_at < cutoff (retention sweep). Tránh full table scan khi
-- bb-pm-tools scheduler chạy cleanup hàng ngày.
--
-- Khi row count > 1M (vài tháng production), upgrade sang native Postgres
-- partition by RANGE (created_at) — DROP PARTITION nhanh hơn nhiều.

CREATE INDEX IF NOT EXISTS "agent_audit_log_created_at_idx"
  ON "agent_audit_log" ("created_at");
