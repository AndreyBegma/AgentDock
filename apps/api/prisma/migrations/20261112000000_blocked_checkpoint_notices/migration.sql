-- CreateTable
CREATE TABLE "blocked_checkpoint_notices" (
    "checkpointId" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "blocked_checkpoint_notices_pkey" PRIMARY KEY ("checkpointId")
);

-- AddForeignKey
ALTER TABLE "blocked_checkpoint_notices" ADD CONSTRAINT "blocked_checkpoint_notices_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "slot_checkpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every blocked checkpoint that exists before the sweep was
-- notified (or not) by the old immediate path, so the first sweep must not
-- fire them again (spec 22 note 23).
INSERT INTO "blocked_checkpoint_notices" ("checkpointId", "heading", "since", "notifiedAt")
SELECT "id", "heading", "at", CURRENT_TIMESTAMP
FROM "slot_checkpoints"
WHERE "kind" = 'blocked';
