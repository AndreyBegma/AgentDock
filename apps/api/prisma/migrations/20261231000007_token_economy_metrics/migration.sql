-- #746 (ADR-0074): per-run usage facts, per-card A/B arms per technique.

-- CreateEnum
CREATE TYPE "TechniqueMode" AS ENUM ('off', 'ab', 'on');

-- CreateEnum
CREATE TYPE "TechniqueArm" AS ENUM ('a', 'b');

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "retries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "techniques" JSONB;

-- CreateTable
CREATE TABLE "token_economy_settings" (
    "projectId" TEXT NOT NULL,
    "bSharePercent" INTEGER NOT NULL DEFAULT 50,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_economy_settings_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "token_economy_techniques" (
    "projectId" TEXT NOT NULL,
    "technique" TEXT NOT NULL,
    "mode" "TechniqueMode" NOT NULL,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_economy_techniques_pkey" PRIMARY KEY ("projectId","technique")
);

-- CreateTable
CREATE TABLE "card_technique_arms" (
    "cardId" TEXT NOT NULL,
    "technique" TEXT NOT NULL,
    "arm" "TechniqueArm" NOT NULL,
    "mode" "TechniqueMode" NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_technique_arms_pkey" PRIMARY KEY ("cardId","technique")
);

-- CreateTable
CREATE TABLE "run_usage_facts" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "sessionId" TEXT,
    "projectId" TEXT NOT NULL,
    "input" BIGINT NOT NULL,
    "output" BIGINT NOT NULL,
    "cacheRead" BIGINT NOT NULL,
    "cacheWrite5m" BIGINT NOT NULL,
    "cacheWrite1h" BIGINT NOT NULL,
    "costUsd" DECIMAL(14,6),
    "unpricedRequests" INTEGER NOT NULL,
    "compactions" INTEGER NOT NULL,
    "peakContext" INTEGER NOT NULL,
    "turns" INTEGER NOT NULL,
    "subagentCostUsd" DECIMAL(14,6),
    "builtAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_usage_facts_pkey" PRIMARY KEY ("id"),
    -- A fact is of a run or of a manual session, never both or neither.
    CONSTRAINT "run_usage_facts_one_owner" CHECK (("runId" IS NULL) <> ("sessionId" IS NULL))
);

-- CreateIndex
CREATE INDEX "card_technique_arms_technique_arm_idx" ON "card_technique_arms"("technique", "arm");

-- CreateIndex
CREATE UNIQUE INDEX "run_usage_facts_runId_key" ON "run_usage_facts"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "run_usage_facts_sessionId_key" ON "run_usage_facts"("sessionId");

-- CreateIndex
CREATE INDEX "run_usage_facts_projectId_builtAt_idx" ON "run_usage_facts"("projectId", "builtAt");

-- AddForeignKey
ALTER TABLE "token_economy_settings" ADD CONSTRAINT "token_economy_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_economy_settings" ADD CONSTRAINT "token_economy_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_economy_techniques" ADD CONSTRAINT "token_economy_techniques_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_economy_techniques" ADD CONSTRAINT "token_economy_techniques_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_technique_arms" ADD CONSTRAINT "card_technique_arms_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "board_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_usage_facts" ADD CONSTRAINT "run_usage_facts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_usage_facts" ADD CONSTRAINT "run_usage_facts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_usage_facts" ADD CONSTRAINT "run_usage_facts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
