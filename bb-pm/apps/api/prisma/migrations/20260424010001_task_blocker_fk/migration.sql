-- AddForeignKey
ALTER TABLE "task_blockers"
  ADD CONSTRAINT "task_blockers_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
