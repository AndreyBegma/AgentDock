-- #636 (ADR-0063): a card stacked on its one unmerged dependency's branch.
-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "prBase" TEXT,
ADD COLUMN     "prBaseCardId" TEXT;

-- CreateIndex
CREATE INDEX "board_cards_prBaseCardId_idx" ON "board_cards"("prBaseCardId");

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_prBaseCardId_fkey" FOREIGN KEY ("prBaseCardId") REFERENCES "board_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
