-- CreateEnum
CREATE TYPE "CardCaptureStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "CardCaptureSkipReason" AS ENUM ('too_little', 'rate_limited', 'inbox_full', 'budget_exceeded', 'runner_offline', 'capture_off');

-- AlterEnum
ALTER TYPE "BoardCardSource" ADD VALUE 'captured';

-- AlterEnum
-- First, as in the schema and shared `BOARD_COLUMNS`.
ALTER TYPE "BoardColumn" ADD VALUE 'inbox' BEFORE 'todo';

-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'card_capture';

-- AlterEnum
ALTER TYPE "RunTrigger" ADD VALUE 'capture';

-- AlterTable
ALTER TABLE "board_cards" ADD COLUMN     "captureConfidence" DOUBLE PRECISION,
ADD COLUMN     "captureId" TEXT,
ADD COLUMN     "captureWhy" TEXT,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "sourceSessionId" TEXT;

-- AlterTable
ALTER TABLE "board_settings" ADD COLUMN     "captureEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "captureModel" TEXT NOT NULL DEFAULT 'haiku';

-- CreateTable
CREATE TABLE "card_captures" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT,
    "extractSessionId" UUID,
    "contentFromId" BIGINT NOT NULL,
    "contentToId" BIGINT NOT NULL,
    "inputChars" INTEGER NOT NULL,
    "status" "CardCaptureStatus" NOT NULL DEFAULT 'queued',
    "skipReason" "CardCaptureSkipReason",
    "error" TEXT,
    "resultText" TEXT,
    "suggested" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "card_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_dismissals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dismissedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_captures_runId_key" ON "card_captures"("runId");

-- CreateIndex
CREATE INDEX "card_captures_projectId_createdAt_idx" ON "card_captures"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "card_captures_sessionId_createdAt_idx" ON "card_captures"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "card_dismissals_projectId_fingerprint_idx" ON "card_dismissals"("projectId", "fingerprint");

-- CreateIndex
CREATE INDEX "card_dismissals_createdAt_idx" ON "card_dismissals"("createdAt");

-- CreateIndex
CREATE INDEX "board_cards_projectId_fingerprint_idx" ON "board_cards"("projectId", "fingerprint");

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "card_captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_sourceSessionId_fkey" FOREIGN KEY ("sourceSessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_captures" ADD CONSTRAINT "card_captures_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_captures" ADD CONSTRAINT "card_captures_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_captures" ADD CONSTRAINT "card_captures_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_dismissals" ADD CONSTRAINT "card_dismissals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_dismissals" ADD CONSTRAINT "card_dismissals_dismissedById_fkey" FOREIGN KEY ("dismissedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
