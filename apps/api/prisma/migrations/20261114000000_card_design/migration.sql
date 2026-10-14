-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "continueAfterDesign" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "designSessionId" UUID;

-- AlterTable
ALTER TABLE "plan_turns" ADD COLUMN     "cardId" TEXT,
ALTER COLUMN "planId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "task_designs" ADD COLUMN     "cardId" TEXT,
ALTER COLUMN "planId" DROP NOT NULL,
ALTER COLUMN "taskKey" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "plan_turns_cardId_createdAt_idx" ON "plan_turns"("cardId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_designs_cardId_key" ON "task_designs"("cardId");

-- AddForeignKey
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ADR-0025: a design has exactly one owner — a plan task or a board card.
-- Hand-added: Prisma does not generate CHECK constraints.
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_owner_check" CHECK (
    ("planId" IS NOT NULL AND "taskKey" IS NOT NULL AND "cardId" IS NULL)
    OR ("planId" IS NULL AND "taskKey" IS NULL AND "cardId" IS NOT NULL)
);

-- #243 D2: a turn belongs to a plan or, for a card's design, to the card.
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_owner_check" CHECK (
    ("planId" IS NOT NULL AND "cardId" IS NULL)
    OR ("planId" IS NULL AND "cardId" IS NOT NULL)
);
