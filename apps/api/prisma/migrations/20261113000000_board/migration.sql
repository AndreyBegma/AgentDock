-- CreateEnum
CREATE TYPE "BoardColumn" AS ENUM ('todo', 'in_progress', 'finished', 'completed');

-- CreateEnum
CREATE TYPE "BoardCardKind" AS ENUM ('feature', 'bug');

-- CreateEnum
CREATE TYPE "BoardCardSource" AS ENUM ('manual');

-- CreateEnum
CREATE TYPE "CardRoundTrigger" AS ENUM ('run', 'feedback');

-- CreateEnum
CREATE TYPE "CardRoundPhase" AS ENUM ('queued', 'starting', 'running', 'waiting', 'finished', 'ended', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "CardFinishedBy" AS ENUM ('worker', 'session_end', 'person');

-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'card';

-- CreateTable
CREATE TABLE "board_cards" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "shortId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "kind" "BoardCardKind" NOT NULL DEFAULT 'feature',
    "column" "BoardColumn" NOT NULL DEFAULT 'todo',
    "position" DOUBLE PRECISION NOT NULL,
    "source" "BoardCardSource" NOT NULL DEFAULT 'manual',
    "issueOnRun" BOOLEAN NOT NULL,
    "specOnRun" BOOLEAN NOT NULL,
    "model" TEXT,
    "sessionId" UUID,
    "branch" TEXT,
    "worktree" TEXT,
    "issueNumber" INTEGER,
    "issueUrl" TEXT,
    "specPath" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "createdById" TEXT,
    "movedById" TEXT,
    "completedById" TEXT,
    "movedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_card_rounds" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "trigger" "CardRoundTrigger" NOT NULL,
    "feedback" TEXT,
    "authorId" TEXT,
    "phase" "CardRoundPhase" NOT NULL DEFAULT 'queued',
    "tmuxSession" TEXT,
    "finishedBy" "CardFinishedBy",
    "summary" TEXT,
    "exitCode" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waitingAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "board_card_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_settings" (
    "projectId" TEXT NOT NULL,
    "issueOnRun" BOOLEAN NOT NULL DEFAULT false,
    "specOnRun" BOOLEAN NOT NULL DEFAULT false,
    "maxRunning" INTEGER NOT NULL DEFAULT 3,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "board_cards_shortId_key" ON "board_cards"("shortId");

-- CreateIndex
CREATE INDEX "board_cards_projectId_column_position_idx" ON "board_cards"("projectId", "column", "position");

-- CreateIndex
CREATE INDEX "board_cards_sessionId_idx" ON "board_cards"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "board_cards_projectId_number_key" ON "board_cards"("projectId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "board_card_rounds_runId_key" ON "board_card_rounds"("runId");

-- CreateIndex
CREATE INDEX "board_card_rounds_phase_idx" ON "board_card_rounds"("phase");

-- CreateIndex
CREATE UNIQUE INDEX "board_card_rounds_cardId_round_key" ON "board_card_rounds"("cardId", "round");

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_movedById_fkey" FOREIGN KEY ("movedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_rounds" ADD CONSTRAINT "board_card_rounds_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_rounds" ADD CONSTRAINT "board_card_rounds_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_card_rounds" ADD CONSTRAINT "board_card_rounds_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_settings" ADD CONSTRAINT "board_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_settings" ADD CONSTRAINT "board_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
