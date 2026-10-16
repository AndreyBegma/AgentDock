-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "stageId" TEXT;

-- AlterTable
ALTER TABLE "plan_turns" ADD COLUMN     "stackId" TEXT;

-- AlterTable
ALTER TABLE "task_designs" ADD COLUMN     "stackId" TEXT;

-- CreateTable
CREATE TABLE "board_stacks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "planId" TEXT,
    "designSessionId" UUID,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_stacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_stack_stages" (
    "id" TEXT NOT NULL,
    "stackId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "board_stack_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "board_stacks_projectId_number_key" ON "board_stacks"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "board_stack_stages_stackId_position_key" ON "board_stack_stages"("stackId", "position");

-- CreateIndex
CREATE INDEX "board_cards_stageId_idx" ON "board_cards"("stageId");

-- CreateIndex
CREATE INDEX "plan_turns_stackId_createdAt_idx" ON "plan_turns"("stackId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "task_designs_stackId_key" ON "task_designs"("stackId");

-- AddForeignKey
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "board_stacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "board_stacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "board_stack_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stacks" ADD CONSTRAINT "board_stacks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stacks" ADD CONSTRAINT "board_stacks_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stacks" ADD CONSTRAINT "board_stacks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stack_stages" ADD CONSTRAINT "board_stack_stages_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "board_stacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ADR-0043 (amends ADR-0025): a design has exactly one owner — a plan task,
-- a board card or a stack. Hand-added: Prisma does not generate CHECK constraints.
ALTER TABLE "task_designs" DROP CONSTRAINT "task_designs_owner_check";
ALTER TABLE "task_designs" ADD CONSTRAINT "task_designs_owner_check" CHECK (
    ("planId" IS NOT NULL AND "taskKey" IS NOT NULL AND "cardId" IS NULL AND "stackId" IS NULL)
    OR ("planId" IS NULL AND "taskKey" IS NULL AND num_nonnulls("cardId", "stackId") = 1)
);

-- A turn belongs to a plan, a card's design, or a stack's design.
ALTER TABLE "plan_turns" DROP CONSTRAINT "plan_turns_owner_check";
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_owner_check" CHECK (
    num_nonnulls("planId", "cardId", "stackId") = 1
);
