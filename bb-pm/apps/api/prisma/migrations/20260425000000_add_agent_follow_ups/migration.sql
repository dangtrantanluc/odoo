-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'REPLIED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "agent_follow_ups" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "channel" "ChannelKind" NOT NULL DEFAULT 'gapo',
    "thread_id" TEXT,
    "question" TEXT NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "asked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replied_at" TIMESTAMP(3),
    "reply_text" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_follow_ups_user_id_status_idx" ON "agent_follow_ups"("user_id", "status");

-- CreateIndex
CREATE INDEX "agent_follow_ups_task_id_status_idx" ON "agent_follow_ups"("task_id", "status");

-- CreateIndex
CREATE INDEX "agent_follow_ups_status_asked_at_idx" ON "agent_follow_ups"("status", "asked_at");

-- AddForeignKey
ALTER TABLE "agent_follow_ups" ADD CONSTRAINT "agent_follow_ups_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_follow_ups" ADD CONSTRAINT "agent_follow_ups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
