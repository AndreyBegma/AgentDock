-- CreateEnum
CREATE TYPE "CardCollectState" AS ENUM ('none', 'pending', 'ok', 'no_changes', 'failed');

-- CreateEnum
CREATE TYPE "CardPrState" AS ENUM ('open', 'draft', 'merged', 'closed');

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "collectAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "collectError" TEXT,
ADD COLUMN     "collectState" "CardCollectState" NOT NULL DEFAULT 'none',
ADD COLUMN     "collectedAt" TIMESTAMP(3),
ADD COLUMN     "prState" "CardPrState";

-- #329 D2: a card that already has its PR was collected. Its `prState` stays
-- null until the PR poll or the next collect reads it.
UPDATE "board_cards" SET "collectState" = 'ok' WHERE "prUrl" IS NOT NULL;
