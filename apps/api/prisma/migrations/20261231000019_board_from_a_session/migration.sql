-- AlterEnum
ALTER TYPE "ActionRequestKind" ADD VALUE 'card_accept';

-- CreateEnum
CREATE TYPE "CardMergePolicy" AS ENUM ('ask', 'agent', 'person');

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "queuedForSessionId" TEXT,
ADD COLUMN     "takenBranch" TEXT;

-- AlterTable
ALTER TABLE "board_settings" ADD COLUMN     "cardMergePolicy" "CardMergePolicy" NOT NULL DEFAULT 'ask';

-- CreateIndex
CREATE INDEX "board_cards_queuedForSessionId_idx" ON "board_cards"("queuedForSessionId");

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_queuedForSessionId_fkey" FOREIGN KEY ("queuedForSessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
