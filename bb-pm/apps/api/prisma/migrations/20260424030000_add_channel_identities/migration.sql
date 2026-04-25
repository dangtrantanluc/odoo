-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('gapo', 'slack', 'zalo', 'zalouser', 'telegram', 'email', 'sms');

-- CreateTable
CREATE TABLE "channel_identities" (
    "id"             SERIAL NOT NULL,
    "user_id"        INTEGER NOT NULL,
    "channel"        "ChannelKind" NOT NULL,
    "external_id"    TEXT NOT NULL,
    "external_name"  TEXT,
    "thread_id"      TEXT,
    "preferred"      BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_identities_channel_external_id_key"
  ON "channel_identities"("channel", "external_id");

-- CreateIndex
CREATE INDEX "channel_identities_user_id_channel_preferred_idx"
  ON "channel_identities"("user_id", "channel", "preferred");

-- AddForeignKey
ALTER TABLE "channel_identities"
  ADD CONSTRAINT "channel_identities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from existing gapo_user_maps so send_follow_up keeps working
-- without re-seeding. GapoUserMap rows become preferred=true Gapo identities.
INSERT INTO "channel_identities"
  ("user_id", "channel", "external_id", "external_name", "thread_id", "preferred", "last_seen_at", "created_at", "updated_at")
SELECT
  "user_id",
  'gapo'::"ChannelKind",
  "gapo_user_id"::TEXT,
  "gapo_full_name",
  "gapo_thread_id"::TEXT,
  TRUE,
  "last_seen_at",
  "created_at",
  CURRENT_TIMESTAMP
FROM "gapo_user_maps"
ON CONFLICT ("channel", "external_id") DO NOTHING;
