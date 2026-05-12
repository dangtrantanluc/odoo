-- ============================================================
-- BB Agent Memory Schema
-- Chạy một lần trên database "odoo":
--
--   docker exec -i project_management_db \
--     psql -U admin -d odoo < agent/memory/schema.sql
-- ============================================================

-- 1. Extension pgvector (cần cài postgresql-16-pgvector trước)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- EPISODIC MEMORY — lịch sử per-user
-- Lưu: Q&A đã hỏi, estimate đã tính, preference của user, lỗi gặp phải
-- ============================================================
CREATE TABLE IF NOT EXISTS bb_agent_episodic (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER,                    -- res_users.id (NULL = system)
    session_id  TEXT        NOT NULL,
    memory_type TEXT        NOT NULL,       -- qa | estimate | preference | error
    content     TEXT        NOT NULL,
    metadata    JSONB       NOT NULL DEFAULT '{}',
    embedding   vector(384),                -- paraphrase-multilingual-MiniLM-L12-v2
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ                 -- NULL = không hết hạn
);

CREATE INDEX IF NOT EXISTS idx_episodic_vec
    ON bb_agent_episodic
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_episodic_user_type
    ON bb_agent_episodic (user_id, memory_type);

CREATE INDEX IF NOT EXISTS idx_episodic_expires
    ON bb_agent_episodic (expires_at)
    WHERE expires_at IS NOT NULL;

-- ============================================================
-- SEMANTIC MEMORY — kiến thức tổ chức (org-wide)
-- Lưu: tốc độ làm việc trung bình, cost pattern, benchmark project
-- ============================================================
CREATE TABLE IF NOT EXISTS bb_agent_semantic (
    id          SERIAL PRIMARY KEY,
    category    TEXT        NOT NULL,       -- velocity | cost_pattern
    subject     TEXT        NOT NULL,       -- key ngắn gọn, ví dụ: avg_rate_developer
    content     TEXT        NOT NULL,       -- nội dung fact cụ thể
    confidence  FLOAT       NOT NULL DEFAULT 1.0,
    embedding   vector(384),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source      TEXT,                       -- derived_from_backlogs | admin_input | auto_extracted
    UNIQUE (category, subject)              -- upsert theo category+subject
);

CREATE INDEX IF NOT EXISTS idx_semantic_vec
    ON bb_agent_semantic
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_semantic_category
    ON bb_agent_semantic (category);

-- ============================================================
-- PROCEDURAL MEMORY — SQL templates và tool sequences đã proven
-- Lưu: câu SQL đã dùng thành công, chuỗi tool calls đã work
-- ============================================================
CREATE TABLE IF NOT EXISTS bb_agent_procedural (
    id            SERIAL PRIMARY KEY,
    pattern_type  TEXT        NOT NULL,     -- sql_template | tool_sequence
    intent        TEXT        NOT NULL,     -- mục đích, ví dụ: "lấy deadline tasks của user"
    template      TEXT        NOT NULL,     -- SQL hoặc JSON steps
    success_count INTEGER     NOT NULL DEFAULT 1,
    last_used     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    embedding     vector(384),
    UNIQUE (pattern_type, intent)           -- upsert theo type+intent
);

CREATE INDEX IF NOT EXISTS idx_procedural_vec
    ON bb_agent_procedural
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50);

-- ============================================================
-- Seed một số semantic memory mặc định (có thể xoá nếu không cần)
-- ============================================================
INSERT INTO bb_agent_semantic (category, subject, content, source)
VALUES
    ('cost_pattern', 'buffer_recommendation',
     'Các project thường overrun 10-20% so với estimate ban đầu. Nên thêm buffer 15% khi estimate.',
     'admin_input'),
    ('cost_pattern', 'currency',
     'Hệ thống dùng đơn vị VND (Đồng Việt Nam). Hiển thị số có dấu phẩy hàng nghìn.',
     'admin_input'),
    ('velocity', 'working_hours',
     'Một ngày làm việc tiêu chuẩn là 8 giờ. Một tuần là 40 giờ (5 ngày).',
     'admin_input')
ON CONFLICT (category, subject) DO NOTHING;
