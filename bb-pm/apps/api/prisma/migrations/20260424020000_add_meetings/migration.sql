-- CreateEnum
CREATE TYPE "MeetingItemStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "meetings" (
    "id"              SERIAL NOT NULL,
    "company_id"      INTEGER NOT NULL,
    "project_id"      INTEGER,
    "title"           TEXT,
    "held_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transcript"      TEXT NOT NULL,
    "summary"         TEXT,
    "decisions"       JSONB NOT NULL DEFAULT '[]',
    "participants"    TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id"   INTEGER,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meetings_company_id_created_at_idx" ON "meetings"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "meetings_project_id_idx" ON "meetings"("project_id");

-- AddForeignKey
ALTER TABLE "meetings"
  ADD CONSTRAINT "meetings_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "meeting_action_items" (
    "id"              SERIAL NOT NULL,
    "meeting_id"      INTEGER NOT NULL,
    "title"           TEXT NOT NULL,
    "description"     TEXT,
    "owner_name"      TEXT,
    "owner_user_id"   INTEGER,
    "due_date"        DATE,
    "priority"        "Priority" NOT NULL DEFAULT 'MEDIUM',
    "status"          "MeetingItemStatus" NOT NULL DEFAULT 'DRAFT',
    "created_task_id" INTEGER,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_action_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_action_items_meeting_id_status_idx" ON "meeting_action_items"("meeting_id", "status");

-- AddForeignKey
ALTER TABLE "meeting_action_items"
  ADD CONSTRAINT "meeting_action_items_meeting_id_fkey"
  FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
