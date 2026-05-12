-- DropIndex
DROP INDEX "agent_memory_company_id_created_at_idx";

-- DropIndex
DROP INDEX "agent_memory_project_ids_idx";

-- DropIndex
DROP INDEX "agent_memory_summary_trgm_idx";

-- DropIndex
DROP INDEX "agent_memory_task_ids_idx";

-- DropIndex
DROP INDEX "agent_memory_usertext_trgm_idx";

-- DropIndex
DROP INDEX "meetings_company_id_created_at_idx";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "department" TEXT,
ADD COLUMN     "position" TEXT;

-- CreateIndex
CREATE INDEX "agent_memory_company_id_created_at_idx" ON "agent_memory"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "meetings_company_id_created_at_idx" ON "meetings"("company_id", "created_at");
