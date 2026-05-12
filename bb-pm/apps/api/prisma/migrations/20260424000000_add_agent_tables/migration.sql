-- CreateEnum
CREATE TYPE "AgentAuditSource" AS ENUM ('chat', 'cron', 'cli', 'other');

-- CreateEnum
CREATE TYPE "BlockerSeverity" AS ENUM ('LOW', 'MED', 'HIGH');

-- CreateTable
CREATE TABLE "agent_audit_log" (
    "id" SERIAL NOT NULL,
    "tool" TEXT NOT NULL,
    "args_json" JSONB NOT NULL,
    "result_json" JSONB,
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "correlation_id" TEXT,
    "source" "AgentAuditSource" NOT NULL DEFAULT 'chat',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_audit_log_tool_created_at_idx" ON "agent_audit_log"("tool", "created_at");

-- CreateIndex
CREATE INDEX "agent_audit_log_correlation_id_idx" ON "agent_audit_log"("correlation_id");

-- CreateTable
CREATE TABLE "task_blockers" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "severity" "BlockerSeverity" NOT NULL DEFAULT 'MED',
    "description" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_blockers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_blockers_task_id_resolved_at_idx" ON "task_blockers"("task_id", "resolved_at");
