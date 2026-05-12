-- CreateTable
CREATE TABLE "agent_memory" (
    "id"              SERIAL NOT NULL,
    "company_id"      INTEGER NOT NULL,
    "conversation_id" TEXT,
    "source"          "AgentAuditSource" NOT NULL DEFAULT 'chat',
    "user_text"       TEXT NOT NULL,
    "reply_text"      TEXT NOT NULL,
    "summary"         TEXT NOT NULL,
    "tools_used"      JSONB NOT NULL DEFAULT '[]',
    "project_ids"     INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "task_ids"        INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "correlation_id"  TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_memory_company_id_created_at_idx" ON "agent_memory"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_memory_conversation_id_idx" ON "agent_memory"("conversation_id");

-- Trigram index for ILIKE-style recall on summary + user_text.
-- pg_trgm ships with Postgres; no external extension required.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "agent_memory_summary_trgm_idx"  ON "agent_memory" USING GIN ("summary"   gin_trgm_ops);
CREATE INDEX "agent_memory_usertext_trgm_idx" ON "agent_memory" USING GIN ("user_text" gin_trgm_ops);

-- GIN for project/task id filtering (`project_ids && ARRAY[...]`).
CREATE INDEX "agent_memory_project_ids_idx" ON "agent_memory" USING GIN ("project_ids");
CREATE INDEX "agent_memory_task_ids_idx"    ON "agent_memory" USING GIN ("task_ids");
