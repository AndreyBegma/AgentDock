-- Issue #282, ADR-0030: terminal work and fleet work on the Board.

-- AlterEnum
ALTER TYPE "BoardCardSource" ADD VALUE 'terminal';
ALTER TYPE "BoardCardSource" ADD VALUE 'fleet';

-- AlterEnum
ALTER TYPE "CardCaptureSkipReason" ADD VALUE 'tracked';

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "autoCollect" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fleetIssue" INTEGER,
ADD COLUMN     "fleetSlot" TEXT,
ADD COLUMN     "fleetSlotGone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fleetStage" TEXT,
ADD COLUMN     "trackedSessionId" TEXT;

-- AlterTable
ALTER TABLE "board_settings" ADD COLUMN     "autoCollectTracked" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "board_cards_trackedSessionId_key" ON "board_cards"("trackedSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "board_cards_projectId_fleetIssue_fleetSlot_key" ON "board_cards"("projectId", "fleetIssue", "fleetSlot");

-- #282 D4: one To Do card per `cs:ready` issue no slot has picked up. The
-- unique index above does not cover it, because Postgres treats a null
-- `fleetSlot` as distinct.
CREATE UNIQUE INDEX "board_cards_fleet_unslotted_key" ON "board_cards"("projectId", "fleetIssue")
    WHERE "fleetIssue" IS NOT NULL AND "fleetSlot" IS NULL;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_trackedSessionId_fkey" FOREIGN KEY ("trackedSessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
