-- CreateTable
CREATE TABLE "automations" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "target" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "owner_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_run_status" TEXT,
    "last_run_error" TEXT,
    "consecutive_fails" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automations_active_schedule_idx" ON "automations"("active", "schedule");

-- CreateIndex
CREATE INDEX "automations_company_id_active_idx" ON "automations"("company_id", "active");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

