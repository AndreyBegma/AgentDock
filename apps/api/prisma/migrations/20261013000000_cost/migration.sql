-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('langfuse-seed', 'admin');

-- CreateEnum
CREATE TYPE "LlmRequestSource" AS ENUM ('transcript', 'otel');

-- CreateEnum
CREATE TYPE "RecomputeStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- AlterTable
ALTER TABLE "llm_requests" ADD COLUMN     "cacheWriteTtlUnknown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reportedCostUsd" DECIMAL(14,6),
ADD COLUMN     "source" "LlmRequestSource" NOT NULL DEFAULT 'transcript';

-- CreateTable
CREATE TABLE "price_versions" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "source" "PriceSource" NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_prices" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "matchPattern" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "tiers" JSONB NOT NULL,

    CONSTRAINT "model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_rollups" (
    "id" TEXT NOT NULL,
    "hour" TIMESTAMPTZ(3) NOT NULL,
    "dimensionKey" TEXT NOT NULL,
    "projectId" TEXT,
    "runtime" "Runtime" NOT NULL,
    "model" TEXT NOT NULL,
    "slot" TEXT,
    "runId" TEXT,
    "issue" INTEGER,
    "requests" INTEGER NOT NULL,
    "input" BIGINT NOT NULL,
    "output" BIGINT NOT NULL,
    "cacheRead" BIGINT NOT NULL,
    "cacheWrite5m" BIGINT NOT NULL,
    "cacheWrite1h" BIGINT NOT NULL,
    "reasoning" BIGINT NOT NULL,
    "costUsd" DECIMAL(14,6) NOT NULL,
    "unpricedRequests" INTEGER NOT NULL,

    CONSTRAINT "usage_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_recomputes" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3) NOT NULL,
    "status" "RecomputeStatus" NOT NULL DEFAULT 'queued',
    "processed" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "price_recomputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_versions_number_key" ON "price_versions"("number");

-- CreateIndex
CREATE UNIQUE INDEX "model_prices_versionId_modelName_key" ON "model_prices"("versionId", "modelName");

-- CreateIndex
CREATE INDEX "usage_rollups_projectId_hour_idx" ON "usage_rollups"("projectId", "hour");

-- CreateIndex
CREATE INDEX "usage_rollups_hour_idx" ON "usage_rollups"("hour");

-- CreateIndex
CREATE UNIQUE INDEX "usage_rollups_hour_dimensionKey_key" ON "usage_rollups"("hour", "dimensionKey");

-- CreateIndex
CREATE INDEX "price_recomputes_status_idx" ON "price_recomputes"("status");

-- AddForeignKey
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "price_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_recomputes" ADD CONSTRAINT "price_recomputes_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "price_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_recomputes" ADD CONSTRAINT "price_recomputes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
