-- CreateEnum
CREATE TYPE "BudgetScope" AS ENUM ('project', 'user');

-- CreateEnum
CREATE TYPE "BudgetPeriod" AS ENUM ('day', 'week', 'month');

-- CreateEnum
CREATE TYPE "BudgetAction" AS ENUM ('alert', 'stop');

-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "scope" "BudgetScope" NOT NULL,
    "projectId" TEXT,
    "userId" TEXT,
    "period" "BudgetPeriod" NOT NULL,
    "timezone" TEXT NOT NULL,
    "limitUsd" DECIMAL(14,4) NOT NULL,
    "thresholds" INTEGER[],
    "action" "BudgetAction" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id"),
    -- Spec 28 D1: exactly one owner, matching the scope.
    CONSTRAINT "budgets_scope_check" CHECK (
        ("scope" = 'project' AND "projectId" IS NOT NULL AND "userId" IS NULL)
        OR ("scope" = 'user' AND "userId" IS NOT NULL AND "projectId" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "budget_periods" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "start" TIMESTAMPTZ(3) NOT NULL,
    "end" TIMESTAMPTZ(3) NOT NULL,
    "spentUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "unpricedRequests" INTEGER NOT NULL DEFAULT 0,
    "firedThresholds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "exceededAt" TIMESTAMPTZ(3),
    "reconciledAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "budget_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_overrides" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "until" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "byId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" TEXT,

    CONSTRAINT "budget_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "budgets_projectId_idx" ON "budgets"("projectId");

-- CreateIndex
CREATE INDEX "budgets_userId_idx" ON "budgets"("userId");

-- Spec 28 D1: at most one enabled budget per (scope, owner, period). The owner
-- columns are coalesced because Postgres treats NULLs as distinct.
CREATE UNIQUE INDEX "budgets_enabled_key" ON "budgets"(
    "scope", COALESCE("projectId", ''), COALESCE("userId", ''), "period")
    WHERE "enabled";

-- CreateIndex
CREATE UNIQUE INDEX "budget_periods_budgetId_start_key" ON "budget_periods"("budgetId", "start");

-- CreateIndex
CREATE INDEX "budget_overrides_budgetId_periodStart_idx" ON "budget_overrides"("budgetId", "periodStart");

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_periods" ADD CONSTRAINT "budget_periods_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_overrides" ADD CONSTRAINT "budget_overrides_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_overrides" ADD CONSTRAINT "budget_overrides_byId_fkey" FOREIGN KEY ("byId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_overrides" ADD CONSTRAINT "budget_overrides_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
