-- #337 (ADR-0034): the Planner on the Board — card intakes, cards from plans,
-- card dependencies, per-person settings.

-- AlterEnum
ALTER TYPE "PlanMode" ADD VALUE 'card';

-- AlterEnum
ALTER TYPE "PlanStatus" ADD VALUE 'done';

-- AlterEnum
ALTER TYPE "PlanTurnAction" ADD VALUE 'intake';

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "planId" TEXT;

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "planId" TEXT;

-- AlterTable
ALTER TABLE "plan_tasks" ADD COLUMN     "cardId" TEXT;

-- CreateTable
CREATE TABLE "user_settings" (
    "userId" TEXT NOT NULL,
    "planningModel" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "board_card_dependencies" (
    "cardId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_card_dependencies_pkey" PRIMARY KEY ("cardId","dependsOnId"),
    -- D8: a card never depends on itself; longer cycles are refused by the API.
    CONSTRAINT "board_card_dependencies_not_self_check" CHECK ("cardId" <> "dependsOnId")
);

-- CreateIndex
CREATE INDEX "board_card_dependencies_dependsOnId_idx" ON "board_card_dependencies"("dependsOnId");

-- CreateIndex
CREATE INDEX "attachments_planId_idx" ON "attachments"("planId");

-- CreateIndex
CREATE INDEX "board_cards_planId_idx" ON "board_cards"("planId");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_dependencies" ADD CONSTRAINT "board_card_dependencies_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_dependencies" ADD CONSTRAINT "board_card_dependencies_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
