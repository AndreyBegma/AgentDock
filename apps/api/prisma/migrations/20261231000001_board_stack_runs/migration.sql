-- #652: Run stack — a stack's run and its persisted queue.
-- CreateEnum
CREATE TYPE "BoardStackRunState" AS ENUM ('running', 'paused', 'stopped', 'done');

-- CreateEnum
CREATE TYPE "BoardStackRunCardStatus" AS ENUM ('queued', 'waiting', 'started');

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "autoRunStack" INTEGER;

-- CreateTable
CREATE TABLE "board_stack_runs" (
    "id" TEXT NOT NULL,
    "stackId" TEXT NOT NULL,
    "state" "BoardStackRunState" NOT NULL,
    "startedById" TEXT,
    "startedByRole" TEXT NOT NULL,
    "pausedCode" TEXT,
    "pausedMessage" TEXT,
    "pausedCardId" TEXT,
    "pausedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_stack_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_stack_run_cards" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "status" "BoardStackRunCardStatus" NOT NULL DEFAULT 'queued',
    "roundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_stack_run_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "board_stack_runs_stackId_key" ON "board_stack_runs"("stackId");

-- CreateIndex
CREATE INDEX "board_stack_runs_pausedCardId_idx" ON "board_stack_runs"("pausedCardId");

-- CreateIndex
CREATE UNIQUE INDEX "board_stack_run_cards_cardId_key" ON "board_stack_run_cards"("cardId");

-- CreateIndex
CREATE INDEX "board_stack_run_cards_runId_idx" ON "board_stack_run_cards"("runId");

-- AddForeignKey
ALTER TABLE "board_stack_runs" ADD CONSTRAINT "board_stack_runs_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "board_stacks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stack_runs" ADD CONSTRAINT "board_stack_runs_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stack_runs" ADD CONSTRAINT "board_stack_runs_pausedCardId_fkey" FOREIGN KEY ("pausedCardId") REFERENCES "board_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stack_run_cards" ADD CONSTRAINT "board_stack_run_cards_runId_fkey" FOREIGN KEY ("runId") REFERENCES "board_stack_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_stack_run_cards" ADD CONSTRAINT "board_stack_run_cards_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
