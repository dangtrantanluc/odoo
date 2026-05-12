-- Phase 1.1: Read-only Postgres role cho agent report.query.
-- Defense-in-depth — guard có thể bypass do parser bug, role là backstop
-- vì DDL/DML thẳng từ readonly role sẽ bị Postgres reject.
--
-- Password được set runtime: ALTER ROLE bb_pm_readonly WITH PASSWORD '<from BB_PM_READONLY_PWD>'.
-- Migration tạo placeholder; ops hoặc post-migrate script set password thật.

-- 1. Create role nếu chưa có (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bb_pm_readonly') THEN
    CREATE ROLE bb_pm_readonly WITH LOGIN PASSWORD 'change-me-in-runtime';
  END IF;
END
$$;

-- 2. Connect privilege
GRANT CONNECT ON DATABASE bb_pm TO bb_pm_readonly;
GRANT USAGE ON SCHEMA public TO bb_pm_readonly;

-- 3. SELECT trên tất cả bảng hiện có (sequences cho COUNT, FOR UPDATE — nope,
-- readonly nên skip sequences). Future tables: ALTER DEFAULT PRIVILEGES.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bb_pm_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO bb_pm_readonly;

-- 4. Defense: column-level grants cho users — exclude password_hash.
-- Postgres rule: column REVOKE chỉ effective khi table-level đã REVOKE rồi
-- GRANT cột cụ thể.
REVOKE SELECT ON users FROM bb_pm_readonly;
GRANT SELECT (
  id, email, full_name, avatar_url, lang, timezone, role,
  company_id, active, is_super_admin, department, "position",
  last_login_at, created_at, updated_at
) ON users TO bb_pm_readonly;

-- 5. Refresh tokens table — toàn bộ là sensitive, revoke SELECT.
REVOKE SELECT ON refresh_tokens FROM bb_pm_readonly;
