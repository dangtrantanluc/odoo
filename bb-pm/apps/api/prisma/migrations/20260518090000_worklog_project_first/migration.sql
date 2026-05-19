ALTER TABLE "backlogs" ALTER COLUMN "project_id" SET NOT NULL;
ALTER TABLE "backlogs" ALTER COLUMN "task_id" DROP NOT NULL;
ALTER TABLE "backlogs" DROP CONSTRAINT IF EXISTS "backlogs_task_id_fkey";
ALTER TABLE "backlogs"
  ADD CONSTRAINT "backlogs_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
