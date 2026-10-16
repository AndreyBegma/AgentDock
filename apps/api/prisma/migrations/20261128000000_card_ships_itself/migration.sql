-- #359 (ADR-0035): a card ships itself — CI watched and fixed, auto-merge at
-- Finished, every PR of a card kept.

-- CreateEnum
CREATE TYPE "CardCiState" AS ENUM ('none', 'pending', 'green', 'red');

-- AlterEnum
ALTER TYPE "CardRoundTrigger" ADD VALUE 'ci_fix';

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "ciCheckedAt" TIMESTAMP(3),
ADD COLUMN     "ciChecks" JSONB,
ADD COLUMN     "ciFixAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ciHeadSha" TEXT,
ADD COLUMN     "ciState" "CardCiState" NOT NULL DEFAULT 'none',
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "needsPerson" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "board_settings" ADD COLUMN     "autoMergeCards" BOOLEAN;

-- CreateTable
CREATE TABLE "board_card_pull_requests" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "state" "CardPrState" NOT NULL,
    "round" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_card_pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "board_card_pull_requests_cardId_number_key" ON "board_card_pull_requests"("cardId", "number");

-- AddForeignKey
ALTER TABLE "board_card_pull_requests" ADD CONSTRAINT "board_card_pull_requests_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a card that already has a PR lists it, opened by its latest round.
INSERT INTO "board_card_pull_requests" ("id", "cardId", "number", "url", "branch", "state", "round", "createdAt")
SELECT
    gen_random_uuid()::text,
    c."id",
    c."prNumber",
    c."prUrl",
    c."branch",
    COALESCE(c."prState", 'open'),
    COALESCE((SELECT MAX(r."round") FROM "board_card_rounds" r WHERE r."cardId" = c."id"), 1),
    COALESCE(c."collectedAt", c."updatedAt")
FROM "board_cards" c
WHERE c."prNumber" IS NOT NULL AND c."prUrl" IS NOT NULL AND c."branch" IS NOT NULL;
