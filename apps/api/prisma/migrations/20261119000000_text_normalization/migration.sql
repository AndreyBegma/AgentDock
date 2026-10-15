-- CreateEnum
CREATE TYPE "CardKindSource" AS ENUM ('auto', 'person');

-- CreateEnum
CREATE TYPE "TextOwnerType" AS ENUM ('board_card', 'board_card_round', 'design_comment', 'plan', 'plan_task', 'plan_turn');

-- CreateEnum
CREATE TYPE "TextNormalizationStatus" AS ENUM ('pending', 'running', 'done', 'skipped', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "TextFailReason" AS ENUM ('runner_offline', 'runner_unsupported', 'no_profile', 'run_failed', 'contract_violation', 'budget_exceeded', 'off');

-- AlterEnum
ALTER TYPE "RunKind" ADD VALUE 'text_normalize';

-- AlterTable
-- #271 D9: existing cards get `person` — their kind was chosen in the New card
-- dialog — and new cards default to `auto`.
ALTER TABLE "board_cards" ADD COLUMN     "kindSource" "CardKindSource" NOT NULL DEFAULT 'person';
ALTER TABLE "board_cards" ALTER COLUMN "kindSource" SET DEFAULT 'auto';

-- CreateTable
CREATE TABLE "text_normalizations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerType" "TextOwnerType" NOT NULL,
    "cardId" TEXT,
    "roundId" TEXT,
    "commentId" TEXT,
    "planId" TEXT,
    "taskId" TEXT,
    "turnId" TEXT,
    "fields" JSONB NOT NULL,
    "classifyKind" BOOLEAN NOT NULL DEFAULT false,
    "kind" "BoardCardKind",
    "status" "TextNormalizationStatus" NOT NULL DEFAULT 'pending',
    "failReason" "TextFailReason",
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "runId" TEXT,
    "sessionId" UUID,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "text_normalizations_pkey" PRIMARY KEY ("id")
);

-- #271 D7: a request has exactly one owner (the ADR-0025 precedent).
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_owner_check" CHECK (
    num_nonnulls("cardId", "roundId", "commentId", "planId", "taskId", "turnId") = 1
);

-- CreateTable
CREATE TABLE "text_settings" (
    "projectId" TEXT NOT NULL,
    "normalizeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "text_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "text_normalizations_runId_key" ON "text_normalizations"("runId");

-- CreateIndex
CREATE INDEX "text_normalizations_cardId_createdAt_idx" ON "text_normalizations"("cardId", "createdAt");

-- CreateIndex
CREATE INDEX "text_normalizations_roundId_createdAt_idx" ON "text_normalizations"("roundId", "createdAt");

-- CreateIndex
CREATE INDEX "text_normalizations_commentId_createdAt_idx" ON "text_normalizations"("commentId", "createdAt");

-- CreateIndex
CREATE INDEX "text_normalizations_planId_createdAt_idx" ON "text_normalizations"("planId", "createdAt");

-- CreateIndex
CREATE INDEX "text_normalizations_taskId_createdAt_idx" ON "text_normalizations"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "text_normalizations_turnId_createdAt_idx" ON "text_normalizations"("turnId", "createdAt");

-- CreateIndex
CREATE INDEX "text_normalizations_projectId_status_idx" ON "text_normalizations"("projectId", "status");

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "board_card_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "design_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "plan_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "plan_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_normalizations" ADD CONSTRAINT "text_normalizations_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_settings" ADD CONSTRAINT "text_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_settings" ADD CONSTRAINT "text_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
