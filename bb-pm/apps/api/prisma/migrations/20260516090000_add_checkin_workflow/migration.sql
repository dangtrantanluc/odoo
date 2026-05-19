CREATE TYPE "BacklogSource" AS ENUM ('MANUAL', 'GAPO_CHECKIN');
CREATE TYPE "CheckinState" AS ENUM ('IDLE', 'AWAITING_PROJECT', 'AWAITING_UPDATE', 'AWAITING_TASK_CONFIRM', 'COMPLETED');

ALTER TABLE "backlogs"
ADD COLUMN "source" "BacklogSource" NOT NULL DEFAULT 'MANUAL';

CREATE TABLE "checkin_sessions" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "gapo_user_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "current_project_id" INTEGER,
  "current_task_id" INTEGER,
  "state" "CheckinState" NOT NULL DEFAULT 'IDLE',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_message_id" TEXT,
  "pending_text" TEXT,
  "pending_parsed" JSONB,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "checkin_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkin_sessions_user_id_key" ON "checkin_sessions"("user_id");
CREATE INDEX "checkin_sessions_state_expires_at_idx" ON "checkin_sessions"("state", "expires_at");

ALTER TABLE "checkin_sessions"
ADD CONSTRAINT "checkin_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
