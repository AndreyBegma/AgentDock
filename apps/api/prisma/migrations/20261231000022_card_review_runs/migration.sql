-- #884 (ADR-0084 §4): review step runs on a card's PR head, the `review_fix`
-- round trigger and its own per-PR counter, and the `card_review` run kind.

-- CreateEnum
CREATE TYPE "CardReviewRunState" AS ENUM ('running', 'passed', 'blocked', 'failed');

-- AlterEnum
ALTER TYPE "CardRoundTrigger" ADD VALUE 'review_fix';

-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'card_review';

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "reviewFixAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "board_card_review_runs" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "roundId" TEXT,
    "stepId" TEXT,
    "stepName" TEXT NOT NULL,
    "stepType" "ReviewStepType" NOT NULL,
    "position" INTEGER NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "pass" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "state" "CardReviewRunState" NOT NULL DEFAULT 'running',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "blockingCount" INTEGER NOT NULL DEFAULT 0,
    "nitCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "error" TEXT,
    "publishedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "board_card_review_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "board_card_review_runs_runId_key" ON "board_card_review_runs"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "board_card_review_runs_sessionId_key" ON "board_card_review_runs"("sessionId");

-- CreateIndex
CREATE INDEX "board_card_review_runs_state_idx" ON "board_card_review_runs"("state");

-- CreateIndex
CREATE UNIQUE INDEX "board_card_review_runs_cardId_headSha_pass_stepId_key" ON "board_card_review_runs"("cardId", "headSha", "pass", "stepId");

-- AddForeignKey
ALTER TABLE "board_card_review_runs" ADD CONSTRAINT "board_card_review_runs_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_review_runs" ADD CONSTRAINT "board_card_review_runs_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "board_card_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_review_runs" ADD CONSTRAINT "board_card_review_runs_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "project_review_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_review_runs" ADD CONSTRAINT "board_card_review_runs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
